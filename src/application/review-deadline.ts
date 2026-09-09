import { GusError } from "../errors.js";

/** One deadline covers setup, review, and publication from the application entrypoint. */
export function createReviewDeadline(
  durationMs: number,
  parentSignal?: AbortSignal,
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function setDuration(nextDurationMs: number): void {
    clearTimeout(timer);
    signal.throwIfAborted();
    const remaining = startedAt + nextDurationMs - Date.now();
    const expire = () =>
      controller.abort(
        new GusError("BUDGET_EXCEEDED", "The review deadline was reached."),
      );
    if (remaining <= 0) expire();
    else {
      timer = setTimeout(expire, remaining);
      timer.unref();
    }
    signal.throwIfAborted();
  }

  setDuration(durationMs);
  return { signal, setDuration, dispose: () => clearTimeout(timer) };
}
