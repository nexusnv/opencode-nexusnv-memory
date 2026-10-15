/**
 * Ledger + storage adapter (spec §5.7 + c4-05).
 *
 * Restart-safe idempotency over `ctx.storage` (plugin-scoped, so every key is
 * namespaced per project: `<projectID>/…` where `<projectID>` is
 * `ctx.location.project.id`). No compare-and-set exists, so check-before-write
 * goes through `get`, concurrent `markSeen` calls for one content ID share a
 * single-flight promise, and all writes serialize via the `withWriteLock`
 * mutex. A duplicate that still slips through is benign (idempotent append).
 *
 * Ledger helpers only — `captureFailure`/`snapshotHandoffIfChanged` land in
 * later tasks (T4/T8) on top of these primitives.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import { resolveMemoryRoot, withWriteLock, writeCapped, type CappedFileOptions } from "./files.js";
import { flagInjection } from "./guard.js";
import { redact } from "./redact.js";

/**
 * Minimum surface of `ctx.storage` the ledger needs. Method shorthand keeps
 * this bivariant so both the real `ctx.storage` and test fakes satisfy it.
 */
export interface LedgerStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit?: number;
  }): Promise<{
    readonly entries: ReadonlyArray<{
      readonly key: string;
      readonly value: unknown;
    }>;
    readonly next?: string;
  }>;
}

/** Max `seen` entries; pruning evicts oldest-first down to this. */
export const SEEN_LIMIT = 500;

/** Retry window for a failed capture attempt (~30s via the attempt key). */
export const RETRY_WINDOW_MS = 30_000;

/** In-flight `markSeen` writes keyed by full storage key (single-flight). */
const inflight = new Map<string, Promise<boolean>>();

/** Test seam: drop single-flight state between isolated suites. */
export function resetLedgerSingleFlightForTests(): void {
  inflight.clear();
}

function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[memory] ledger ${name} must be a non-empty string`);
  }
  return value;
}

function projectPrefix(projectID: string): string {
  return `${requireNonEmpty("projectID", projectID)}/`;
}

/** `<projectID>/seen/<contentID>` → first-seen timestamp. */
export function seenKey(projectID: string, contentID: string): string {
  return `${projectPrefix(projectID)}seen/${requireNonEmpty("contentID", contentID)}`;
}

/** `<projectID>/attempt/<contentID>` → last attempt timestamp. */
export function attemptKey(projectID: string, contentID: string): string {
  return `${projectPrefix(projectID)}attempt/${requireNonEmpty("contentID", contentID)}`;
}

/** `<projectID>/curation.pending` → uncurated scratchpad count. */
export function pendingKey(projectID: string): string {
  return `${projectPrefix(projectID)}curation.pending`;
}

/** `<projectID>/curation.rotated` → transient rotation marker (count). */
export function rotatedKey(projectID: string): string {
  return `${projectPrefix(projectID)}curation.rotated`;
}

/** `<projectID>/snapshot/<sessionID>` → last snapshot content hash. */
export function snapshotKey(projectID: string, sessionID: string): string {
  return `${projectPrefix(projectID)}snapshot/${requireNonEmpty("sessionID", sessionID)}`;
}

/** `<projectID>/snapshotThrottle/<sessionID>` → last fallback-snapshot time. */
export function throttleKey(projectID: string, sessionID: string): string {
  return `${projectPrefix(projectID)}snapshotThrottle/${requireNonEmpty("sessionID", sessionID)}`;
}

/** `<projectID>/hint/<sessionID>/<promptHash>` → once-per-prompt throttle. */
export function hintKey(
  projectID: string,
  sessionID: string,
  promptHash: string,
): string {
  return `${projectPrefix(projectID)}hint/${requireNonEmpty("sessionID", sessionID)}/${requireNonEmpty("promptHash", promptHash)}`;
}

/** True when the content ID was already recorded (check-before-write read). */
export async function hasSeen(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
): Promise<boolean> {
  return (await storage.get(seenKey(projectID, contentID))) != null;
}

/**
 * Record a content ID. Resolves `true` when newly recorded (caller proceeds),
 * `false` on replay. Concurrent calls for one ID share a single storage
 * write; every write runs under the mutex.
 */
export function markSeen(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = seenKey(projectID, contentID);
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = withWriteLock(async () => {
    if ((await storage.get(key)) != null) return false;
    await storage.set(key, now);
    return true;
  });
  inflight.set(key, run);
  const cleanup = (): void => {
    if (inflight.get(key) === run) inflight.delete(key);
  };
  run.then(cleanup, cleanup);
  return run;
}

/**
 * True when a capture for the content ID may (re)try: no attempt yet, or the
 * last attempt is inside the ~30s window. Older attempts are abandoned.
 */
export async function shouldRetry(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<boolean> {
  const last = await storage.get(attemptKey(projectID, contentID));
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last <= RETRY_WINDOW_MS;
}

/** Record a capture attempt timestamp. */
export async function markAttempt(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(attemptKey(projectID, contentID), now);
  });
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Uncurated scratchpad captures since the last apply (0 when unset). */
export async function getPending(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  return asCount(await storage.get(pendingKey(projectID)));
}

/** Increment the pending count (read-modify-write under the mutex). */
export async function incPending(
  storage: LedgerStorage,
  projectID: string,
  by = 1,
): Promise<number> {
  if (!Number.isInteger(by) || by <= 0) {
    throw new Error("[memory] ledger incPending delta must be a positive int");
  }
  return withWriteLock(async () => {
    const next = asCount(await storage.get(pendingKey(projectID))) + by;
    await storage.set(pendingKey(projectID), next);
    return next;
  });
}

/** Reset pending to 0 (memory_apply completion, incl. empty candidates). */
export async function resetPending(
  storage: LedgerStorage,
  projectID: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(pendingKey(projectID), 0);
  });
}

/** Rotation marker count, or `undefined` when no rotation is pending. */
export async function getRotated(
  storage: LedgerStorage,
  projectID: string,
): Promise<number | undefined> {
  const value = await storage.get(rotatedKey(projectID));
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Record how many blocks rotated out of `activeContext.md`. */
export async function setRotated(
  storage: LedgerStorage,
  projectID: string,
  count: number,
): Promise<void> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("[memory] ledger rotated count must be a positive int");
  }
  await withWriteLock(async () => {
    await storage.set(rotatedKey(projectID), count);
  });
}

/** Clear the rotation marker after `statusLine()` reports it. */
export async function clearRotated(
  storage: LedgerStorage,
  projectID: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.remove(rotatedKey(projectID));
  });
}

/** Last snapshot content hash for the session, if any. */
export async function getSnapshotHash(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<string | undefined> {
  const value = await storage.get(snapshotKey(projectID, sessionID));
  return typeof value === "string" ? value : undefined;
}

/** Persist the snapshot content hash for hash-guarded idempotency. */
export async function setSnapshotHash(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  hash: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(snapshotKey(projectID, sessionID), hash);
  });
}

/** Last fallback-snapshot timestamp for the session, if any. */
export async function getThrottle(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<number | undefined> {
  const value = await storage.get(throttleKey(projectID, sessionID));
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Persist the fallback-snapshot timestamp for the session. */
export async function setThrottle(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(throttleKey(projectID, sessionID), now);
  });
}

/** True when the hint for this prompt was already emitted. */
export async function hasHint(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  promptHash: string,
): Promise<boolean> {
  return (await storage.get(hintKey(projectID, sessionID, promptHash))) != null;
}

/** Record that the hint for this prompt was emitted. */
export async function setHint(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  promptHash: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(hintKey(projectID, sessionID, promptHash), now);
  });
}

/**
 * Bound the `seen` set to `SEEN_LIMIT` entries: paginate `scan` via
 * `after`/`next` over `<projectID>/seen/`, evict oldest-first by stored
 * timestamp (missing/non-numeric = oldest, key order breaks ties), and remove
 * only this project's `seen` keys. Resolves the number of entries removed.
 */
export async function pruneSeenTo500(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  const prefix = `${projectPrefix(projectID)}seen/`;
  const all: Array<{ key: string; seenAt: number }> = [];
  let after: string | undefined;
  for (;;) {
    const page =
      after === undefined
        ? await storage.scan({ prefix })
        : await storage.scan({ prefix, after });
    for (const entry of page.entries) {
      all.push({
        key: entry.key,
        seenAt:
          typeof entry.value === "number" && Number.isFinite(entry.value)
            ? entry.value
            : 0,
      });
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  const overflow = all.length - SEEN_LIMIT;
  if (overflow <= 0) return 0;
  all.sort((a, b) =>
    a.seenAt === b.seenAt
      ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      : a.seenAt - b.seenAt,
  );
  const victims = all.slice(0, overflow);
  await withWriteLock(async () => {
    for (const victim of victims) {
      await storage.remove(victim.key);
    }
  });
  return victims.length;
}

/* ------------------------------------------------------------------ */
/* captureFailure (spec §5.3 + c4-04 tool-hook contract, G4 baseline)  */
/* ------------------------------------------------------------------ */

/** Max chars of the message-derived summary line (spec §5.2). */
export const FAILURE_SUMMARY_CHARS = 120;

/** Max recall-only detail lines, written only when the event carries output. */
export const FAILURE_DETAIL_LINES = 20;

const KNOWN_ERRORS_HEADING_LINE = "## Known errors";

const ACTIVE_CONTEXT_SCAFFOLD = `# Active context — current slice (append-until-60, then rotate)

## Goal
- (what this session is trying to do)

## Pending
- (open items)

## Next
- (immediate next steps)

## Known errors
`;

const METADATA_OUTPUT_KEYS = [
  "output",
  "stdout",
  "stderr",
  "text",
  "body",
  "logs",
  "log",
  "outputText",
  "detail",
] as const;

export type CaptureReason =
  | "captured"
  | "duplicate"
  | "skipped"
  | "retry-later"
  | "failed";

export interface CaptureOutcome {
  readonly reason: CaptureReason;
  readonly contentID?: string;
}

export interface CaptureFailureOptions extends CappedFileOptions {
  readonly now?: number;
  readonly log?: (error: unknown) => void;
}

/** Collapse whitespace/newlines and cap at `FAILURE_SUMMARY_CHARS`. */
function summaryLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "unknown error";
  return collapsed.slice(0, FAILURE_SUMMARY_CHARS);
}

/**
 * Best-effort `<cmd>` from untyped `event.input` (shell-tool-dependent;
 * G4 never assumes it). Returns `undefined` when nothing yields a command.
 */
function commandOf(input: unknown): string | undefined {
  try {
    if (typeof input !== "object" || input === null) {
      return typeof input === "string" && input.trim().length > 0
        ? input.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 60)
        : undefined;
    }
    const record = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "tool"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const cmd = value
          .split("\n")[0]!
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        if (cmd.length > 0) return cmd;
      }
    }
    const args = record["args"];
    if (
      Array.isArray(args) &&
      args.every((a) => typeof a === "string") &&
      args.length > 0
    ) {
      const cmd = (args as string[])
        .join(" ")
        .split("\n")[0]!
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (cmd.length > 0) return cmd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Optional recall-only detail: the sole candidate source is untyped
 * `error.metadata` inspection — never assumed present. Returns at most the
 * last `FAILURE_DETAIL_LINES` lines, or `undefined` when no output is found.
 */
function detailOf(metadata: unknown): string[] | undefined {
  try {
    let output: string | undefined;
    if (typeof metadata === "string") {
      output = metadata;
    } else if (typeof metadata === "object" && metadata !== null) {
      const record = metadata as Record<string, unknown>;
      for (const key of METADATA_OUTPUT_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          output = value;
          break;
        }
      }
      if (output === undefined) {
        for (const value of Object.values(record)) {
          if (typeof value === "string" && value.trim().length > 0) {
            output = value;
            break;
          }
        }
      }
    }
    if (output === undefined || output.trim().length === 0) return undefined;
    const lines = output.split("\n");
    return lines.slice(-FAILURE_DETAIL_LINES);
  } catch {
    return undefined;
  }
}

/** Stable content ID over the redacted summary + detail. */
export function failureContentID(summary: string, detail: string): string {
  return createHash("sha256")
    .update(`${summary}\n${detail}`, "utf8")
    .digest("hex");
}

async function readRawActiveContext(root: string): Promise<string> {
  try {
    return await readFile(join(root, "activeContext.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

async function listArchive(root: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(join(root, "handoffs", "archive")));
  } catch {
    return new Set();
  }
}

/**
 * Failure-only capture for the `execute.after` tool hook (spec §5.3).
 *
 * Builds a `source:tool` message-derived summary line (`error.message`
 * first line, ≤120 chars) with a `<cmd>:` prefix only when untyped
 * `event.input` yields one, plus an optional ≤20-line recall-only detail
 * block only when `error.metadata` carries output. Redacts, ledger-dedupes
 * by stable content ID (~30s retry), appends under Known Errors via
 * `writeCapped`, marks seen + attempt, increments scratchpad-only pending,
 * and sets the rotated marker when the append rotated. Advisory
 * `flagInjection` flags travel with the entry. Never throws.
 */
export async function captureFailure(
  event: unknown,
  storage: LedgerStorage,
  projectID: string,
  memoryRoot?: string,
  options?: CaptureFailureOptions,
): Promise<CaptureOutcome> {
  const log = options?.log ?? (() => undefined);
  const fail = (error: unknown): CaptureOutcome => {
    try {
      log(error);
    } catch {
      // Logging must never break the tool hook.
    }
    return { reason: "failed" };
  };
  try {
    if (typeof event !== "object" || event === null) {
      return { reason: "skipped" };
    }
    const record = event as Record<string, unknown>;
    const status = record["status"];
    const errorValue = record["error"];
    // Failures only: prefer `status`, fall back to `error != null` (G4).
    if (status !== undefined) {
      if (status !== "error") return { reason: "skipped" };
    } else if (errorValue === null || errorValue === undefined) {
      return { reason: "skipped" };
    }

    const errorRecord =
      typeof errorValue === "object" && errorValue !== null
        ? (errorValue as Record<string, unknown>)
        : undefined;
    const rawMessage =
      typeof errorRecord?.["message"] === "string"
        ? (errorRecord["message"] as string)
        : typeof errorValue === "string"
          ? errorValue
          : "unknown error";
    const messageFirst = rawMessage.split("\n")[0] ?? "";
    const cmd = commandOf(record["input"]);
    const summary = summaryLine(
      cmd !== undefined ? `${cmd}: ${messageFirst}` : messageFirst,
    );
    const detailLines = detailOf(errorRecord?.["metadata"]);
    const detail = detailLines?.join("\n") ?? "";

    const redactedSummary = redact(summary);
    const redactedDetail = redact(detail);
    const contentID = failureContentID(redactedSummary, redactedDetail);

    if (await hasSeen(storage, projectID, contentID)) {
      return { reason: "duplicate", contentID };
    }
    if (!(await shouldRetry(storage, projectID, contentID, options?.now))) {
      return { reason: "retry-later", contentID };
    }
    await markAttempt(storage, projectID, contentID, options?.now);

    const flags = flagInjection(`${redactedSummary}\n${redactedDetail}`);
    const block: string[] = [`- ${redactedSummary} source:tool`];
    if (redactedDetail.length > 0) {
      for (const line of redactedDetail.split("\n")) block.push(`  ${line}`);
    }
    if (flags.length > 0) {
      block.push(`  <!-- flags: ${flags.join(", ")} (advisory) -->`);
    }
    const entry = `${block.join("\n")}\n`;

    const root = resolveMemoryRoot(memoryRoot);
    const current = await readRawActiveContext(root);
    let next: string;
    if (current.length === 0) {
      next = `${ACTIVE_CONTEXT_SCAFFOLD}${entry}`;
    } else {
      const withNewline = current.endsWith("\n") ? current : `${current}\n`;
      next = /^##\s+known errors\s*$/im.test(current)
        ? `${withNewline}${entry}`
        : `${withNewline}\n${KNOWN_ERRORS_HEADING_LINE}\n${entry}`;
    }

    const before = await listArchive(root);
    await writeCapped("activeContext.md", next, {
      memoryRoot,
      fileLines: options?.fileLines,
      indexLines: options?.indexLines,
    });
    await markSeen(storage, projectID, contentID, options?.now);
    await incPending(storage, projectID);

    // Rotation marker for the status line: a fresh archive file means this
    // append rotated the oldest Known-Errors block(s) out.
    try {
      const after = await listArchive(root);
      const fresh = [...after].filter((name) => !before.has(name));
      if (fresh.length > 0) {
        let blocks = 0;
        for (const name of fresh) {
          try {
            const archived = await readFile(
              join(root, "handoffs", "archive", name),
              "utf8",
            );
            blocks += archived
              .split("\n")
              .filter((line) => /^\s*-\s+/.test(line)).length;
          } catch {
            // Fall through to the file-count fallback below.
          }
        }
        await setRotated(storage, projectID, blocks > 0 ? blocks : fresh.length);
      }
    } catch {
      // Rotation reporting is best-effort; the capture already landed.
    }
    return { reason: "captured", contentID };
  } catch (error) {
    return fail(error);
  }
}

/* ------------------------------------------------------------------ */
/* snapshotIfDue — context-hook throttle gate (stub; T8 fleshes out)  */
/* ------------------------------------------------------------------ */

export interface SnapshotIfDueOptions {
  readonly now?: number;
  readonly throttleMinutes?: number;
}

/**
 * Context-hook snapshot throttle gate (interim stub; T8 implements the
 * `snapshotHandoffIfChanged` write behind it).
 *
 * Resolves `false` without writing a handoff. When the per-session
 * throttle window has elapsed it records the throttle slot
 * (`<projectID>/snapshotThrottle/<sessionID>`) so concurrent continuations
 * share one slot; calls inside the window are no-ops. Never throws.
 */
export async function snapshotIfDue(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  options?: SnapshotIfDueOptions,
): Promise<boolean> {
  try {
    const now = options?.now ?? Date.now();
    const minutes =
      options?.throttleMinutes ??
      DEFAULT_MEMORY_OPTIONS.snapshotThrottleMinutes;
    const windowMs =
      Number.isInteger(minutes) && minutes > 0 ? minutes * 60_000 : 0;
    const last = await getThrottle(storage, projectID, sessionID);
    if (last !== undefined && now - last < windowMs) return false;
    await setThrottle(storage, projectID, sessionID, now);
    return false;
  } catch {
    return false;
  }
}
