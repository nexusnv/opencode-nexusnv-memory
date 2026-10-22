/**
 * Shared Known-Errors block parser.
 *
 * Both the brief loader and the forget planner must agree on block
 * boundaries. A disagreement is a security bug: if forget removes only the
 * `source:tool` summary while the loader no longer recognises the orphaned
 * detail, raw tool output is promoted into the trusted context slice.
 *
 * Only a **column-0** heading is structural. Captured detail is stored
 * two-space indented, so tool output containing `  ## Known errors` must not
 * split the file or turn the lines before it into trusted context. A leading
 * UTF-8 BOM on the first line is ignored for structural detection.
 *
 * Inside a `## Known errors` region every column-0 bullet starts a block.
 * Outside it, only generated `source:tool` bullets do. Column-0 headings and
 * column-0 bullets end a block; whitespace-only lines (including the
 * two-space blank detail written by capture) stay inside a fallback block.
 */
const KNOWN_ERRORS_HEADING = /^##\s+known errors\s*$/i;
const BULLET_START = /^-\s+/;
const SECTION_HEADING = /^#{1,6}\s+/;
const TOOL_SUMMARY_LINE = /^-\s+.*\bsource:tool\s*$/i;
const BOM = "\uFEFF";

export interface KnownErrorBlock {
  /** First line index in the input array. */
  readonly start: number;
  /** Exclusive end line index in the input array. */
  readonly end: number;
  readonly lines: readonly string[];
}

export interface KnownErrorSections {
  /** Content outside every Known-errors block, blank lines removed. */
  readonly contextLines: string[];
  readonly blocks: readonly KnownErrorBlock[];
}

/** Structural view of one line: a first-line BOM is not indentation. */
function structuralLine(allLines: readonly string[], index: number): string {
  const line = allLines[index]!;
  return index === 0 && line.startsWith(BOM) ? line.slice(BOM.length) : line;
}

/**
 * The real `## Known errors` heading, or `-1`. Requires column 0 (a first
 * line may carry a UTF-8 BOM); indented lookalikes inside captured detail
 * are not headings.
 */
export function findKnownErrorsHeading(allLines: readonly string[]): number {
  return allLines.findIndex((_, index) =>
    KNOWN_ERRORS_HEADING.test(structuralLine(allLines, index)),
  );
}

function blockFor(
  allLines: readonly string[],
  start: number,
  end: number,
): KnownErrorBlock {
  return { start, end, lines: allLines.slice(start, end) };
}

function withoutBlankLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.trim().length > 0);
}

/**
 * Split `activeContext` lines into the trusted context slice and every
 * Known-errors block (summary plus every continuation/detail line). Pure,
 * never throws.
 */
export function splitKnownErrorSections(
  allLines: readonly string[],
): KnownErrorSections {
  const hasKnownErrorsHeading = findKnownErrorsHeading(allLines) !== -1;
  const contextLines: string[] = [];
  const blocks: KnownErrorBlock[] = [];
  let current: { start: number; end: number; inRegion: boolean } | undefined;
  let inKnownErrorsRegion = false;

  const closeBlock = (): void => {
    if (!current) return;
    blocks.push(blockFor(allLines, current.start, current.end));
    current = undefined;
  };

  for (let i = 0; i < allLines.length; i += 1) {
    const line = structuralLine(allLines, i);
    if (SECTION_HEADING.test(line)) {
      closeBlock();
      inKnownErrorsRegion = KNOWN_ERRORS_HEADING.test(line);
      // The structural heading itself is never context; later sections are.
      if (!inKnownErrorsRegion) contextLines.push(allLines[i]!);
      continue;
    }

    if (BULLET_START.test(line)) {
      if (inKnownErrorsRegion || TOOL_SUMMARY_LINE.test(line)) {
        closeBlock();
        current = { start: i, end: i + 1, inRegion: inKnownErrorsRegion };
      } else {
        closeBlock();
        contextLines.push(allLines[i]!);
      }
      continue;
    }

    if (current) {
      // A heading-region block keeps blank padding. A fallback source:tool
      // block ends only at a truly empty column-0 line: capture writes a
      // blank detail line as two spaces, which is still block content.
      if (!current.inRegion && (line.length === 0 || line === "\r")) {
        closeBlock();
        contextLines.push(allLines[i]!);
      } else {
        current.end = i + 1;
      }
      continue;
    }

    // Text between the heading and its first bullet is not trusted context.
    if (!inKnownErrorsRegion) contextLines.push(allLines[i]!);
  }
  closeBlock();

  // No recognised block: preserve the input exactly only when there was no
  // structural heading. A heading with no bullet must still hide its region.
  if (blocks.length === 0 && !hasKnownErrorsHeading) {
    return { contextLines: [...allLines], blocks: [] };
  }
  return { contextLines: withoutBlankLines(contextLines), blocks };
}

/** Block ranges for `allLines`, including orphaned/no-heading blocks. */
export function knownErrorBlockRanges(
  allLines: readonly string[],
): Array<{ readonly start: number; readonly end: number }> {
  return splitKnownErrorSections(allLines).blocks.map(({ start, end }) => ({
    start,
    end,
  }));
}
