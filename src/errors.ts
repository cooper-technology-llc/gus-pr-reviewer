export type GusErrorCode =
  | "CONFIG_INVALID"
  | "INPUT_INVALID"
  | "GIT_FAILED"
  | "SNAPSHOT_UNAVAILABLE"
  | "PATH_DENIED"
  | "FILE_NOT_FOUND"
  | "PROVIDER_ERROR"
  | "PROVIDER_PROTOCOL"
  | "GITHUB_ERROR"
  | "STALE_REVIEW"
  | "BUDGET_EXCEEDED"
  | "PUBLICATION_FAILED"
  | "COMMAND_FAILED"
  | "ABORTED";

/** A stable error code for CLI users and library consumers. */
export class GusError extends Error {
  constructor(
    readonly code: GusErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GusError";
  }
}
