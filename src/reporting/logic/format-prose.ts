// Model prose is already Markdown. It is rendered as written, with four
// repairs so one field cannot break the surrounding comment:
//   1. HTML comments are removed (they could forge or hide Gus's state comment),
//   2. heading lines become bold text (a finding body cannot outrank its title),
//   3. an unclosed code fence is closed (it would swallow everything after it),
//   4. @mentions outside code are defused (a review must not ping anyone).
// Backticks, angle brackets, pipes and underscores are left alone.

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/;
const INLINE_CODE_PATTERN = /(`+)[\s\S]*?\1/g;
const MENTION_PATTERN = /(^|[^\w`])@(?=[A-Za-z0-9])/g;

/** Renders a multi-line prose field (trigger, impact, fix, summary). */
export function formatProse(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let proseLines: string[] = [];
  let openFence: string | null = null;

  const flushProse = () => {
    if (proseLines.length > 0) output.push(...repairProse(proseLines));
    proseLines = [];
  };

  for (const line of lines) {
    const fence = FENCE_PATTERN.exec(line)?.[1];
    if (openFence === null && fence !== undefined) {
      flushProse();
      openFence = fence;
      output.push(line);
    } else if (openFence !== null) {
      output.push(line);
      if (fence !== undefined && closesFence(fence, openFence))
        openFence = null;
    } else {
      proseLines.push(line);
    }
  }
  flushProse();
  if (openFence !== null) output.push(openFence);
  return output.join("\n").trim();
}

/** Renders prose that must stay on one line (titles, list items). */
export function formatInlineProse(text: string): string {
  return repairProse([text.replace(/\s+/g, " ").trim()])
    .join(" ")
    .trim();
}

function closesFence(fence: string, openFence: string): boolean {
  return fence[0] === openFence[0] && fence.length >= openFence.length;
}

function repairProse(lines: string[]): string[] {
  const withoutComments = lines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/, "");
  return withoutComments
    .split("\n")
    .map((line) => defuseMentions(demoteHeading(line)));
}

function demoteHeading(line: string): string {
  const heading = HEADING_PATTERN.exec(line)?.[1];
  if (heading === undefined) return line;
  return heading ? `**${heading}**` : "";
}

/** Inserts a zero-width space after @ outside inline code spans. */
function defuseMentions(line: string): string {
  let result = "";
  let cursor = 0;
  for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
    result += line
      .slice(cursor, match.index)
      .replace(MENTION_PATTERN, "$1@\u200b");
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + line.slice(cursor).replace(MENTION_PATTERN, "$1@\u200b");
}
