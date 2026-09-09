import { minimatch } from "minimatch";
import { GusError } from "../errors.js";

const secretNames =
  /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.(?:json|ya?ml|toml|ini|xml))?|secrets?\.json|service[-_]account[^/]*\.json)$/i;
const secretExtensions = /\.(?:key|pem|p12|pfx|jks|keystore)$/i;

/** Rejects traversal, Git metadata, and common secret material before any blob read. */
export function assertReadablePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new GusError(
      "PATH_DENIED",
      "Use a relative repository path without control characters.",
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new GusError(
      "PATH_DENIED",
      "Repository path traversal is not allowed.",
    );
  }
  for (const segment of segments) {
    const name = segment.toLowerCase();
    const environmentSecret =
      (name === ".env" || name.startsWith(".env.")) &&
      ![".env.example", ".env.sample", ".env.template"].includes(name);
    if (
      [".git", ".ssh", ".aws", ".azure", ".gnupg"].includes(name) ||
      environmentSecret ||
      secretNames.test(segment) ||
      secretExtensions.test(segment)
    ) {
      throw new GusError(
        "PATH_DENIED",
        `The repository path ${path} may contain credentials and is not available to the reviewer.`,
      );
    }
  }
}

export function isReadablePath(path: string): boolean {
  try {
    assertReadablePath(path);
    return true;
  } catch {
    return false;
  }
}

export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.length > 512)
    throw new GusError(
      "INPUT_INVALID",
      "File patterns cannot exceed 512 characters.",
    );
  return minimatch(path, pattern, {
    dot: true,
    nonegate: true,
    nocomment: true,
    nobrace: true,
  });
}

export function assertRevisionInput(value: string): void {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) ||
    value.length > 1024 ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/")
  ) {
    throw new GusError(
      "INPUT_INVALID",
      "A revision must be a commit SHA or an explicit branch/ref name; revision expressions are not accepted.",
    );
  }
}

export function isObjectId(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

export function decodeGitText(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    throw new GusError(
      "PATH_DENIED",
      "Git source or path metadata is not valid UTF-8; no substituted text was returned.",
    );
  }
}
