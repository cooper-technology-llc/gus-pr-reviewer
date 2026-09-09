// Setup consumes the same deadline as model work; loading configuration must not restart it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewDeadline } from "./review-deadline.js";

afterEach(() => vi.useRealTimers());

describe("application review deadline", () => {
  it("charges setup time against the duration loaded from repository configuration", () => {
    vi.useFakeTimers();
    const deadline = createReviewDeadline(10_000);
    vi.advanceTimersByTime(2_000);
    deadline.setDuration(3_000);
    vi.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal.reason).toEqual(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
    deadline.dispose();
  });

  it("stops immediately when setup has already exhausted the configured budget", () => {
    vi.useFakeTimers();
    const deadline = createReviewDeadline(10_000);
    vi.advanceTimersByTime(2_000);
    expect(() => deadline.setDuration(1_000)).toThrowError(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
    deadline.dispose();
  });

  it("preserves caller cancellation and releases its timer after completion", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const deadline = createReviewDeadline(10_000, caller.signal);
    const reason = new Error("Caller stopped the review");
    caller.abort(reason);
    expect(deadline.signal.reason).toBe(reason);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
