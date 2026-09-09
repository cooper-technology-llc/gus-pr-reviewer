import type { FileRead } from "../../review/review-ports.js";

/** Shrinks source pages by whole lines until their actual delivery envelope fits. */
export function fitSourcePages(
  files: FileRead[],
  fits: (pages: FileRead[]) => boolean,
): FileRead[] | null {
  const pages = files.map((file) => ({ ...file }));
  while (!fits(pages)) {
    let longestIndex = -1;
    let longestLength = -1;
    for (const [index, page] of pages.entries()) {
      if (page.endLine > page.startLine && page.text.length > longestLength) {
        longestIndex = index;
        longestLength = page.text.length;
      }
    }
    const page = pages[longestIndex];
    if (page === undefined) return null;
    const lines = page.text.split("\n");
    const retained = lines.slice(0, Math.max(1, Math.floor(lines.length / 2)));
    pages[longestIndex] = {
      ...page,
      text: retained.join("\n"),
      endLine: page.startLine + retained.length - 1,
      truncated: true,
    };
  }
  return pages;
}
