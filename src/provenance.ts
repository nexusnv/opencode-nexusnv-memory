/**
 * Provenance gate (spec §§5.3, 5.11 + c4-04 provenance contract).
 *
 * `classifyProvenance` is pure detection: `user` only for an explicit
 * `remember:` / `remember that` line-start directive in the user's own turn,
 * outside code fences and quotations (pastes are covered only by that
 * fence/quote heuristic). Everything ambiguous defaults to `tool`; callers
 * map tool output / model prose / snapshots to the non-user class.
 *
 * `rememberAsserted` is the prompt-hook write site: redact, ledger-dedup,
 * append to append-only `decisions.md` tagged `(user-asserted)`, never
 * incrementing `curation.pending`, never targeting rule files, serialized via
 * the choke-point writer, never throwing (a throwing prompt hook blocks
 * admission).
 */
import { createHash } from "node:crypto";
import type { LedgerStorage } from "./capture.js";
import { hasSeen, markSeen } from "./capture.js";
import { updateCapped } from "./files.js";
import { redact } from "./redact.js";

/** Provenance classes; the tag follows content into review and storage. */
export type Provenance = "user" | "tool" | "model" | "snapshot";

const REMEMBER_COLON = /^\s*remember\s*:\s*(\S.*)$/i;
const REMEMBER_THAT = /^\s*remember\s+that\b\s*(\S.*)$/i;
// Prefix-only forms: recognize the directive even when stripping inline code
// leaves no fact text (e.g. `remember: `foo`` strips to a bare prefix).
const REMEMBER_COLON_PREFIX = /^\s*remember\s*:\s*/i;
const REMEMBER_THAT_PREFIX = /^\s*remember\s+that\b/i;
const FENCE_TOGGLE = /^\s*(`{3,}|~{3,})/;
const BLOCKQUOTE = /^\s*>/;
const INLINE_CODE = /`[^`\n]*`/g;

/** Lines visible to directive detection (fences + blockquotes removed). */
function visibleLines(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE_TOGGLE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (BLOCKQUOTE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/** Directive fact(s) from one visible line, or `undefined` when no match.
 * Detection runs on the inline-code-stripped line (so `` `remember: x` ``
 * does not trigger), but the fact is extracted from the original line so
 * ``remember: `foo` bar`` keeps `` `foo` `` instead of dropping it (L-5).
 * The prefix check accepts an inline-code-only fact (stripped to a bare
 * prefix); extraction from the original line still recovers `` `foo` ``. */
function directiveFact(line: string): string | undefined {
  const stripped = line.replace(INLINE_CODE, "");
  const onStripped =
    stripped.match(REMEMBER_COLON)?.[1]?.trim() !== undefined ||
    stripped.match(REMEMBER_THAT)?.[1]?.trim() !== undefined ||
    REMEMBER_COLON_PREFIX.test(stripped) ||
    REMEMBER_THAT_PREFIX.test(stripped);
  if (!onStripped) return undefined;
  return (
    line.match(REMEMBER_COLON)?.[1]?.trim() ||
    line.match(REMEMBER_THAT)?.[1]?.trim() ||
    undefined
  );
}

/**
 * Classify `text` by provenance. Pure, synchronous, never throws.
 * `user` requires a line-start `remember:` / `remember that` directive
 * outside fences/quotations; anything else (ambiguous, tool output, model
 * prose, snapshots) returns `tool` and the caller refines the non-user class.
 */
export function classifyProvenance(text: unknown): Provenance {
  try {
    if (typeof text !== "string" || text.length === 0) return "tool";
    for (const line of visibleLines(text)) {
      if (directiveFact(line) !== undefined) return "user";
    }
    return "tool";
  } catch {
    return "tool";
  }
}

/** All user-asserted facts in `text` (visible lines only), outermost first. */
export function extractAssertedFacts(text: string): string[] {
  const facts: string[] = [];
  for (const line of visibleLines(text)) {
    const fact = directiveFact(line);
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

const NEAR_MISS_PREFIX =
  /^(?:please\s+|kindly\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)?remember\b(.*)$/i;
const NARRATIVE_AFTER_REMEMBER =
  /^\s*(?:when|how|what|where|who|why)\b/i;

/**
 * True when `text` looks like a memory request but is not one of the
 * documented line-start `remember:` / `remember that` forms. This is pure
 * detection for the context-hook nudge: it never writes memory.
 *
 * Requires: no valid directive fact anywhere in the visible text; a visible
 * (non-fenced, non-blockquoted) line whose inline-code-stripped form starts
 * with an optional politeness prefix + `remember`; and a remainder that does
 * not start with a narrative wh-word (`remember when…`, `remember how…`).
 * Thus `Please remember: X`, `remember X`, and bare `remember:` nudge, while
 * valid directives, `I remember…`, `we should remember…`, and fenced/quoted
 * text do not. Never throws.
 */
export function isRememberNearMiss(text: unknown): boolean {
  try {
    if (typeof text !== "string" || text.length === 0) return false;
    if (extractAssertedFacts(text).length > 0) return false;
    for (const line of visibleLines(text)) {
      const stripped = line.replace(INLINE_CODE, "").trim();
      const match = stripped.match(NEAR_MISS_PREFIX);
      if (match === null) continue;
      if (NARRATIVE_AFTER_REMEMBER.test(match[1] ?? "")) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Stable content ID for a redacted user-asserted fact. */
export function assertedContentID(fact: string): string {
  return createHash("sha256").update(`user-asserted\n${fact}`, "utf8").digest(
    "hex",
  );
}

export interface RememberAssertedDeps {
  readonly storage: LedgerStorage;
  readonly projectID: string;
  /** Absolute path to `.opencode/memory`. Defaults to `<cwd>/.opencode/memory`. */
  readonly memoryRoot?: string;
  readonly now?: number;
  readonly log?: (error: unknown) => void;
}

function extractPromptText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const prompt = record["prompt"];
  if (typeof prompt === "object" && prompt !== null) {
    const text = (prompt as Record<string, unknown>)["text"];
    if (typeof text === "string") return text;
  }
  const text = record["text"];
  return typeof text === "string" ? text : undefined;
}

/** In-process single-flight for user-asserted facts (same pattern as the
 * ledger `inflight` map): concurrent admissions of one fact converge on a
 * single append. Keyed by projectID + contentID (M-3): same fact text in two
 * projects must append to both roots. The persisted `hasSeen` check remains
 * the cross-restart dedupe; this set only closes the same-process
 * check-then-act race. */
const assertedInflight = new Set<string>();

function assertedFlightKey(projectID: string, contentID: string): string {
  return `${projectID}\0${contentID}`;
}

/** Test seam: drop asserted single-flight state between isolated suites. */
export function resetAssertedSingleFlightForTests(): void {
  assertedInflight.clear();
}

/**
 * Append a `source:user` directive to `decisions.md` (the prompt-hook fast
 * path). Resolves `true` when appended, `false` on no-op (ambiguous text,
 * replay, empty fact). Redacts, ledger-dedupes by content ID, never
 * increments `curation.pending`, never targets rule files, never throws.
 */
export async function rememberAsserted(
  input: unknown,
  deps: RememberAssertedDeps,
): Promise<boolean> {
  const log = deps.log ?? (() => undefined);
  try {
    const text = extractPromptText(input);
    if (text === undefined || classifyProvenance(text) !== "user") {
      return false;
    }
    const fact = redact(extractAssertedFacts(text).join("; ")).trim();
    if (fact.length === 0) return false;
    const contentID = assertedContentID(fact);
    const entry = `- ${fact} (user-asserted) source:user`;

    // Same-process single-flight first: concurrent admissions of one fact
    // converge here without touching storage.
    const flightKey = assertedFlightKey(deps.projectID, contentID);
    if (assertedInflight.has(flightKey)) return false;
    assertedInflight.add(flightKey);
    try {
      if (await hasSeen(deps.storage, deps.projectID, contentID)) return false;

      // Shared choke-point append: `decisions.md` is allowlisted and
      // unbounded (append-only by design), so this is the same write
      // contract as every other memory file — atomic read-modify-write
      // inside the lock, so a concurrent append of a *different* fact
      // cannot be silently dropped. The ledger calls stay outside the
      // lock: they take the same mutex internally and must never nest.
      await updateCapped(
        "decisions.md",
        { memoryRoot: deps.memoryRoot },
        (current) =>
          current.length === 0
            ? `${entry}\n`
            : current.endsWith("\n")
              ? `${current}${entry}\n`
              : `${current}\n${entry}\n`,
      );
      await markSeen(deps.storage, deps.projectID, contentID, deps.now);
      return true;
    } finally {
      assertedInflight.delete(assertedFlightKey(deps.projectID, contentID));
    }
  } catch (error) {
    try {
      log(error);
    } catch {
      // Logging must never break the prompt hook.
    }
    return false;
  }
}
