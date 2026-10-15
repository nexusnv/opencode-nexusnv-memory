import { describe, expect, it } from "vitest";
import {
  attemptKey,
  clearRotated,
  getPending,
  getRotated,
  getSnapshotHash,
  getThrottle,
  hasHint,
  hasSeen,
  hintKey,
  incPending,
  markAttempt,
  markSeen,
  pendingKey,
  pruneSeenTo500,
  resetPending,
  RETRY_WINDOW_MS,
  rotatedKey,
  SEEN_LIMIT,
  seenKey,
  setHint,
  setRotated,
  setSnapshotHash,
  setThrottle,
  shouldRetry,
  snapshotKey,
  throttleKey,
  type LedgerStorage,
} from "../src/capture.js";

/**
 * Persisted fake storage: one instance is the durable store, so reusing it
 * across ledger calls simulates restart/replay (no in-memory-only state may
 * leak dedupe decisions). `scan` pages via `after`/`next` like the real API.
 */
class FakeStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  setCalls = 0;
  constructor(readonly pageSize = 100) {}
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? this.data.get(key) : undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.setCalls += 1;
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .sort();
    let start = 0;
    if (options.after !== undefined) {
      const idx = keys.findIndex((k) => k > options.after!);
      start = idx === -1 ? keys.length : idx;
    }
    const limit = options.limit ?? this.pageSize;
    const slice = keys.slice(start, start + limit);
    const result: {
      entries: Array<{ key: string; value: unknown }>;
      next?: string;
    } = {
      entries: slice.map((key) => ({ key, value: this.data.get(key) })),
    };
    if (start + limit < keys.length && slice.length > 0) {
      result.next = slice[slice.length - 1]!;
    }
    return result;
  }
  async count(prefix: string): Promise<number> {
    let total = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.scan({ prefix, after });
      total += page.entries.length;
      if (page.next === undefined) return total;
      after = page.next;
    }
  }
}

const PROJECT = "proj-123";
const T0 = 1_700_000_000_000;

describe("ledger", () => {
  it("dedupes_replay_and_prunes_to_500", async () => {
    const storage = new FakeStorage();

    // Every key namespaced per project (ctx.storage is plugin-scoped).
    expect(seenKey(PROJECT, "abc")).toBe("proj-123/seen/abc");
    expect(attemptKey(PROJECT, "abc")).toBe("proj-123/attempt/abc");
    expect(pendingKey(PROJECT)).toBe("proj-123/curation.pending");
    expect(rotatedKey(PROJECT)).toBe("proj-123/curation.rotated");
    expect(snapshotKey(PROJECT, "sess")).toBe("proj-123/snapshot/sess");
    expect(throttleKey(PROJECT, "sess")).toBe(
      "proj-123/snapshotThrottle/sess",
    );
    expect(hintKey(PROJECT, "sess", "h")).toBe("proj-123/hint/sess/h");

    // Dedupe: first mark is new, replay is a duplicate no-op.
    expect(await hasSeen(storage, PROJECT, "id-1")).toBe(false);
    expect(await markSeen(storage, PROJECT, "id-1", T0)).toBe(true);
    expect(await hasSeen(storage, PROJECT, "id-1")).toBe(true);
    expect(await markSeen(storage, PROJECT, "id-1", T0 + 1)).toBe(false);

    // Restart-safe: the same persisted store still dedupes (nothing cached
    // in-memory alone).
    const reloaded: LedgerStorage = storage;
    expect(await hasSeen(reloaded, PROJECT, "id-1")).toBe(true);
    expect(await markSeen(reloaded, PROJECT, "id-1", T0 + 2)).toBe(false);

    // Project isolation.
    expect(await hasSeen(storage, "other-proj", "id-1")).toBe(false);

    // ~30s retry window via the attempt key.
    expect(RETRY_WINDOW_MS).toBe(30_000);
    expect(await shouldRetry(storage, PROJECT, "id-9", T0)).toBe(true);
    await markAttempt(storage, PROJECT, "id-9", T0);
    expect(await shouldRetry(storage, PROJECT, "id-9", T0 + 10_000)).toBe(
      true,
    );
    expect(await shouldRetry(storage, PROJECT, "id-9", T0 + 31_000)).toBe(
      false,
    );

    // Fill beyond the cap with out-of-order timestamps; prune evicts oldest.
    expect(SEEN_LIMIT).toBe(500);
    for (let i = 0; i < 600; i += 1) {
      await storage.set(seenKey(PROJECT, `bulk-${i}`), T0 + 1 + i);
    }
    expect(await storage.count(`${PROJECT}/seen/`)).toBe(601);

    const removed = await pruneSeenTo500(storage, PROJECT);
    expect(removed).toBe(101);
    expect(await storage.count(`${PROJECT}/seen/`)).toBe(500);

    // Oldest evicted by stored timestamp: id-1 (T0) + bulk-0..bulk-99 gone.
    expect(await hasSeen(storage, PROJECT, "id-1")).toBe(false);
    expect(await hasSeen(storage, PROJECT, "bulk-99")).toBe(false);
    expect(await hasSeen(storage, PROJECT, "bulk-100")).toBe(true);
    expect(await hasSeen(storage, PROJECT, "bulk-599")).toBe(true);

    // Prune touches only this project's seen keys.
    expect(await shouldRetry(storage, PROJECT, "id-9", T0 + 10_000)).toBe(
      true,
    );
  });

  it("single_flights_concurrent_marks_to_one_write", async () => {
    const storage = new FakeStorage();
    const [a, b] = await Promise.all([
      markSeen(storage, PROJECT, "race", T0),
      markSeen(storage, PROJECT, "race", T0),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(storage.setCalls).toBe(1);
    expect(await markSeen(storage, PROJECT, "race", T0)).toBe(false);
    expect(storage.setCalls).toBe(1);
  });

  it("tracks_pending_rotated_snapshot_throttle_hint", async () => {
    const storage = new FakeStorage();

    expect(await getPending(storage, PROJECT)).toBe(0);
    expect(await incPending(storage, PROJECT)).toBe(1);
    expect(await incPending(storage, PROJECT, 4)).toBe(5);
    expect(await getPending(storage, PROJECT)).toBe(5);
    await resetPending(storage, PROJECT);
    expect(await getPending(storage, PROJECT)).toBe(0);

    expect(await getRotated(storage, PROJECT)).toBeUndefined();
    await setRotated(storage, PROJECT, 2);
    expect(await getRotated(storage, PROJECT)).toBe(2);
    await clearRotated(storage, PROJECT);
    expect(await getRotated(storage, PROJECT)).toBeUndefined();

    expect(await getSnapshotHash(storage, PROJECT, "s1")).toBeUndefined();
    await setSnapshotHash(storage, PROJECT, "s1", "hash-a");
    expect(await getSnapshotHash(storage, PROJECT, "s1")).toBe("hash-a");

    expect(await getThrottle(storage, PROJECT, "s1")).toBeUndefined();
    await setThrottle(storage, PROJECT, "s1", T0);
    expect(await getThrottle(storage, PROJECT, "s1")).toBe(T0);

    expect(await hasHint(storage, PROJECT, "s1", "p")).toBe(false);
    await setHint(storage, PROJECT, "s1", "p", T0);
    expect(await hasHint(storage, PROJECT, "s1", "p")).toBe(true);
    expect(await hasHint(storage, PROJECT, "s1", "other")).toBe(false);
  });
});
