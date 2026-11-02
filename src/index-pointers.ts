/**
 * INDEX pointer detection for `/memory-forget` (issue #23, E13, ADR-0009).
 *
 * Pure and filesystem-free: callers pass the pre-forget file text, the
 * post-forget text, the removed units, and the raw INDEX text. The detector
 * only *suggests* cleanup; it never rewrites INDEX.
 *
 * A pointer is a candidate only when the evidence is unambiguous:
 *   - an exact literal topic/section phrase disappears with the selection
 *     (matched as a whole phrase inside one removed unit), or
 *   - a `topic → file:section` pointer's section loses all remaining non-blank
 *     content because the selection removed content from it.
 *
 * File-general scaffold lines are ignored. An unresolvable explicit section, a
 * duplicate heading match, a removed heading whose content remains, a removed
 * heading whose section was already empty, or a line whose topic names removed
 * content while the topic still appears elsewhere is reported as ambiguous and
 * left for manual editing.
 */

/** Minimum normalized pointer length for literal matching. */
const MIN_POINTER_LENGTH = 8;

/** The structural files an INDEX line may point at. */
const FILE_TOKENS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly file: string;
}> = [
  { pattern: /\bactivecontext\.md\b/i, file: "activeContext.md" },
  { pattern: /\bdecisions\.md\b/i, file: "decisions.md" },
  { pattern: /\barchitecture\.md\b/i, file: "architecture.md" },
  { pattern: /\bstyle\.md\b/i, file: "style.md" },
  { pattern: /\bissues\.md\b/i, file: "issues.md" },
  { pattern: /\bindex\.md\b/i, file: "INDEX.md" },
  {
    pattern: /\bactivecontext\b(?=\s*(?:[:#]|$))/i,
    file: "activeContext.md",
  },
  { pattern: /\bdecisions\b(?=\s*(?:[:#]|$))/i, file: "decisions.md" },
  {
    pattern: /\barchitecture\b(?=\s*(?:[:#]|$))/i,
    file: "architecture.md",
  },
  { pattern: /\bstyle\b(?=\s*(?:[:#]|$))/i, file: "style.md" },
  { pattern: /\bissues\b(?=\s*(?:[:#]|$))/i, file: "issues.md" },
  { pattern: /\bindex\b(?=\s*(?:[:#]|$))/i, file: "INDEX.md" },
];

/** Generic file-name words that never make a pointer specific on their own. */
const FILE_WORDS: ReadonlySet<string> = new Set([
  "activecontext",
  "activecontext.md",
  "decisions",
  "decisions.md",
  "architecture",
  "architecture.md",
  "style",
  "style.md",
  "issues",
  "issues.md",
  "index",
  "index.md",
]);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*\#*\s*$/;
/** CommonMark fence opener: up to three spaces, at least three markers. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ARROW_RE = /→|->|=>/;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

export interface RemovedUnit {
  readonly lineNumbers: readonly number[];
  readonly text: string;
}

export interface IndexPointerCandidate {
  /** 1-based line number in INDEX.md. */
  readonly line: number;
  /** Raw INDEX line; renderers redact and clip it. */
  readonly text: string;
  readonly reason: "literal" | "empty-section";
}

export interface IndexPointerAmbiguity {
  /** 1-based line number in INDEX.md. */
  readonly line: number;
  /** Raw INDEX line; renderers redact and clip it. */
  readonly text: string;
  readonly reason: string;
}

export type IndexPointerStatus =
  | "inspected"
  | "missing"
  | "over-cap"
  | "truncated"
  | "unreadable";

export interface IndexPointerReport {
  readonly status: IndexPointerStatus;
  readonly candidates: readonly IndexPointerCandidate[];
  readonly ambiguous: readonly IndexPointerAmbiguity[];
}

export function emptyIndexPointerReport(
  status: IndexPointerStatus = "missing",
): IndexPointerReport {
  return { status, candidates: [], ambiguous: [] };
}

interface Heading {
  readonly index: number;
  readonly level: number;
  readonly text: string;
  /** First line after this heading's section (exclusive). */
  end: number;
}

interface ParsedIndexLine {
  readonly file: string;
  readonly topic: string;
  readonly section: string;
}

type SectionResolution =
  | { readonly heading: Heading }
  | "missing"
  | "ambiguous";

/** Lowercase, strip markdown decoration and edge punctuation for matching. */
function normalizePointerText(text: string): string {
  return text
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.>#\-–—]+/, "")
    .replace(/[\s:;,.>#\-–—]+$/, "")
    .trim()
    .toLowerCase();
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR_RE.test(char);
}

/**
 * True when `needle` occurs in `haystack` as a complete phrase. Word edges in
 * the needle must not be embedded in a larger word ("configuration" does not
 * match inside "reconfiguration").
 */
function phrasePresent(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const first = needle[0]!;
  const last = needle[needle.length - 1]!;
  let start = haystack.indexOf(needle);
  while (start !== -1) {
    const before = start === 0 ? undefined : haystack[start - 1];
    const afterIndex = start + needle.length;
    const after =
      afterIndex >= haystack.length ? undefined : haystack[afterIndex];
    if (
      (!isWordChar(first) || !isWordChar(before)) &&
      (!isWordChar(last) || !isWordChar(after))
    ) {
      return true;
    }
    start = haystack.indexOf(needle, start + 1);
  }
  return false;
}

function findFileToken(
  text: string,
):
  | { readonly file: string; readonly index: number; readonly length: number }
  | undefined {
  let best:
    | { readonly file: string; readonly index: number; readonly length: number }
    | undefined;
  for (const token of FILE_TOKENS) {
    const match = token.pattern.exec(text);
    if (match === null) continue;
    const candidate = {
      file: token.file,
      index: match.index,
      length: match[0].length,
    };
    if (
      best === undefined ||
      candidate.index < best.index ||
      (candidate.index === best.index && candidate.length > best.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Parse a documented `topic → file[:section]` row. Rows without an arrow are
 * file-general map lines (`- architecture: …`) and are deliberately ignored.
 * The destination file is resolved from the text after the arrow so a filename
 * mentioned in the topic cannot hide the real target.
 */
function parseIndexLine(line: string): ParsedIndexLine | undefined {
  const arrow = ARROW_RE.exec(line);
  if (arrow === null) return undefined;
  const destination = line.slice(arrow.index + arrow[0].length);
  const token = findFileToken(destination);
  if (token === undefined) return undefined;
  const afterFile = destination.slice(token.index + token.length);
  return {
    file: token.file,
    topic: normalizePointerText(line.slice(0, arrow.index)),
    section: normalizePointerText(
      afterFile.replace(/^\s*[:#/\-–—]*\s*/, ""),
    ),
  };
}

function parseHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: { readonly char: string; readonly length: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== undefined) {
      if (
        fenceMatch !== null &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (
      fenceMatch !== null &&
      !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))
    ) {
      fence = {
        char: fenceMatch[1]![0]!,
        length: fenceMatch[1]!.length,
      };
      continue;
    }
    const match = HEADING_RE.exec(line);
    if (match === null) continue;
    const text = normalizePointerText(match[2]!);
    if (text.length === 0) continue;
    headings.push({
      index: i,
      level: match[1]!.length,
      text,
      end: lines.length,
    });
  }
  // Precompute each section's end so row resolution is O(1) after one pass.
  const stack: Heading[] = [];
  for (const heading of headings) {
    while (
      stack.length > 0 &&
      stack[stack.length - 1]!.level >= heading.level
    ) {
      stack.pop()!.end = heading.index;
    }
    stack.push(heading);
  }
  return headings;
}

function indexHeadings(
  headings: readonly Heading[],
): ReadonlyMap<string, readonly Heading[]> {
  const byText = new Map<string, Heading[]>();
  for (const heading of headings) {
    const matches = byText.get(heading.text);
    if (matches === undefined) byText.set(heading.text, [heading]);
    else matches.push(heading);
  }
  return byText;
}

function resolveSection(
  headingsByText: ReadonlyMap<string, readonly Heading[]>,
  section: string,
): SectionResolution {
  const matches = headingsByText.get(section);
  if (matches === undefined || matches.length === 0) return "missing";
  if (matches.length > 1) return "ambiguous";
  return { heading: matches[0]! };
}

interface SectionEffect {
  readonly headingRemoved: boolean;
  readonly removedContent: boolean;
  readonly remainingContent: boolean;
}

/** What the selection did to one uniquely resolved section. */
function inspectSection(
  lines: readonly string[],
  start: number,
  end: number,
  removed: ReadonlySet<number>,
): SectionEffect {
  let removedContent = false;
  let remainingContent = false;
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (removed.has(i)) removedContent = true;
    else remainingContent = true;
  }
  return {
    headingRemoved: removed.has(start),
    removedContent,
    remainingContent,
  };
}

function sectionResolutionReason(
  resolution: "missing" | "ambiguous",
  section: string,
  file: string,
): string {
  return resolution === "ambiguous"
    ? `section "${section}" matches more than one heading in ${file}; edit INDEX.md manually`
    : `section "${section}" was not found in ${file}; edit INDEX.md manually`;
}

function isSpecificPointer(pointer: string, file: string): boolean {
  if (pointer.length < MIN_POINTER_LENGTH) return false;
  if (FILE_WORDS.has(pointer)) return false;
  const stem = file.replace(/\.md$/i, "").toLowerCase();
  return pointer !== file.toLowerCase() && pointer !== stem;
}

/**
 * Detect INDEX lines that the selection made stale. Pure; never throws for
 * well-formed strings and never reads files. `currentFileText` and
 * `nextFileText` are the pre- and post-forget text of the *forgotten* file.
 */
export function detectIndexPointers(input: {
  readonly forgottenFile: string;
  readonly currentFileText: string;
  readonly nextFileText: string;
  readonly removedUnits: readonly RemovedUnit[];
  readonly indexText: string;
}): IndexPointerReport {
  const candidates: IndexPointerCandidate[] = [];
  const ambiguous: IndexPointerAmbiguity[] = [];
  if (input.forgottenFile === "INDEX.md") {
    return { status: "inspected", candidates, ambiguous };
  }

  const fileLines = input.currentFileText.split("\n");
  const indexLines = input.indexText.split("\n");
  const headings = parseHeadings(fileLines);
  const headingsByText = indexHeadings(headings);
  const removed = new Set<number>();
  for (const unit of input.removedUnits) {
    for (const line of unit.lineNumbers) removed.add(line - 1);
  }
  // Match literal phrases inside one contiguous removed unit, never across the
  // boundary between separately approved units.
  const removedTexts = input.removedUnits.map((unit) =>
    normalizePointerText(unit.text),
  );
  const nextText = normalizePointerText(input.nextFileText);

  for (let i = 0; i < indexLines.length; i += 1) {
    const raw = indexLines[i]!;
    const parsed = parseIndexLine(raw);
    if (parsed === undefined || parsed.file !== input.forgottenFile) continue;
    const { topic, section } = parsed;
    const hasSection = section.length > 0;
    if (!hasSection && topic.length === 0) continue;

    const resolution = resolveSection(
      headingsByText,
      hasSection ? section : topic,
    );
    if (
      hasSection &&
      (resolution === "missing" || resolution === "ambiguous")
    ) {
      ambiguous.push({
        line: i + 1,
        text: raw,
        reason: sectionResolutionReason(
          resolution,
          section,
          input.forgottenFile,
        ),
      });
      continue;
    }
    const sectionEffect =
      resolution !== "missing" && resolution !== "ambiguous"
        ? inspectSection(
            fileLines,
            resolution.heading.index,
            resolution.heading.end,
            removed,
          )
        : undefined;
    const pointer = hasSection ? section : topic;

    if (
      sectionEffect !== undefined &&
      sectionEffect.headingRemoved &&
      sectionEffect.remainingContent
    ) {
      ambiguous.push({
        line: i + 1,
        text: raw,
        reason: hasSection
          ? `section heading "${section}" was removed but content remains in ${input.forgottenFile}; edit INDEX.md manually`
          : `topic "${topic}" matched a heading that was removed but its content remains in ${input.forgottenFile}; edit INDEX.md manually`,
      });
      continue;
    }
    if (
      sectionEffect !== undefined &&
      sectionEffect.removedContent &&
      !sectionEffect.remainingContent
    ) {
      // A topic that survives in another section means the row still points
      // at remaining content, so removing it is not clearly safe.
      if (
        hasSection &&
        topic.length > 0 &&
        topic !== section &&
        phrasePresent(nextText, topic)
      ) {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason: `section "${section}" is now empty but the topic still appears in ${input.forgottenFile}; edit INDEX.md manually`,
        });
        continue;
      }
      candidates.push({ line: i + 1, text: raw, reason: "empty-section" });
      continue;
    }
    if (
      sectionEffect !== undefined &&
      sectionEffect.headingRemoved &&
      !sectionEffect.removedContent &&
      !sectionEffect.remainingContent
    ) {
      // The heading was already empty before this forget; the pointer was
      // stale before the selection and needs manual review, not a candidate.
      ambiguous.push({
        line: i + 1,
        text: raw,
        reason: `heading "${pointer}" was removed but its section was already empty in ${input.forgottenFile}; edit INDEX.md manually`,
      });
      continue;
    }

    const pointerGone =
      isSpecificPointer(pointer, input.forgottenFile) &&
      removedTexts.some((text) => phrasePresent(text, pointer)) &&
      !phrasePresent(nextText, pointer);
    const topicGone =
      topic.length > 0 &&
      isSpecificPointer(topic, input.forgottenFile) &&
      removedTexts.some((text) => phrasePresent(text, topic)) &&
      !phrasePresent(nextText, topic);

    if (pointerGone) {
      candidates.push({ line: i + 1, text: raw, reason: "literal" });
      continue;
    }
    if (hasSection && topic.length > 0 && topicGone) {
      ambiguous.push({
        line: i + 1,
        text: raw,
        reason:
          sectionEffect?.remainingContent === false
            ? "names removed content but the referenced section has no remaining content; edit the line rather than remove it"
            : "names removed content but the referenced section still has content; edit the line rather than remove it",
      });
      continue;
    }
    // A file-general line, or a section that still has content, is not stale.
  }

  return { status: "inspected", candidates, ambiguous };
}
