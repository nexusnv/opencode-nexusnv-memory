/**
 * Brief + priors loaders (spec §§5.2, 5.6 + c4-06-code).
 *
 * `loadBrief` feeds the per-model-call `context` hook: a capped
 * `activeContext` slice (goal/pending/next + summarised known-errors) plus a
 * one-line newest-handoff pointer, ≤48 lines including at most 5
 * message-derived error lines. It never carries the INDEX map (the `prompt`
 * hook is the sole INDEX injector) nor the `decisions.md` tail (recall-only
 * plus `loadPriors` for compaction only). Known Errors contribute
 * `sanitizeForBrief` summary lines only; captured bodies stay on disk for
 * `memory_recall`.
 *
 * `loadPriors` feeds the `compaction` hook only: `activeContext` slice +
 * `decisions.md` injectable tail (≤60 lines) + handoff pointer.
 *
 * All loaders are async and never throw (missing/unreadable → `""`/false);
 * output is always redacted and truncated with a notice.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import { countLines, readCapped, resolveMemoryRoot } from "./files.js";
import { sanitizeForBrief, UNTRUSTED_LABEL } from "./guard.js";
import { redact } from "./redact.js";

/** Injection cap for `loadBrief` output (fixed slice of `injectBudgetLines`). */
export const BRIEF_MAX_LINES = 48;

/** Max message-derived error summary lines per brief (spec §5.2). */
export const BRIEF_MAX_ERROR_LINES = 5;

export interface BriefOptions {
  /** Per-file cap for the underlying reads. Defaults to `fileLines` (60). */
  readonly fileLines?: number;
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
 * "missing" (silent) from "over cap" (report the count).
 */
export async function indexLineCount(
  absPath: string,
): Promise<number | undefined> {
  try {
    if (typeof absPath !== "string" || absPath.length === 0) return undefined;
    return countLines(await readFile(absPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Async INDEX cap check for the `prompt` hook: read + line count against
 * `indexLines` (delegates to `indexLineCount`). Missing, over-cap, or
 * unreadable resolves `false` (no attach, never throws). A file attachment
 * cannot be truncated, so an over-cap INDEX is skipped, not attached in part.
 */
export async function indexWithinCap(
  absPath: string,
  indexLines: number = DEFAULT_MEMORY_OPTIONS.indexLines,
): Promise<boolean> {
  try {
    if (!Number.isInteger(indexLines) || indexLines <= 0) return false;
    const count = await indexLineCount(absPath);
    return count !== undefined && count <= indexLines;
  } catch {
    return false;
  }
}

async function readTextOrEmpty(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

const KNOWN_ERRORS_HEADING = /^##\s+known errors\s*$/i;
const BULLET_START = /^\s*-\s+/;
const SECTION_HEADING = /^##\s+/;

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
      // Column-0 `##` only: captured detail bodies are stored 2-space
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
  const match = name.match(/^(\d{4}-\d{2}-\d{2}-\d{6})-(.+)\.md$/);
  if (!match) return { stamp: "", seq: 0, name };
  const rest = match[2]!;
  const seqMatch = rest.match(/^(.*)-(\d{2})$/);
  if (seqMatch && seqMatch[1]!.length === 6) {
    return { stamp: match[1]!, seq: Number.parseInt(seqMatch[2]!, 10), name };
  }
  return { stamp: match[1]!, seq: 0, name };
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
 * is none. Archive entries are recall-only and never pointed at. Never
 * throws.
 */
export async function newestHandoffLine(
  memoryRoot: string,
): Promise<string | undefined> {
  try {
    const entries = await readdir(join(memoryRoot, "handoffs"));
    const names = sortedHandoffNames(entries);
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
 * Names-only listing for `memory_recall` (never content, never throws):
 * newest first, bounded to `limit`. A missing/unreadable directory resolves
 * to an empty listing.
 */
export async function listHandoffs(
  memoryRoot: string,
  subdir: "root" | "archive",
  limit = 20,
): Promise<HandoffListing> {
  try {
    const dir = subdir === "archive" ? join("handoffs", "archive") : "handoffs";
    const sorted = sortedHandoffNames(await readdir(join(memoryRoot, dir)));
    const total = sorted.length;
    const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
    return { names: sorted.reverse().slice(0, cap), total };
  } catch {
    return { names: [], total: 0 };
  }
}

/**
 * Bounded per-model-call brief: `activeContext` slice + newest-handoff
 * pointer, ≤48 lines including at most 5 message-derived error summary
 * lines. Never the INDEX map, never the decisions tail. Redacted,
 * truncated with notice, never throws.
 */
export async function loadBrief(
  memoryRoot?: string,
  options?: BriefOptions,
): Promise<string> {
  try {
    const root = resolveMemoryRoot(memoryRoot);
    // fileLines intentionally unused: the brief is bounded by BRIEF_MAX_LINES
    // (48), which is tighter than any per-file disk cap.
    void options;
    const raw = await readTextOrEmpty(join(root, "activeContext.md"));
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
    const pointer = await newestHandoffLine(root);
    if (pointer !== undefined) body.push(pointer);

    if (body.length === 0) return "";
    const capped = truncateLinesWithNotice(
      ["[memory] active context", ...body],
      BRIEF_MAX_LINES,
    );
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
    const fileLines =
      options?.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines;
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
      const activeLines = pruneScaffoldNoise(active.split("\n"));
      if (activeLines.length > 0) {
        lines.push("## active context");
        lines.push(...activeLines);
      }
    }
    if (tail.trim().length > 0) {
      lines.push("## decisions (tail)");
      lines.push(...tail.split("\n").filter((l) => l.trim().length > 0));
    }
    const pointer = await newestHandoffLine(root);
    if (pointer !== undefined) lines.push(pointer);
    if (lines.length <= 2) return "";
    return redact(
      truncateLinesWithNotice(lines, cap * 2 + 5).join("\n"),
    );
  } catch {
    return "";
  }
}
