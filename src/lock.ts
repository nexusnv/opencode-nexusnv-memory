/**
 * Same-host cross-process write lock for `.opencode/memory` (E14).
 *
 * Protocol: exclusive-create `<root>/.write.lock`, write `<pid>\n`, bounded
 * wait; when the recorded PID is gone, create `<root>/.write.lock.claim` with
 * `wx`, re-read the lock, re-probe, remove only the same stale record, remove
 * the claim, and retry. The lock is not a memory file and is not allowlisted.
 *
 * Supported contract: one host, one PID namespace, a local filesystem. NFS,
 * containers sharing a volume, multi-host use, and PID reuse are not made safe
 * by this protocol. No fsync is performed; the target is atomic visibility.
 */
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WRITE_LOCK_FILE = ".write.lock";
export const WRITE_LOCK_CLAIM_FILE = ".write.lock.claim";
export const WRITE_LOCK_TIMEOUT_MS = 5_000;
export const WRITE_LOCK_POLL_MS = 25;
export const MALFORMED_LOCK_GRACE_MS = 2_000;

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly malformedGraceMs?: number;
}

interface LockRecord {
  readonly text: string;
  readonly pid?: number;
  readonly mtimeMs?: number;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** True when `pid` names a live process in this PID namespace. Pure-ish. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by us.
    return codeOf(error) === "EPERM";
  }
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  try {
    const [text, info] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    const first = text.split("\n", 1)[0]?.trim() ?? "";
    const parsed = /^\d+$/.test(first) ? Number.parseInt(first, 10) : NaN;
    const pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    return { text, pid, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function createExclusive(path: string, pid: number): Promise<boolean> {
  try {
    await writeFile(path, `${pid}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  }
}

async function removeIfOwned(path: string, pid: number): Promise<void> {
  const record = await readRecord(path);
  if (record === undefined || record.pid !== pid) return;
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function isStale(
  record: LockRecord,
  options: {
    readonly now: number;
    readonly isAlive: (pid: number) => boolean;
    readonly malformedGraceMs: number;
  },
): boolean {
  if (record.pid !== undefined) return !options.isAlive(record.pid);
  return (
    record.mtimeMs !== undefined &&
    options.now - record.mtimeMs >= options.malformedGraceMs
  );
}

async function removeIfStale(
  path: string,
  seen: LockRecord,
  options: {
    readonly now: number;
    readonly isAlive: (pid: number) => boolean;
    readonly malformedGraceMs: number;
  },
): Promise<void> {
  const current = await readRecord(path);
  if (current === undefined || current.text !== seen.text) return;
  if (!isStale(current, options)) return;
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function timeoutError(path: string, record: LockRecord | undefined): Error {
  const holder =
    record?.pid !== undefined
      ? `pid ${record.pid}`
      : "an unreadable lock record";
  return new Error(
    `[memory] another OpenCode process is writing memory (${path}; ${holder}); ` +
      "retry after it finishes; if no process is writing, delete the lock file",
  );
}

/**
 * Acquire the root write lock. Resolves a release function; the caller must
 * release in `finally`. A missing root is created. Bounded wait; a live holder
 * produces a clear timeout instead of a silent dropped write.
 */
export async function acquireWriteLock(
  root: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const pid = options.pid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? WRITE_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WRITE_LOCK_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.isAlive ?? isProcessAlive;
  const malformedGraceMs = options.malformedGraceMs ?? MALFORMED_LOCK_GRACE_MS;
  await mkdir(root, { recursive: true });
  const lockPath = join(root, WRITE_LOCK_FILE);
  const claimPath = join(root, WRITE_LOCK_CLAIM_FILE);
  const deadline = now() + Math.max(0, timeoutMs);
  const staleOptions = { now: now(), isAlive: alive, malformedGraceMs };

  for (;;) {
    if (await createExclusive(lockPath, pid)) {
      return async () => removeIfOwned(lockPath, pid);
    }
    const lock = await readRecord(lockPath);
    if (lock === undefined) continue;
    const currentNow = now();
    const stale = isStale(lock, { ...staleOptions, now: currentNow });
    if (!stale) {
      if (currentNow >= deadline) throw timeoutError(lockPath, lock);
      await sleep(pollMs);
      continue;
    }

    const claim = await readRecord(claimPath);
    if (claim !== undefined) {
      if (isStale(claim, { ...staleOptions, now: currentNow })) {
        await removeIfStale(claimPath, claim, {
          ...staleOptions,
          now: currentNow,
        });
        continue;
      }
      if (currentNow >= deadline) throw timeoutError(lockPath, lock);
      await sleep(pollMs);
      continue;
    }

    if (!(await createExclusive(claimPath, pid))) continue;
    try {
      const again = await readRecord(lockPath);
      if (
        again !== undefined &&
        isStale(again, { ...staleOptions, now: now() })
      ) {
        await removeIfStale(lockPath, again, {
          ...staleOptions,
          now: now(),
        });
      }
    } finally {
      await removeIfOwned(claimPath, pid).catch(() => undefined);
    }
    // Loop: if the stale lock was removed, the next iteration creates ours.
  }
}
