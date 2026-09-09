import { spawn } from "node:child_process";
import { GusError } from "../errors.js";
import type { RepositoryCommandOptions } from "../review/review-ports.js";

export interface GitCommandOptions extends RepositoryCommandOptions {
  maxBytes?: number;
  allowedExitCodes?: number[];
  authentication?: { origin: string; token: string };
}

export interface GitOutput {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface GitStore {
  directory: string;
  command(
    argumentsList: string[],
    options?: GitCommandOptions,
  ): Promise<GitOutput>;
}

const gitSettings = [
  "core.hooksPath=/dev/null",
  "core.attributesFile=/dev/null",
  "core.pager=cat",
  "core.quotePath=false",
  "credential.helper=",
  "protocol.file.allow=never",
  "protocol.ext.allow=never",
  "protocol.ssh.allow=never",
  "http.followRedirects=false",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
  "merge.renormalize=false",
  "diff.renameLimit=1000",
  "gc.auto=0",
  "maintenance.auto=false",
  "fetch.writeCommitGraph=false",
  "core.fsmonitor=false",
];

/** Runs only fixed Git plumbing operations in Gus's isolated object store. */
export function createGitStore(
  directory: string,
  signal?: AbortSignal,
): GitStore {
  return {
    directory,
    command: (argumentsList, options = {}) =>
      runGit(directory, argumentsList, signal, options),
  };
}

function runGit(
  directory: string,
  argumentsList: string[],
  sessionSignal: AbortSignal | undefined,
  options: GitCommandOptions,
): Promise<GitOutput> {
  const signals = [sessionSignal, options.signal].filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  const signal = AbortSignal.any(signals);
  if (signal.aborted) {
    return Promise.reject(
      new GusError("ABORTED", "Repository operation cancelled."),
    );
  }
  const remaining = (options.deadline ?? Date.now() + 60000) - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new GusError("BUDGET_EXCEEDED", "Repository operation deadline reached."),
    );
  }
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [...gitSettings.flatMap((setting) => ["-c", setting]), ...argumentsList],
      {
        cwd: directory,
        env: gitEnvironment(directory, options.authentication),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let byteCount = 0;
    let failure: GusError | undefined;
    const terminate = (error: GusError) => {
      failure ??= error;
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () =>
      terminate(new GusError("ABORTED", "Repository operation cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        terminate(
          new GusError(
            "BUDGET_EXCEEDED",
            "Git operation exceeded its deadline.",
          ),
        ),
      Math.min(60000, remaining),
    );
    const append = (chunks: Buffer[], chunk: Buffer) => {
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) {
        terminate(
          new GusError(
            "BUDGET_EXCEEDED",
            `Git output exceeded ${maxBytes} bytes; no partial source was returned.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => {
      failure = new GusError("GIT_FAILED", "Could not start Git.", {
        cause: error,
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure !== undefined) return reject(failure);
      const errorText = redact(
        Buffer.concat(stderr).toString("utf8"),
        options.authentication,
      );
      if (
        exitCode === null ||
        !(options.allowedExitCodes ?? [0]).includes(exitCode)
      ) {
        return reject(
          new GusError(
            "GIT_FAILED",
            `Git ${argumentsList[0] ?? "operation"} failed: ${errorText.slice(0, 2000)}`,
          ),
        );
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: errorText, exitCode });
    });
    if (signal.aborted) abort();
  });
}

function gitEnvironment(
  directory: string,
  authentication: GitCommandOptions["authentication"],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    TMPDIR: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
  if (process.env.SystemRoot !== undefined)
    environment.SystemRoot = process.env.SystemRoot;
  if (authentication !== undefined) {
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = `http.${authentication.origin}/.extraheader`;
    environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${authentication.token}`).toString("base64")}`;
  }
  return environment;
}

function redact(
  value: string,
  authentication: GitCommandOptions["authentication"],
): string {
  if (authentication === undefined) return value;
  return value
    .replaceAll(authentication.token, "[redacted]")
    .replaceAll(
      Buffer.from(`x-access-token:${authentication.token}`).toString("base64"),
      "[redacted]",
    );
}
