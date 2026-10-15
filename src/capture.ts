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
import { withWriteLock } from "./files.js";

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
