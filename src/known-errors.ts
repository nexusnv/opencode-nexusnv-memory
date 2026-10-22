/**
 * Shared Known-Errors block parser.
 *
 * Both the brief loader and the forget planner must agree on block
 * boundaries. A disagreement is a security bug: if forget removes only the
 * `source:tool` summary while the loader no longer recognises the orphaned
 * detail, raw tool output is promoted into the trusted context slice.
 *
 * With a `## Known errors` heading, blocks are the column-0 bullets under it.
 * Without a heading (older/hand-edited files), generated `source:tool`
 * summary bullets are still recognised as blocks. Column-0 headings and
 * column-0 bullets end a block; whitespace-only lines (including the
 * two-space blank detail written by capture) stay inside it.
 */
export const KNOWN_ERRORS_HEADING = /^##\s+known errors\s*$/i;
export const BULLET_START = /^-\s+/;
export const SECTION_HEADING = /^#{1,6}\s+/;
const TOOL_SUMMARY_LINE = /^-\s+.*\bsource:tool\s*$/i;

export interface KnownErrorBlock {
  /** First line index in the input array. */
  readonly start: number;
  /** Exclusive end line index in the input array. */
  readonly end: number;
  readonly lines: readonly string[];
}

export interface KnownErrorSections {
  /** Content outside the Known-errors region, blank lines removed. */
  readonly contextLines: string[];
  readonly blocks: readonly KnownErrorBlock[];
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
 * Split `activeContext` lines into the trusted context slice and the
 * Known-errors blocks (summary plus every continuation/detail line).
 * Pure, never throws.
 */
export function splitKnownErrorSections(
  allLines: readonly string[],
): KnownErrorSections {
  const headingIdx = allLines.findIndex((line) =>
    KNOWN_ERRORS_HEADING.test(line.trim()),
  );
  if (headingIdx === -1) {
    return splitWithoutHeading(allLines);
  }

  const contextLines = allLines.slice(0, headingIdx) as string[];
  const blocks: KnownErrorBlock[] = [];
  let current: { start: number; end: number } | undefined;
  let i = headingIdx + 1;
  for (; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    if (BULLET_START.test(line)) {
      if (current) blocks.push(blockFor(allLines, current.start, current.end));
      current = { start: i, end: i + 1 };
      continue;
    }
    if (current) {
      // Column-0 headings only: captured detail is stored two-space
      // indented, so a trimmed test would let tool output containing
      // `## Next` terminate the block and launder the remainder.
      if (SECTION_HEADING.test(line)) {
        blocks.push(blockFor(allLines, current.start, current.end));
        current = undefined;
        break;
      }
      current.end = i + 1;
      continue;
    }
    // A new section before the first bullet ends the Known-errors region.
    if (SECTION_HEADING.test(line)) break;
  }
  if (current) blocks.push(blockFor(allLines, current.start, current.end));
  // A section after Known errors belongs to the context slice, not errors.
  if (i < allLines.length) contextLines.push(...allLines.slice(i));
  return {
    contextLines: withoutBlankLines(contextLines),
    blocks,
  };
}

function splitWithoutHeading(allLines: readonly string[]): KnownErrorSections {
  const contextLines: string[] = [];
  const blocks: KnownErrorBlock[] = [];
  let current: { start: number; end: number } | undefined;
  for (let i = 0; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    if (BULLET_START.test(line)) {
      if (current) {
        blocks.push(blockFor(allLines, current.start, current.end));
        current = undefined;
      }
      if (TOOL_SUMMARY_LINE.test(line)) {
        current = { start: i, end: i + 1 };
      } else {
        contextLines.push(line);
      }
      continue;
    }
    if (current) {
      // Only a truly column-0 empty line ends the block. Capture writes a
      // blank detail line as two spaces, which must remain block content.
      if (line.length === 0 || line === "\r" || SECTION_HEADING.test(line)) {
        blocks.push(blockFor(allLines, current.start, current.end));
        current = undefined;
        contextLines.push(line);
      } else {
        current.end = i + 1;
      }
    } else {
      contextLines.push(line);
    }
  }
  if (current) blocks.push(blockFor(allLines, current.start, current.end));
  // No recognised block: preserve the input exactly (including blank lines).
  if (blocks.length === 0) {
    return { contextLines: [...allLines], blocks: [] };
  }
  return { contextLines: withoutBlankLines(contextLines), blocks };
}

/** Block ranges for `allLines`, including the no-heading fallback. */
export function knownErrorBlockRanges(
  allLines: readonly string[],
): Array<{ readonly start: number; readonly end: number }> {
  return splitKnownErrorSections(allLines).blocks.map(({ start, end }) => ({
    start,
    end,
  }));
}
