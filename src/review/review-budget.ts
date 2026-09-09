import { Buffer } from "node:buffer";
import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type {
  ModelCompletion,
  ModelMessage,
  ModelTool,
} from "./review-ports.js";
import type {
  ReviewModelCallContext,
  ReviewModelCallUsage,
  ReviewUsage,
} from "./review-schema.js";

interface PendingModelCall {
  startedAt: number;
  allowedToolNames: Set<string>;
  usage: ReviewModelCallUsage;
}

export class ReviewBudget {
  readonly deadline: number;
  private readonly startedAt: number;
  private turns = 0;
  private toolCalls = 0;
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private costKnown = true;
  private tokensKnown = true;
  private readonly models = new Set<string>();
  private readonly calls: ReviewModelCallUsage[] = [];
  private pendingCall: PendingModelCall | null = null;

  constructor(
    private readonly config: GusConfig,
    private readonly now: () => number,
    private readonly signal?: AbortSignal,
  ) {
    this.startedAt = now();
    this.deadline = this.startedAt + config.review.maxDurationMs;
  }

  beginModel(
    messages: ModelMessage[],
    tools: ModelTool[],
    requestedOutput: number,
    context?: ReviewModelCallContext,
  ): number {
    this.requireTime();
    if (this.turns >= this.config.review.maxTurns)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The model turn limit was reached before all required review stages completed.",
      );
    const serialized = JSON.stringify({ messages, tools });
    if (serialized.length > this.config.review.maxInputChars) {
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The review context exceeds maxInputChars; context was not silently discarded. Increase the limit or narrow the change.",
      );
    }
    if (
      this.config.review.maxCostUsd !== null &&
      this.costUsd >= this.config.review.maxCostUsd
    ) {
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The configured provider cost stop threshold was reached.",
      );
    }
    const remainingTokens =
      this.config.review.maxTotalTokens - this.inputTokens - this.outputTokens;
    const inputReservation =
      Buffer.byteLength(serialized, "utf8") + messages.length * 16 + 256;
    const outputLimit = Math.min(
      requestedOutput,
      remainingTokens - inputReservation,
    );
    if (outputLimit <= 0)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The remaining token budget cannot accommodate this request and its input reservation.",
      );
    this.turns += 1;
    this.requests += 1;
    this.pendingCall = context
      ? {
          startedAt: this.now(),
          allowedToolNames: new Set(tools.map((tool) => tool.name)),
          usage: {
            stage: context.stage,
            model: context.model,
            trigger: context.trigger,
            policyChars: context.policyChars,
            turn: this.turns,
            inputChars: serialized.length,
            systemChars: messages.reduce(
              (total, message) =>
                total +
                (message.role === "system" ? message.content.length : 0),
              0,
            ),
            seedChars:
              messages.find((message) => message.role === "user")?.content
                .length ?? 0,
            toolResultChars: messages.reduce(
              (total, message) =>
                total + (message.role === "tool" ? message.content.length : 0),
              0,
            ),
            toolDefinitionChars: JSON.stringify(tools).length,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            attempts: 1,
            elapsedMs: 0,
            status: "failed",
            toolNames: [],
          },
        }
      : null;
    return outputLimit;
  }

  recordCompletion(completion: ModelCompletion): void {
    this.finishModelCall(
      Math.max(1, completion.requestAttempts ?? 1),
      completion,
    );
    this.requests += Math.max(0, (completion.requestAttempts ?? 1) - 1);
    this.models.add(completion.model);
    if (completion.usageAvailable === false) {
      this.tokensKnown = false;
      this.costKnown = false;
    }
    if (
      !validCount(completion.inputTokens) ||
      !validCount(completion.outputTokens)
    )
      this.tokensKnown = false;
    if (validCount(completion.inputTokens))
      this.inputTokens += completion.inputTokens;
    if (validCount(completion.outputTokens))
      this.outputTokens += completion.outputTokens;
    if (
      completion.costUsd === null ||
      !Number.isFinite(completion.costUsd) ||
      completion.costUsd < 0
    ) {
      this.costKnown = false;
    } else {
      this.costUsd += completion.costUsd;
    }
    if (!this.tokensKnown)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "Provider token usage was unavailable; the total-token limit cannot be verified and the review stopped.",
      );
    if (
      this.inputTokens + this.outputTokens >
      this.config.review.maxTotalTokens
    )
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The provider reported usage beyond the review token limit.",
      );
    if (this.config.review.maxCostUsd !== null && !this.costKnown)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "Provider cost was unavailable; the configured cost stop threshold cannot be enforced.",
      );
    if (
      this.config.review.maxCostUsd !== null &&
      this.costUsd > this.config.review.maxCostUsd
    )
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The last provider request crossed the configured cost stop threshold.",
      );
    this.requireTime();
  }

  recordModelFailure(error: unknown): void {
    let attempts = 1;
    if (
      typeof error === "object" &&
      error !== null &&
      "requestAttempts" in error &&
      validCount(error.requestAttempts)
    ) {
      attempts = error.requestAttempts;
      this.requests += error.requestAttempts - 1;
    }
    this.finishModelCall(attempts);
    this.tokensKnown = false;
    this.costKnown = false;
  }

  beginTool(): void {
    this.requireTime();
    if (this.toolCalls >= this.config.review.maxToolCalls)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The repository tool call limit was reached.",
      );
    this.toolCalls += 1;
  }

  async withinDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requireTime();
    const controller = new AbortController();
    const signal = this.signal
      ? AbortSignal.any([this.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, this.deadline - this.now()),
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        const abort = () =>
          reject(
            new GusError(
              this.signal?.aborted ? "ABORTED" : "BUDGET_EXCEEDED",
              this.signal?.aborted
                ? "The review was cancelled."
                : "The review deadline was reached.",
            ),
          );
        signal.addEventListener("abort", abort, { once: true });
        const pending = operation(signal);
        pending
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    } finally {
      clearTimeout(timer);
    }
  }

  usage(): ReviewUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd:
        this.costKnown && this.requests > 0
          ? Number(this.costUsd.toFixed(8))
          : null,
      requests: this.requests,
      toolCalls: this.toolCalls,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      models: [...this.models],
      usageComplete: this.tokensKnown && this.costKnown,
      calls: this.calls.map((call) => ({
        ...call,
        toolNames: [...call.toolNames],
      })),
    };
  }

  private finishModelCall(
    attempts: number,
    completion?: ModelCompletion,
  ): void {
    const pending = this.pendingCall;
    this.pendingCall = null;
    if (!pending) return;
    const call = pending.usage;
    call.attempts = attempts;
    call.elapsedMs = Math.max(0, this.now() - pending.startedAt);
    if (completion) {
      call.model = completion.model;
      call.status = "completed";
      const usageAvailable = completion.usageAvailable !== false;
      call.inputTokens =
        usageAvailable && validCount(completion.inputTokens)
          ? completion.inputTokens
          : null;
      call.outputTokens =
        usageAvailable && validCount(completion.outputTokens)
          ? completion.outputTokens
          : null;
      call.costUsd =
        usageAvailable &&
        completion.costUsd !== null &&
        Number.isFinite(completion.costUsd) &&
        completion.costUsd >= 0
          ? completion.costUsd
          : null;
      call.toolNames = completion.toolCalls.map((tool) =>
        pending.allowedToolNames.has(tool.name) ? tool.name : "unsupported",
      );
    }
    this.calls.push(call);
  }

  private requireTime(): void {
    if (this.signal?.aborted)
      throw new GusError("ABORTED", "The review was cancelled.");
    if (this.now() >= this.deadline)
      throw new GusError("BUDGET_EXCEEDED", "The review deadline was reached.");
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
