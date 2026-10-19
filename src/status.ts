/**
 * `[memory]` status line (spec §§5.2, 5.7 + c4-06-code).
 *
 * `statusLine` resolves to at most one `[memory]` line or `undefined`,
 * reading only counters/markers in `ctx.storage` (never the filesystem).
 * Three fixed-threshold facts share the line, joined with `; `: the
 * over-cap INDEX notice (re-set on prompt admission while the condition
 * persists; the `<projectID>/notice.indexOverCap` marker carries the actual
 * line count and is cleared after reporting), the rotation notice (once —
 * the `<projectID>/curation.rotated` marker is cleared after reporting;
 * concurrent `context` calls may double-emit once, which is benign) and the
 * review-due nudge (while scratchpad-only `<projectID>/curation.pending` is
 * ≥5). Under budget pressure the caller drops this line before the hint
 * line. Async, never throws.
 */
import {
  clearNotice,
  clearRotated,
  getNotice,
  getPending,
  getRotated,
  type LedgerStorage,
} from "./capture.js";
import { redact } from "./redact.js";

/** Uncurated scratchpad captures that trigger the review-due nudge. */
export const REVIEW_DUE_PENDING = 5;

export interface StatusLineOptions {
  /** INDEX cap in lines; included in the over-cap notice when provided. */
  readonly indexLines?: number;
}

/**
 * At most one `[memory]` status line, or `undefined` when there is nothing
 * to report. Async, never throws.
 */
export async function statusLine(
  storage: LedgerStorage,
  projectID: string,
  options?: StatusLineOptions,
): Promise<string | undefined> {
  try {
    const facts: string[] = [];
    const overCap = await getNotice(storage, projectID, "indexOverCap");
    if (overCap !== undefined) {
      facts.push(
        options?.indexLines !== undefined
          ? `INDEX.md is ${overCap} lines (cap ${options.indexLines}); not attached — trim it to restore auto-injection`
          : `INDEX.md is ${overCap} lines (over cap); not attached — trim it to restore auto-injection`,
      );
      try {
        await clearNotice(storage, projectID, "indexOverCap");
      } catch {
        // Best-effort: a failed clear re-emits once next turn (benign).
      }
    }
    const rotated = await getRotated(storage, projectID);
    if (rotated !== undefined) {
      facts.push(
        `rotated ${rotated} block(s) to handoffs/archive/ (still recallable via memory_recall)`,
      );
      try {
        await clearRotated(storage, projectID);
      } catch {
        // Best-effort: a failed clear re-emits once next turn (benign).
      }
    }
    const pending = await getPending(storage, projectID);
    if (pending >= REVIEW_DUE_PENDING) {
      facts.push(
        `${pending} uncurated captures since last review; run /memory-review`,
      );
    }
    if (facts.length === 0) return undefined;
    const line = redact(`[memory] ${facts.join("; ")}`)
      .replace(/\s*\n+\s*/g, " ")
      .trim();
    return line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}
