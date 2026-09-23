import type { ReviewSubject } from "../../review/review-ports.js";

/** Escapes model or user text so it renders literally and cannot mention anyone. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@​")
    .replace(/([\\`*_[\]])/g, "\\$1");
}

export function escapeCode(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]/g, " ");
}

/** Accepts only credential-free http(s) URLs; anything else renders as "#". */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")
      : "#";
  } catch {
    return "#";
  }
}

/** A fence one backtick longer than any backtick run inside the text, so the text cannot close it. */
export function fencedBlock(text: string): string {
  const longestRun = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text.replace(/\s+$/, "")}\n${fence}`;
}

/** Permalink to a line range at a pinned commit, or null when the subject has no web URL. */
export function blobUrl(
  subject: ReviewSubject | undefined,
  sha: string,
  path: string,
  startLine: number,
  endLine: number = startLine,
): string | null {
  if (!subject?.url || !subject.repository || !sha) return null;
  try {
    const origin = new URL(subject.url).origin;
    const filePath = path.split("/").map(encodeURIComponent).join("/");
    const range =
      endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
    return `${origin}/${subject.repository}/blob/${encodeURIComponent(sha)}/${filePath}${range}`;
  } catch {
    return null;
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
