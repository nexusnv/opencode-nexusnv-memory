/**
 * INDEX tell-tale (spec §§5.2, 5.7 + c4-06-code).
 *
 * `matchIndex` parses the latest user-authored text from the `prompt`
 * event (or a `context` event's `messages: Message[]`) and returns at most
 * one hint line on an exact INDEX term hit — never content, never
 * fuzzy/semantic. The call target is the structural file of the matched
 * INDEX line (first stem on the line; default `decisions.md`). Throttled to
 * once per prompt per session via the ledger key
 * `<projectID>/hint/<sessionID>/<promptHash>` so tool-driven continuations
 * do not re-inject the same hint. The **prompt** hook renders the line as a
 * prompt-tail notice; the system `context` prefix carries only the brief.
 *
 * `matchRememberNearMiss` (E11) is the other filler of the same one-line hint
 * slot: when the latest user text looks like a `remember:` attempt but is not
 * the documented line-start form, it returns a fixed nudge. It shares the
 * prompt-hash throttle key, never reads memory, and never arms the
 * hint→recall correlation (the caller decides that). Async, never throws.
 */
import { createHash } from "node:crypto";
import { claimHint, type LedgerStorage } from "./capture.js";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import { readContainedLines } from "./files.js";
import { isRememberNearMiss } from "./provenance.js";
import { redact } from "./redact.js";

export interface MatchIndexOptions {
  readonly storage: LedgerStorage;
  readonly projectID: string;
  readonly sessionID: string;
  /** Defaults to the sha256 of the extracted user text. */
  readonly promptHash?: string;
  /** When omitted, INDEX.md is read from `memoryRoot`. */
  readonly indexContent?: string;
  /** INDEX line cap; over-cap INDEX is not hint-eligible. Defaults to 30. */
  readonly indexLines?: number;
  /** Absolute path to `.opencode/memory`. Defaults to `<cwd>/.opencode/memory`. */
  readonly memoryRoot?: string;
  readonly now?: number;
}

/** Short glue words never form a hint on their own. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "into",
  "onto",
  "upon",
  "about",
  "which",
  "what",
  "when",
  "where",
  "does",
  "file",
  "files",
  "lines",
  "line",
  "list",
  "also",
  "each",
  "other",
  "more",
  "most",
  "such",
  "than",
  "then",
  "there",
  "their",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "your",
  "you",
  "our",
  "are",
  "was",
  "were",
  "been",
  "being",
  "memory",
  "recall",
  "markdown",
  "section",
  "current",
]);

const TERM_PATTERN = /[A-Za-z0-9_]+(?:[./-][A-Za-z0-9_]+)*/g;

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Latest user-authored text: the last `role === "user"` message's `text`
 * parts, newest-first. Accepts a raw string, a `Message[]`, or an
 * event-like `{ messages }` / `{ text }` wrapper. Pure, never throws.
 */
export function extractLatestUserText(input: unknown): string | undefined {
  try {
    if (typeof input === "string") {
      const text = input.trim();
      return text.length > 0 ? text : undefined;
    }
    let messages: unknown = input;
    if (typeof input === "object" && input !== null) {
      if (Array.isArray(input)) {
        messages = input;
      } else {
        const record = input as Record<string, unknown>;
        if (Array.isArray(record["messages"])) {
          messages = record["messages"];
        } else if (typeof record["text"] === "string") {
          const text = (record["text"] as string).trim();
          return text.length > 0 ? text : undefined;
        } else {
          return undefined;
        }
      }
    }
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (typeof message !== "object" || message === null) continue;
      const record = message as Record<string, unknown>;
      if (record["role"] !== "user") continue;
      const content = record["content"];
      const parts: string[] =
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content.flatMap((part) =>
                typeof part === "object" &&
                part !== null &&
                (part as Record<string, unknown>)["type"] === "text" &&
                typeof (part as Record<string, unknown>)["text"] ===
                  "string"
                  ? [(part as Record<string, unknown>)["text"] as string]
                  : [],
              )
            : [];
      const text = parts.join("\n").trim();
      if (text.length > 0) return text;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Stable per-prompt throttle hash over the extracted user text. */
export function promptHashFor(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * INDEX stem → structural file for the hint's call target (leftmost stem on
 * the matched line wins; ties resolve in this list order). A documented
 * heuristic, not INDEX-grammar parsing.
 */
const TARGET_FILES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bactivecontext\b/i, "activeContext.md"],
  [/\bdecisions\b/i, "decisions.md"],
  [/\barchitecture\b/i, "architecture.md"],
  [/\bstyle\b/i, "style.md"],
  [/\bissues\b/i, "issues.md"],
];
const DEFAULT_TARGET_FILE = "decisions.md";

/** INDEX term plus the structural file its line maps to. */
interface IndexTerm {
  readonly term: string;
  readonly file: string;
}

/** Leftmost stem match on the line; ties (same index) resolve in list order. */
function targetForLine(line: string): string {
  let best: { index: number; file: string } | undefined;
  for (const [pattern, file] of TARGET_FILES) {
    const match = pattern.exec(line);
    if (match !== null && (best === undefined || match.index < best.index)) {
      best = { index: match.index, file };
    }
  }
  return best?.file ?? DEFAULT_TARGET_FILE;
}

/**
 * Candidate INDEX terms in INDEX order: alphanumeric compounds (hyphen-,
 * dot-, and slash-joined symbols stay whole), ≥4 chars, de-duplicated
 * case-insensitively (the first occurrence's target file wins), stopwords
 * dropped. Each term carries the structural file of its line (leftmost stem;
 * default `decisions.md`). Pure, never throws.
 */
function indexTerms(index: string): IndexTerm[] {
  try {
    const terms: IndexTerm[] = [];
    const seen = new Set<string>();
    for (const line of index.split("\n")) {
      const stripped = line
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/^\s*#{1,6}\s+.*$/, " ");
      const file = targetForLine(stripped);
      for (const match of stripped.matchAll(TERM_PATTERN)) {
        const term = match[0];
        if (term.length < 4 || term.length > 80 || /^\d+$/.test(term)) continue;
        const lower = term.toLowerCase();
        if (STOPWORDS.has(lower) || seen.has(lower)) continue;
        seen.add(lower);
        terms.push({ term, file });
      }
    }
    return terms;
  } catch {
    return [];
  }
}

/**
 * First INDEX term with an exact (case-insensitive whole-word) hit in the
 * user text, in INDEX order — or `undefined`. No stemming, no fuzzy match.
 */
function exactTermHit(text: string, index: string): IndexTerm | undefined {
  try {
    for (const term of indexTerms(index)) {
      if (new RegExp(`\\b${escapeRegExp(term.term)}\\b`, "i").test(text)) {
        return term;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * At most one `[memory-hint]` line for an exact INDEX match against the
 * latest user-authored text, or `undefined` (no text, no INDEX, no exact
 * hit, or this prompt already hinted). The call target is the structural
 * file of the matched line (leftmost stem; default `decisions.md`).
 * Records the once-per-prompt throttle on a hit. Async, never throws.
 */
export async function matchIndex(
  input: unknown,
  options: MatchIndexOptions,
): Promise<string | undefined> {
  try {
    if (!options || !options.storage) return undefined;
    const text = extractLatestUserText(input);
    if (text === undefined) return undefined;
    let index = options.indexContent;
    if (index === undefined) {
      try {
        const cap =
          Number.isInteger(options.indexLines) && (options.indexLines ?? 0) > 0
            ? options.indexLines!
            : DEFAULT_MEMORY_OPTIONS.indexLines;
        const loaded = await readContainedLines("INDEX.md", {
          memoryRoot: options.memoryRoot,
          maxLines: cap + 1,
          maxBytes: 1_048_576,
        });
        if (
          loaded === undefined ||
          loaded.truncated ||
          loaded.lines.length > cap
        ) {
          return undefined;
        }
        index = redact(loaded.lines.join("\n"));
      } catch {
        return undefined;
      }
    }
    if (typeof index !== "string" || index.trim().length === 0) {
      return undefined;
    }
    const hit = exactTermHit(text, index);
    if (hit === undefined) return undefined;
    const promptHash = options.promptHash ?? promptHashFor(text);
    if (
      !(await claimHint(
        options.storage,
        options.projectID,
        options.sessionID,
        promptHash,
        options.now,
      ))
    ) {
      return undefined;
    }
    return `[memory-hint] Past decisions mention \`${hit.term}\`. Call memory_recall("${hit.file}") for the why.`;
  } catch {
    return undefined;
  }
}

/**
 * Fixed one-line nudge for a directive-shaped `remember` miss (E11). It
 * explains the documented forms; it never records anything and never names a
 * memory file to recall, so the prompt hook must not arm the hint→recall
 * correlation for it.
 */
export const REMEMBER_NEAR_MISS_HINT =
  "[memory-hint] Nothing was recorded — start a line with `remember:` or `remember that` to save a fact to decisions.md.";

/**
 * At most one near-miss nudge for the latest user text, or `undefined`.
 * Shares the exact prompt-hash throttle key with `matchIndex`, so the two
 * hint kinds cannot both fire for one prompt. Async, never throws.
 */
export async function matchRememberNearMiss(
  input: unknown,
  options: MatchIndexOptions,
): Promise<string | undefined> {
  try {
    if (!options || !options.storage) return undefined;
    const text = extractLatestUserText(input);
    if (text === undefined || !isRememberNearMiss(text)) return undefined;
    const promptHash = options.promptHash ?? promptHashFor(text);
    if (
      !(await claimHint(
        options.storage,
        options.projectID,
        options.sessionID,
        promptHash,
        options.now,
      ))
    ) {
      return undefined;
    }
    return REMEMBER_NEAR_MISS_HINT;
  } catch {
    return undefined;
  }
}
