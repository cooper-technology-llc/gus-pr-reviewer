import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { GusError } from "../errors.js";
import type { GitHubClientOptions } from "./github-port.js";

const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubRequestError extends GusError {
  constructor(
    readonly status: number | null,
    readonly outcomeUnknown: boolean,
  ) {
    super(
      "GITHUB_ERROR",
      status === null
        ? "GitHub request did not return a confirmed response."
        : `GitHub request failed with HTTP ${status}.`,
    );
  }
}

export interface GitHubTransport {
  request<T>(
    method: "GET" | "POST",
    route: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T>;
  paginate<T>(route: string, schema: z.ZodType<T>): Promise<T[]>;
  graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T>;
}

export function createGitHubTransport(
  options: GitHubClientOptions,
): GitHubTransport {
  const api = parseApiUrl(options.apiUrl ?? "https://api.github.com");
  const graphqlUrl = new URL(api.href);
  graphqlUrl.pathname =
    api.hostname === "api.github.com"
      ? "/graphql"
      : api.pathname.replace(/\/api\/v3\/?$/, "/api/graphql");
  if (graphqlUrl.pathname === api.pathname)
    graphqlUrl.pathname = `${api.pathname.replace(/\/$/, "")}/graphql`;
  const requestFetch = options.fetch ?? globalThis.fetch;

  async function send(
    method: "GET" | "POST",
    url: URL,
    body?: unknown,
  ): Promise<Response> {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await requestFetch(url, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
          redirect: "error",
        });
      } catch {
        if (signal.aborted)
          throw new GusError(
            "ABORTED",
            "GitHub request was cancelled or exceeded its deadline.",
          );
        if (method !== "GET" || attempt === 2)
          throw new GitHubRequestError(null, method === "POST");
        await delay(250 * (attempt + 1), undefined, { signal }).catch(() => {
          throw new GusError("ABORTED", "GitHub request was cancelled.");
        });
        continue;
      }
      if (response.ok) return response;
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0");
      if (method === "GET" && retryable && attempt < 2) {
        const retrySeconds = Number(response.headers.get("retry-after"));
        const waitMs =
          retrySeconds > 0
            ? Math.min(retrySeconds * 1000, 2000)
            : 250 * (attempt + 1);
        await response.body?.cancel().catch(() => undefined);
        await delay(waitMs, undefined, { signal }).catch(() => {
          throw new GusError("ABORTED", "GitHub request was cancelled.");
        });
        continue;
      }
      throw new GitHubRequestError(
        response.status,
        method === "POST" && response.status >= 500,
      );
    }
    throw new GitHubRequestError(null, method === "POST");
  }

  function routeUrl(route: string): URL {
    const url = new URL(
      `${api.href.replace(/\/$/, "")}/${route.replace(/^\//, "")}`,
    );
    if (url.origin !== api.origin)
      throw new GusError(
        "INPUT_INVALID",
        "GitHub request must use the configured API origin.",
      );
    return url;
  }

  async function parseResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GusError("GITHUB_ERROR", "GitHub returned invalid JSON.");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new GusError(
        "GITHUB_ERROR",
        "GitHub returned an unexpected response shape.",
      );
    return parsed.data;
  }

  return {
    async request<T>(
      method: "GET" | "POST",
      route: string,
      schema: z.ZodType<T>,
      body?: unknown,
    ): Promise<T> {
      return parseResponse(await send(method, routeUrl(route), body), schema);
    },
    async paginate<T>(route: string, schema: z.ZodType<T>): Promise<T[]> {
      const entries: T[] = [];
      const pageSchema = z.array(schema);
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = routeUrl(route);
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        const response = await send("GET", url);
        const pageEntries = await parseResponse(response, pageSchema);
        entries.push(...pageEntries);
        const link = response.headers.get("link");
        const hasNext =
          link === null
            ? pageEntries.length === 100
            : /;\s*rel="next"/.test(link);
        if (!hasNext) return entries;
      }
      throw new GusError(
        "GITHUB_ERROR",
        "GitHub pagination exceeded 50 pages; results are incomplete.",
      );
    },
    async graphql<T>(
      query: string,
      variables: Record<string, unknown>,
      schema: z.ZodType<T>,
    ): Promise<T> {
      return parseResponse(
        await send("POST", graphqlUrl, { query, variables }),
        schema,
      );
    },
  };
}

function parseApiUrl(value: string): URL {
  const parsed = z.url().safeParse(value);
  if (!parsed.success)
    throw new GusError("INPUT_INVALID", "GitHub API URL is invalid.");
  const url = new URL(parsed.data);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new GusError(
      "INPUT_INVALID",
      "GitHub API URL must not contain credentials, a query, or a fragment.",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new GusError(
      "INPUT_INVALID",
      "GitHub API requires HTTPS except for explicit loopback services.",
    );
  return url;
}
