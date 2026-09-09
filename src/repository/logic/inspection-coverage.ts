interface InspectionPage {
  path: string;
  snapshot: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

export interface InspectionCoverage {
  record(page: InspectionPage): boolean;
}

/** Marks a path complete only after one immutable source or diff has been delivered without gaps. */
export function createInspectionCoverage(): InspectionCoverage {
  const inspected = new Map<
    string,
    { totalLines: number; ranges: LineRange[] }
  >();
  return {
    record: (page) => {
      if (page.totalLines === 0)
        return (
          page.endLine === 0 && (page.startLine === 0 || page.startLine === 1)
        );
      if (
        page.startLine < 1 ||
        page.endLine < page.startLine ||
        page.endLine > page.totalLines
      )
        return false;
      const key = JSON.stringify([page.path, page.snapshot]);
      const previous = inspected.get(key);
      if (previous !== undefined && previous.totalLines !== page.totalLines)
        return false;
      const ranges = [
        ...(previous?.ranges ?? []),
        { startLine: page.startLine, endLine: page.endLine },
      ].sort((first, second) => first.startLine - second.startLine);
      const merged: LineRange[] = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last !== undefined && range.startLine <= last.endLine + 1)
          last.endLine = Math.max(last.endLine, range.endLine);
        else merged.push({ ...range });
      }
      inspected.set(key, { totalLines: page.totalLines, ranges: merged });
      const first = merged[0];
      return (
        merged.length === 1 &&
        first?.startLine === 1 &&
        first.endLine === page.totalLines
      );
    },
  };
}
