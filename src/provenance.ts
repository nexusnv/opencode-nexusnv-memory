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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LedgerStorage } from "./capture.js";
import { hasSeen, markSeen } from "./capture.js";
import { resolveMemoryRoot, withWriteLock } from "./files.js";
import { redact } from "./redact.js";

/** Provenance classes; the tag follows content into review and storage. */
export type Provenance = "user" | "tool" | "model" | "snapshot";

const REMEMBER_COLON = /^\s*remember\s*:\s*(\S.*)$/i;
const REMEMBER_THAT = /^\s*remember\s+that\b\s*(\S.*)$/i;
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

/** Directive fact(s) from one visible line, or `undefined` when no match. */
function directiveFact(line: string): string | undefined {
  const stripped = line.replace(INLINE_CODE, "");
  return (
    stripped.match(REMEMBER_COLON)?.[1]?.trim() ||
    stripped.match(REMEMBER_THAT)?.[1]?.trim() ||
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

async function readRaw(root: string, file: string): Promise<string> {
  try {
    return await readFile(join(root, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
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
    if (await hasSeen(deps.storage, deps.projectID, contentID)) return false;

    const root = resolveMemoryRoot(deps.memoryRoot);
    const current = await readRaw(root, "decisions.md");
    const entry = `- ${fact} (user-asserted) source:user`;
    const next =
      current.length === 0
        ? `${entry}\n`
        : current.endsWith("\n")
          ? `${current}${entry}\n`
          : `${current}\n${entry}\n`;
    // decisions.md is append-only and unbounded: plain serialized write
    // (no cap/rotation path applies).
    await withWriteLock(async () => {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "decisions.md"), redact(next), "utf8");
    });
    await markSeen(deps.storage, deps.projectID, contentID, deps.now);
    return true;
  } catch (error) {
    try {
      log(error);
    } catch {
      // Logging must never break the prompt hook.
    }
    return false;
  }
}
