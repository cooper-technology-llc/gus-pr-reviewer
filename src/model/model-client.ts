import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type {
  ModelClient,
  ModelCompletion,
  ModelRequest,
} from "../review/review-ports.js";
import {
  buildProviderRequest,
  parseProviderCompletion,
} from "./model-protocol.js";

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

class ProviderAttemptError extends GusError {
  constructor(
    code:
      "PROVIDER_ERROR" | "PROVIDER_PROTOCOL" | "BUDGET_EXCEEDED" | "ABORTED",
    message: string,
    readonly requestAttempts: number,
  ) {
    super(code, message);
  }
}

/** Sends bounded, schema-checked requests without exposing credentials or response bodies in errors. */
export function createModelClient(
  config: GusConfig,
  options: {
    apiKey: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  },
): ModelClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const endpoint = providerEndpoint(config.provider.baseUrl);

  return {
    async complete(request: ModelRequest): Promise<ModelCompletion> {
      const serialized = JSON.stringify(buildProviderRequest(request, config));
      const maxAttempts = config.provider.retries + 1;
      let usageUncertain = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        checkRequestDeadline(request, now(), attempt - 1);
        const controller = new AbortController();
        const timeoutMs = Math.min(
          config.provider.requestTimeoutMs,
          request.deadline - now(),
        );
        const timeout = setTimeout(
          () => controller.abort(),
          Math.max(1, timeoutMs),
        );
        const signal = request.signal
          ? AbortSignal.any([request.signal, controller.signal])
          : controller.signal;
        let retry = false;
        try {
          const response = await waitForRequest(
            fetcher(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                "Content-Type": "application/json",
              },
              body: serialized,
              signal,
              redirect: "error",
            }),
            signal,
            attempt,
          );
          if (!response.ok) {
            await response.body?.cancel();
            if (
              retryableStatuses.has(response.status) &&
              attempt < maxAttempts
            ) {
              retry = true;
            } else {
              throw new ProviderAttemptError(
                "PROVIDER_ERROR",
                `The provider returned HTTP ${response.status}.`,
                attempt,
              );
            }
          } else {
            const raw = await readProviderBody(
              response,
              signal,
              attempt,
              config.review.maxOutputTokens,
            );
            const completion = parseProviderCompletion(
              raw,
              request.model,
              attempt,
            );
            return {
              ...completion,
              usageAvailable:
                completion.usageAvailable !== false && !usageUncertain,
            };
          }
        } catch (error) {
          if (request.signal?.aborted)
            throw new ProviderAttemptError(
              "ABORTED",
              "The review was cancelled.",
              attempt,
            );
          if (now() >= request.deadline)
            throw new ProviderAttemptError(
              "BUDGET_EXCEEDED",
              "The provider request exceeded the review deadline.",
              attempt,
            );
          if (error instanceof GusError && error.code === "PROVIDER_PROTOCOL") {
            throw new ProviderAttemptError(error.code, error.message, attempt);
          }
          if (
            error instanceof ProviderAttemptError &&
            error.code === "PROVIDER_ERROR"
          )
            throw error;
          if (attempt >= maxAttempts)
            throw new ProviderAttemptError(
              "PROVIDER_ERROR",
              "The provider request failed after bounded retries.",
              attempt,
            );
          usageUncertain = true;
          retry = true;
        } finally {
          clearTimeout(timeout);
        }
        if (retry)
          await pauseBeforeRetry(
            Math.min(100 * 2 ** (attempt - 1), 1000),
            request,
            now,
            attempt,
          );
      }
      throw new ProviderAttemptError(
        "PROVIDER_ERROR",
        "The provider request did not complete.",
        maxAttempts,
      );
    },
  };
}

function providerEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new GusError(
      "CONFIG_INVALID",
      "Provider URLs require HTTPS or explicit loopback HTTP and must not contain credentials.",
    );
  }
  if (url.search || url.hash)
    throw new GusError(
      "CONFIG_INVALID",
      "Provider base URLs cannot contain a query or fragment.",
    );
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function checkRequestDeadline(
  request: ModelRequest,
  now: number,
  attempts: number,
): void {
  if (request.signal?.aborted)
    throw new ProviderAttemptError(
      "ABORTED",
      "The review was cancelled.",
      attempts,
    );
  if (now >= request.deadline)
    throw new ProviderAttemptError(
      "BUDGET_EXCEEDED",
      "The review deadline was reached before the provider request.",
      attempts,
    );
}

async function readProviderBody(
  response: Response,
  signal: AbortSignal,
  attempts: number,
  maxTokens: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ProviderAttemptError(
      "PROVIDER_PROTOCOL",
      "The provider response body was empty.",
      attempts,
    );
  const maximumBytes = Math.max(65536, maxTokens * 24);
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await waitForRequest(reader.read(), signal, attempts);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes)
        throw new ProviderAttemptError(
          "PROVIDER_PROTOCOL",
          "The provider response exceeded the response size limit.",
          attempts,
        );
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    try {
      return JSON.parse(body);
    } catch {
      throw new ProviderAttemptError(
        "PROVIDER_PROTOCOL",
        "The provider response was not valid JSON.",
        attempts,
      );
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function waitForRequest<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  attempts: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(
        new ProviderAttemptError(
          "ABORTED",
          "The provider request was interrupted.",
          attempts,
        ),
      );
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function pauseBeforeRetry(
  durationMs: number,
  request: ModelRequest,
  now: () => number,
  attempts: number,
): Promise<void> {
  checkRequestDeadline(request, now(), attempts);
  const remaining = request.deadline - now();
  if (remaining <= durationMs)
    throw new ProviderAttemptError(
      "BUDGET_EXCEEDED",
      "There is no review time remaining for another provider attempt.",
      attempts,
    );
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(
        new ProviderAttemptError(
          "ABORTED",
          "The review was cancelled.",
          attempts,
        ),
      );
    };
    const timer = setTimeout(() => {
      request.signal?.removeEventListener("abort", aborted);
      resolve();
    }, durationMs);
    request.signal?.addEventListener("abort", aborted, { once: true });
    if (request.signal?.aborted) aborted();
  });
}
