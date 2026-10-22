/**
 * Brief + priors loaders (spec §§5.2, 5.6 + c4-06-code).
 *
 * `loadBrief` feeds the per-model-call `context` hook: only the stable
 * `activeContext` slice (goal/pending/next + summarised known-errors), capped
 * dynamically (47 lines at defaults) and including at most 5 message-derived
 * error summary lines. The newest-handoff pointer is append-only prompt
 * admission data, never part of the stable system prefix. It never carries
 * the INDEX map (the `prompt` hook is the sole INDEX injector) nor the
 * `decisions.md` tail (recall-only plus `loadPriors` for compaction only).
 * Known Errors contribute `sanitizeForBrief` summary lines only; captured
 * bodies stay on disk for `memory_recall`.
 *
 * `loadPriors` feeds the `compaction` hook only: `activeContext` slice +
 * `decisions.md` injectable tail (≤60 lines) + handoff pointer.
 *
 * All loaders are async and never throw (missing/unreadable → `""`/false);
 * output is always redacted and truncated with a notice. Reads and handoff
 * listings are contained to the memory root.
 */
import { dirname, relative } from "node:path";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import {
  readCapped,
  readContainedLines,
  readHandoffDirectory,
  resolveMemoryRoot,
  splitTruncationNotice,
} from "./files.js";
import { sanitizeForBrief, UNTRUSTED_LABEL } from "./guard.js";
import { redact } from "./redact.js";

/** Injection cap for `loadBrief` output (fixed slice of `injectBudgetLines`). */
export const BRIEF_MAX_LINES = 48;

/** Max message-derived error summary lines per brief (spec §5.2). */
export const BRIEF_MAX_ERROR_LINES = 5;

export interface BriefOptions {
  /** Per-file cap for the underlying reads. Defaults to `fileLines` (60). */
  readonly fileLines?: number;
  /** Dynamic output cap (≤`BRIEF_MAX_LINES`); defaults to `BRIEF_MAX_LINES`. */
  readonly maxLines?: number;
}

export interface PriorsOptions {
  /** Per-file cap for the underlying reads. Defaults to `fileLines` (60). */
  readonly fileLines?: number;
}

/**
 * Cap `lines` to `cap` entries, appending a truncation notice as the last
 * line when truncated. Pure, never throws.
 */
export function truncateLinesWithNotice(
  lines: readonly string[],
  cap: number,
): string[] {
  try {
    if (!Number.isInteger(cap) || cap <= 0) return [];
    if (lines.length <= cap) return [...lines];
    if (cap === 1) {
      return [`[truncated: showing first 0 of ${lines.length} lines]`];
    }
    return [
      ...lines.slice(0, cap - 1),
      `[truncated: showing first ${cap - 1} of ${lines.length} lines]`,
    ];
  } catch {
    return [];
  }
}

/**
 * Async INDEX line count for the `prompt` hook: missing/unreadable/invalid
 * resolves `undefined` (never throws), so the caller can distinguish
 * "missing" (silent) from "over cap" (report the count). The optional root
 * must be paired with an exact `INDEX.md` path; a byte-guard hit is treated
 * as over-cap.
 */
export async function indexLineCount(
  absPath: string,
  memoryRoot?: string,
  indexLines = DEFAULT_MEMORY_OPTIONS.indexLines,
): Promise<number | undefined> {
  try {
    if (typeof absPath !== "string" || absPath.length === 0) return undefined;
    const root = memoryRoot ?? dirname(absPath);
    if (relative(root, absPath) !== "INDEX.md") return undefined;
    const cap =
      Number.isInteger(indexLines) && indexLines >= 0 ? indexLines : 30;
    const loaded = await readContainedLines("INDEX.md", {
      memoryRoot: root,
      maxLines: cap + 1,
      maxBytes: 1_048_576,
      onMissing: "skip",
    });
    if (loaded === undefined) return undefined;
    return loaded.truncated ? cap + 1 : loaded.lines.length;
  } catch {
    return undefined;
  }
}

/**
 * Async INDEX cap check for the `prompt` hook: read + line count against
 * `indexLines` (delegates to `indexLineCount`). Missing, over-cap, or
 * unreadable resolves `false` (no attach, never throws). A file attachment
 * cannot be truncated, so an over-cap INDEX is skipped, not attached in part.
 * When `memoryRoot` is supplied, the contained reader validates against that
 * fixed root instead of a path derived from `absPath`.
 */
export async function indexWithinCap(
  absPath: string,
  indexLines: number = DEFAULT_MEMORY_OPTIONS.indexLines,
  memoryRoot?: string,
): Promise<boolean> {
  try {
    if (!Number.isInteger(indexLines) || indexLines <= 0) return false;
    const count = await indexLineCount(absPath, memoryRoot, indexLines);
    return count !== undefined && count <= indexLines;
  } catch {
    return false;
  }
}

const KNOWN_ERRORS_HEADING = /^##\s+known errors\s*$/i;
// Only a column-0 bullet starts a block. Captured tool details are stored
// two-space indented, so an indented `  - ...` line is detail, not a new
// block (otherwise forgetting the summary would leave secret detail behind).
const BULLET_START = /^-\s+/;
const SECTION_HEADING = /^#{1,6}\s+/;

/**
 * Split `activeContext` lines into the context slice (everything outside
 * the Known-errors region) and Known-errors bullet blocks (bullet plus its
 * continuation lines, detail bodies included — the caller summarises each
 * block to one line and drops the body).
 */
function splitKnownErrors(allLines: string[]): {
  contextLines: string[];
  errorBlocks: string[][];
} {
  const headingIdx = allLines.findIndex((l) =>
    KNOWN_ERRORS_HEADING.test(l.trim()),
  );
  if (headingIdx === -1) {
    return { contextLines: [...allLines], errorBlocks: [] };
  }
  const contextLines = allLines.slice(0, headingIdx);
  const errorBlocks: string[][] = [];
  let current: string[] | undefined;
  let i = headingIdx + 1;
  for (; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    if (BULLET_START.test(line)) {
      if (current) errorBlocks.push(current);
      current = [line];
    } else if (current) {
      // Column-0 headings only: captured detail bodies are stored 2-space
      // indented (`  ${line}`), so a trimmed test would let tool output
      // containing `## Next` terminate the block early and launder the
      // remainder into the trusted context slice unsanitized (H-1).
      if (SECTION_HEADING.test(line)) {
        errorBlocks.push(current);
        current = undefined;
        break;
      }
      current.push(line);
    }
  }
  if (current) errorBlocks.push(current);
  // A section after Known errors belongs to the context slice, not the errors.
  if (i < allLines.length) contextLines.push(...allLines.slice(i));
  // Drop the heading itself plus blank padding around it: the brief carries
  // content lines, and the loader caps the total.
  return {
    contextLines: contextLines.filter((l) => l.trim().length > 0),
    errorBlocks,
  };
}

/** Legacy scaffold placeholder bullets (pre-Tier-0 templates) — never content. */
const SCAFFOLD_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "(what this session is trying to do)",
  "(open items)",
  "(immediate next steps)",
  "(one summary line per failure, tagged source:tool; detail blocks are recall-only)",
]);

const COMMENT_ONLY_LINE = /^\s*<!--.*-->\s*$/;
const HEADING_LINE = /^(#{1,6})\s+/;
const BOM = "\uFEFF";

/**
 * Drop a leading BOM (only ever the first char of a hand-edited file's first
 * line): it must not hide a heading or turn scaffold noise into content.
 */
function withoutBom(line: string): string {
  return line.startsWith(BOM) ? line.slice(BOM.length) : line;
}

/** Blank, comment-only, or a legacy scaffold placeholder bullet. Pure. */
function isScaffoldNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (COMMENT_ONLY_LINE.test(trimmed)) return true;
  return SCAFFOLD_PLACEHOLDERS.has(trimmed.replace(/^[-*]\s+/, ""));
}

/**
 * Drop blanks, comment-only lines, legacy scaffold placeholders, and headings
 * whose section has no content before the next heading of the same or higher
 * level (or EOF). A fresh scaffold therefore injects nothing while real files
 * keep their headings. Pure, never throws.
 */
export function pruneScaffoldNoise(lines: readonly string[]): string[] {
  try {
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = withoutBom(lines[i]!);
      if (isScaffoldNoise(line)) continue;
      const heading = HEADING_LINE.exec(line);
      if (heading) {
        // Column-0 headings only (H-1 discipline, same as splitKnownErrors):
        // captured detail bodies are 2-space indented and must never read as
        // section boundaries.
        const level = heading[1]!.length;
        let hasContent = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = withoutBom(lines[j]!);
          const nextHeading = HEADING_LINE.exec(next);
          if (nextHeading) {
            if (nextHeading[1]!.length <= level) break;
            continue; // deeper heading: not content for this section
          }
          if (!isScaffoldNoise(next)) {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) continue;
      }
      kept.push(line);
    }
    return kept;
  } catch {
    return [...lines];
  }
}

/**
 * Order key for a top-level handoff name: explicit `(stamp, sequence)` so a
 * collision sibling (`<stamp>-<session6>-01.md`) ranks after its base
 * (`<stamp>-<session6>.md`). The session suffix is a fixed 6 characters, so
 * a trailing `-NN` is unambiguous; anything else ranks as sequence 0 with
 * the full name as tiebreak. Names without a timestamp stamp sort first
 * (legacy/unexpected, never newest).
 */
function handoffOrder(name: string): {
  stamp: string;
  seq: number;
  name: string;
} {
  // Impossible dates (e.g. 2026-02-31) are unexpected names, never newest.
  if (parseHandoffTimestamp(name) === undefined) {
    return { stamp: "", seq: 0, name };
  }
  const match = name.match(/^(\d{4}-\d{2}-\d{2}-\d{6})-(.+)\.md$/);
  if (!match) return { stamp: "", seq: 0, name };
  const rest = match[2]!;
  const seqMatch = rest.match(/^(.*)-(\d{2})$/);
  if (seqMatch && seqMatch[1]!.length === 6) {
    return { stamp: match[1]!, seq: Number.parseInt(seqMatch[2]!, 10), name };
  }
  return { stamp: match[1]!, seq: 0, name };
}

/**
 * Parse the generated `YYYY-MM-DD-HHmmss-` prefix. Returns `undefined` for
 * unexpected names; GC never deletes a name it cannot timestamp.
 */
export function parseHandoffTimestamp(name: string): number | undefined {
  const match = name.match(
    /^(\d{4})-(\d{2})-(\d{2})-(\d{6})-[A-Za-z0-9._-]+\.md$/,
  );
  if (!match) return undefined;
  const [, year, month, day, time] = match;
  const yearNum = Number.parseInt(year!, 10);
  const monthNum = Number.parseInt(month!, 10);
  const dayNum = Number.parseInt(day!, 10);
  const hours = Number.parseInt(time!.slice(0, 2), 10);
  const minutes = Number.parseInt(time!.slice(2, 4), 10);
  const seconds = Number.parseInt(time!.slice(4, 6), 10);
  const stamp = Date.UTC(
    yearNum,
    monthNum - 1,
    dayNum,
    hours,
    minutes,
    seconds,
  );
  const date = new Date(stamp);
  // Date.UTC normalizes 2026-02-31 and 2026-99-99 into other days/months.
  // Round-trip every component so an impossible name is never "newest".
  if (
    date.getUTCFullYear() !== yearNum ||
    date.getUTCMonth() !== monthNum - 1 ||
    date.getUTCDate() !== dayNum ||
    date.getUTCHours() !== hours ||
    date.getUTCMinutes() !== minutes ||
    date.getUTCSeconds() !== seconds
  ) {
    return undefined;
  }
  return Number.isFinite(stamp) ? stamp : undefined;
}

/** Newest-last order for top-level/archive handoff names (shared). */
function sortedHandoffNames(names: readonly string[]): string[] {
  return names
    .filter((n) => /^[A-Za-z0-9._-]+\.md$/.test(n))
    .map(handoffOrder)
    .sort(
      (a, b) =>
        (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0) ||
        a.seq - b.seq ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map((o) => o.name);
}

/**
 * Newest top-level `handoffs/*.md` pointer line, or `undefined` when there
 * is none. Archive entries are recall-only and never pointed at. The listing
 * is contained: handoff aliases (in-root or off-root) yield no names. Never
 * throws.
 */
export async function newestHandoffLine(
  memoryRoot: string,
): Promise<string | undefined> {
  try {
    const entries = await readHandoffDirectory(memoryRoot, "root");
    const names = sortedHandoffNames(entries).filter(
      (name) => parseHandoffTimestamp(name) !== undefined,
    );
    if (names.length === 0) return undefined;
    return `[memory] handoff: handoffs/${names[names.length - 1]!} (latest)`;
  } catch {
    return undefined;
  }
}

export interface HandoffListing {
  /** Newest-first names, at most `limit` (names only, never content). */
  readonly names: readonly string[];
  /** Filtered total in the directory. */
  readonly total: number;
}

/**
 * Names-only listing that fails closed: a missing/unreadable directory is
 * empty, but any other error propagates. GC uses this so it can never claim
 * "nothing to delete" when it could not read `handoffs/`.
 */
export async function listHandoffsStrict(
  memoryRoot: string,
  subdir: "root" | "archive",
  limit = 20,
): Promise<HandoffListing> {
  let sorted: string[];
  try {
    sorted = sortedHandoffNames(
      await readHandoffDirectory(memoryRoot, subdir, { strict: true }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { names: [], total: 0 };
    }
    throw error;
  }
  const total = sorted.length;
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  return { names: sorted.reverse().slice(0, cap), total };
}

/**
 * Names-only listing for `memory_recall` (never content, never throws):
 * newest first, bounded to `limit`. A missing/unreadable directory or a
 * symlinked/aliased handoff directory resolves to an empty listing.
 */
export async function listHandoffs(
  memoryRoot: string,
  subdir: "root" | "archive",
  limit = 20,
): Promise<HandoffListing> {
  try {
    return await listHandoffsStrict(memoryRoot, subdir, limit);
  } catch {
    return { names: [], total: 0 };
  }
}

/**
 * Bounded per-model-call brief: only the `activeContext` slice, capped
 * dynamically (default and maximum 48 lines) and including at most 5
 * message-derived error summary lines. Never the INDEX map, never the
 * decisions tail, never the newest-handoff pointer (the prompt hook appends
 * that notice to the user input). Reads are contained, redacted, truncated
 * with notice, never throws.
 */
export async function loadBrief(
  memoryRoot?: string,
  options?: BriefOptions,
): Promise<string> {
  try {
    const root = resolveMemoryRoot(memoryRoot);
    const requested = options?.maxLines ?? BRIEF_MAX_LINES;
    const cap =
      Number.isInteger(requested) && requested >= 0
        ? Math.min(requested, BRIEF_MAX_LINES)
        : BRIEF_MAX_LINES;
    if (cap === 0) return "";
    // fileLines intentionally unused: the brief is bounded by `cap`
    // (≤BRIEF_MAX_LINES), which is tighter than any per-file disk cap.
    const loaded = await readContainedLines("activeContext.md", {
      memoryRoot: root,
      maxLines: cap + 1,
      maxBytes: 1_048_576,
      onMissing: "skip",
    });
    const raw = loaded?.lines.join("\n") ?? "";
    const redacted = redact(raw);
    const allLines = redacted.length === 0 ? [] : redacted.split("\n");
    const { contextLines, errorBlocks } = splitKnownErrors(allLines);

    const body: string[] = pruneScaffoldNoise(contextLines);
    const summaries: string[] = [];
    const cleanBlocks = errorBlocks.filter((b) => !isScaffoldNoise(b[0] ?? ""));
    for (const block of cleanBlocks.slice(0, BRIEF_MAX_ERROR_LINES)) {
      const summary = sanitizeForBrief(block.join("\n"));
      if (summary.length > 0) summaries.push(summary);
    }
    if (summaries.length > 0) {
      body.push(UNTRUSTED_LABEL);
      body.push(...summaries);
    }

    const inputTruncated = loaded?.truncated === true;
    const sourceLines = Math.max(loaded?.lines.length ?? 0, 1);
    if (body.length === 0 && !inputTruncated) return "";
    const candidates = ["[memory] active context", ...body];
    // A bounded read only knows a lower bound on the source length. Do not
    // print that bound as an exact total; say "at least" instead. Pruning can
    // also remove the sentinel line, so force the notice whenever the reader
    // stopped early.
    const capped = inputTruncated
      ? (() => {
          const keep = cap <= 1 ? 0 : cap - 1;
          const shown = Math.min(candidates.length, keep);
          return [
            ...candidates.slice(0, keep),
            `[truncated: showing first ${shown} of at least ${sourceLines} lines]`,
          ];
        })()
      : truncateLinesWithNotice(candidates, cap);
    return redact(capped.join("\n"));
  } catch {
    return "";
  }
}

/**
 * Bounded compaction priors: `activeContext` slice + `decisions.md`
 * injectable tail (≤`fileLines`) + newest-handoff pointer. The only
 * auto-inject path for the decisions tail. Redacted, truncated with
 * notice, never throws.
 */
export async function loadPriors(
  memoryRoot?: string,
  options?: PriorsOptions,
): Promise<string> {
  try {
    const root = resolveMemoryRoot(memoryRoot);
    const fileLines = options?.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines;
    const cap = Number.isInteger(fileLines) && fileLines > 0 ? fileLines : 60;
    let active = "";
    try {
      active = await readCapped("activeContext.md", {
        memoryRoot: root,
        fileLines: cap,
      });
    } catch {
      active = "";
    }
    let tail = "";
    try {
      tail = await readCapped("decisions.md", {
        memoryRoot: root,
        fileLines: cap,
      });
    } catch {
      tail = "";
    }
    const lines: string[] = ["[memory] compaction priors"];
    // H-2: activeContext + decisions tail are untrusted data (hand-edits,
    // social-engineered approvals, rememberAsserted lines). Label them as
    // data-only like loadBrief does — the compaction summarizer must not
    // treat priors as trusted instructions.
    lines.push(UNTRUSTED_LABEL);
    if (active.trim().length > 0) {
      // The loader-generated truncation notice is not content: a truncated
      // fresh scaffold injects no section, and the notice rides after real
      // content only.
      const { body, notice } = splitTruncationNotice(active);
      const activeLines = pruneScaffoldNoise(body.split("\n"));
      if (activeLines.length > 0) {
        lines.push("## active context");
        lines.push(...activeLines);
        if (notice !== undefined) lines.push(notice);
      }
    }
    if (tail.trim().length > 0) {
      lines.push("## decisions (tail)");
      lines.push(...tail.split("\n").filter((l) => l.trim().length > 0));
    }
    const pointer = await newestHandoffLine(root);
    if (pointer !== undefined) lines.push(pointer);
    if (lines.length <= 2) return "";
    return redact(truncateLinesWithNotice(lines, cap * 2 + 5).join("\n"));
  } catch {
    return "";
  }
}
