/**
 * INDEX pointer detection for `/memory-forget` (issue #23, E13, ADR-0009).
 *
 * Pure and filesystem-free: callers pass the pre-forget file text, the
 * post-forget text, the removed units, and the raw INDEX text. The detector
 * only *suggests* cleanup; it never rewrites INDEX.
 *
 * A pointer is a candidate only when the evidence is unambiguous:
 *   - an exact literal topic/section phrase disappears with the selection, or
 *   - a `file:section` pointer's section loses every remaining non-blank line.
 *
 * File-general scaffold lines are ignored. An unresolvable explicit section,
 * a duplicate heading match, or a line whose topic names removed content while
 * the referenced section still has content is reported as ambiguous and left
 * for manual editing.
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
}

interface ParsedIndexLine {
  readonly file: string;
  readonly topic: string;
  readonly section: string;
}

type SectionResolution =
  | { readonly heading: Heading; readonly end: number }
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

function findFileToken(
  text: string,
): { readonly file: string; readonly index: number; readonly length: number } | undefined {
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

/** Drop a leading file-name token so `- architecture: …` has no topic. */
function topicBeforeFile(left: string, file: string): string {
  const cleaned = normalizePointerText(left);
  if (cleaned.length === 0) return "";
  const stem = file.replace(/\.md$/i, "").toLowerCase();
  if (cleaned === file.toLowerCase() || cleaned === stem) return "";
  return cleaned;
}

function parseIndexLine(line: string): ParsedIndexLine | undefined {
  const arrow = /→|->|=>/.exec(line);
  const token = findFileToken(line);
  if (token === undefined) return undefined;
  const left = line.slice(0, token.index);
  const after = line.slice(token.index + token.length);
  const topicSource =
    arrow !== null && arrow.index < token.index
      ? line.slice(0, arrow.index)
      : left;
  return {
    file: token.file,
    topic:
      arrow !== null && arrow.index < token.index
        ? normalizePointerText(topicSource)
        : topicBeforeFile(topicSource, token.file),
    section: normalizePointerText(
      after.replace(/^\s*[:#/\-–—]*\s*/, ""),
    ),
  };
}

function parseHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i]!);
    if (match === null) continue;
    const text = normalizePointerText(match[2]!);
    if (text.length === 0) continue;
    headings.push({ index: i, level: match[1]!.length, text });
  }
  return headings;
}

function resolveSection(
  headings: readonly Heading[],
  section: string,
  lineCount: number,
): SectionResolution {
  const matches = headings.filter((heading) => heading.text === section);
  if (matches.length === 0) return "missing";
  if (matches.length > 1) return "ambiguous";
  const heading = matches[0]!;
  let end = lineCount;
  for (const other of headings) {
    if (other.index > heading.index && other.level <= heading.level) {
      end = other.index;
      break;
    }
  }
  return { heading, end };
}

/** True when no non-blank line remains in the section except removed lines. */
function sectionLosesAllContent(
  lines: readonly string[],
  start: number,
  end: number,
  removed: ReadonlySet<number>,
): boolean {
  if (removed.has(start)) return true;
  for (let i = start + 1; i < end; i += 1) {
    if (removed.has(i)) continue;
    if (lines[i]!.trim() === "") continue;
    return false;
  }
  return true;
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
  const removed = new Set<number>();
  for (const unit of input.removedUnits) {
    for (const line of unit.lineNumbers) removed.add(line - 1);
  }
  const removedText = normalizePointerText(
    input.removedUnits.map((unit) => unit.text).join("\n"),
  );
  const nextText = normalizePointerText(input.nextFileText);

  for (let i = 0; i < indexLines.length; i += 1) {
    const raw = indexLines[i]!;
    const parsed = parseIndexLine(raw);
    if (parsed === undefined || parsed.file !== input.forgottenFile) continue;
    const { topic, section } = parsed;
    const pointer = section.length > 0 ? section : topic;
    if (pointer.length === 0) continue;

    const resolution = resolveSection(headings, pointer, fileLines.length);
    const sectionEmpty =
      resolution !== "missing" &&
      resolution !== "ambiguous" &&
      sectionLosesAllContent(
        fileLines,
        resolution.heading.index,
        resolution.end,
        removed,
      );
    const pointerGone =
      isSpecificPointer(pointer, input.forgottenFile) &&
      removedText.includes(pointer) &&
      !nextText.includes(pointer);
    const topicGone =
      topic.length > 0 &&
      isSpecificPointer(topic, input.forgottenFile) &&
      removedText.includes(topic) &&
      !nextText.includes(topic);

    if (sectionEmpty) {
      candidates.push({ line: i + 1, text: raw, reason: "empty-section" });
      continue;
    }
    if (pointerGone) {
      candidates.push({ line: i + 1, text: raw, reason: "literal" });
      continue;
    }
    if (topicGone) {
      // section.length === 0 is unreachable here: pointer === topic, and
      // pointerGone (checked above) evaluates the identical condition and
      // would have continued already.
      ambiguous.push({
        line: i + 1,
        text: raw,
        reason:
          "names removed content but the referenced section still has content; edit the line rather than remove it",
      });
      continue;
    }
    if (section.length > 0 && topic.length > 0) {
      if (resolution === "ambiguous") {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason: `section "${section}" matches more than one heading in ${input.forgottenFile}; edit INDEX.md manually`,
        });
        continue;
      }
      if (
        resolution === "missing" &&
        isSpecificPointer(section, input.forgottenFile)
      ) {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason: `section "${section}" was not found in ${input.forgottenFile}; edit INDEX.md manually`,
        });
        continue;
      }
    }
    // A file-general line, or a section that still has content, is not stale.
  }

  return { status: "inspected", candidates, ambiguous };
}
