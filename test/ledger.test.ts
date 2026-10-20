import { describe, expect, it } from "vitest";
import {
  ATTEMPT_RETENTION_MS,
  attemptKey,
  clearRotated,
  getPending,
  getRotated,
  getSnapshotHash,
  getThrottle,
  hasHint,
  hasSeen,
  HINT_RETENTION_MS,
  hintKey,
  incPending,
  markAttempt,
  markSeen,
  pendingKey,
  pruneLedgerState,
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
  SNAPSHOT_RETENTION_MS,
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

/** Every method rejects: prune callers must surface or catch, never hang. */
class ThrowingStorage implements LedgerStorage {
  async get(_key: string): Promise<unknown> {
    throw new Error("storage down");
  }
  async set(_key: string, _value: unknown): Promise<void> {
    throw new Error("storage down");
  }
  async remove(_key: string): Promise<void> {
    throw new Error("storage down");
  }
  async scan(_options: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit?: number;
  }): Promise<{
    readonly entries: ReadonlyArray<{
      readonly key: string;
      readonly value: unknown;
    }>;
    readonly next?: string;
  }> {
    throw new Error("storage down");
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

  it("stores snapshot records with an age and reads legacy strings", async () => {
    const storage = new FakeStorage();
    const at = Date.UTC(2035, 0, 1);
    await setSnapshotHash(storage, PROJECT, "s1", "hash-a", at);
    expect(await storage.get(snapshotKey(PROJECT, "s1"))).toEqual({
      hash: "hash-a",
      at,
    });
    expect(await getSnapshotHash(storage, PROJECT, "s1")).toBe("hash-a");
    // Legacy value written by an older version still reads.
    await storage.set(snapshotKey(PROJECT, "s2"), "hash-legacy");
    expect(await getSnapshotHash(storage, PROJECT, "s2")).toBe("hash-legacy");
  });
});

describe("pruneLedgerState (bounded ledger keys)", () => {
  it("removes abandoned attempts, aged hints, and aged session state", async () => {
    const storage = new FakeStorage();
    const now = Date.UTC(2035, 0, 1);
    // attempt: aged by the existing 30s retry window
    await storage.set(
      attemptKey(PROJECT, "old"),
      now - ATTEMPT_RETENTION_MS - 1,
    );
    await storage.set(attemptKey(PROJECT, "fresh"), now - 1000);
    await storage.set(attemptKey(PROJECT, "future"), now + 1000);
    await storage.set(attemptKey(PROJECT, "junk"), "not-a-number");
    // hint: 7-day retention
    await storage.set(
      hintKey(PROJECT, "s1", "old"),
      now - HINT_RETENTION_MS - 1,
    );
    await storage.set(hintKey(PROJECT, "s1", "fresh"), now - 1000);
    await storage.set(hintKey(PROJECT, "s1", "junk"), "not-a-number");
    // snapshot records: 30-day retention; legacy strings are normalized out
    await storage.set(snapshotKey(PROJECT, "old"), {
      hash: "hash-old",
      at: now - SNAPSHOT_RETENTION_MS - 1,
    });
    await storage.set(snapshotKey(PROJECT, "fresh"), {
      hash: "hash-fresh",
      at: now - 1000,
    });
    await storage.set(snapshotKey(PROJECT, "legacy"), "hash-legacy");
    // throttle: 30-day retention
    await storage.set(
      throttleKey(PROJECT, "old"),
      now - SNAPSHOT_RETENTION_MS - 1,
    );
    await storage.set(throttleKey(PROJECT, "fresh"), now - 1000);
    // other project / unrelated keys are untouched
    await storage.set("other/attempt/old", now - 10 * ATTEMPT_RETENTION_MS);
    await storage.set(`${PROJECT}/curation.pending`, 2);

    expect(await pruneLedgerState(storage, PROJECT, now)).toBe(5);

    expect(await storage.get(attemptKey(PROJECT, "old"))).toBeUndefined();
    expect(await storage.get(attemptKey(PROJECT, "fresh"))).toBeDefined();
    expect(await storage.get(attemptKey(PROJECT, "future"))).toBeDefined();
    expect(await storage.get(attemptKey(PROJECT, "junk"))).toBeDefined();
    expect(await storage.get(hintKey(PROJECT, "s1", "old"))).toBeUndefined();
    expect(await storage.get(hintKey(PROJECT, "s1", "fresh"))).toBeDefined();
    expect(await storage.get(hintKey(PROJECT, "s1", "junk"))).toBeDefined();
    expect(await storage.get(snapshotKey(PROJECT, "old"))).toBeUndefined();
    expect(await storage.get(snapshotKey(PROJECT, "fresh"))).toBeDefined();
    expect(await storage.get(snapshotKey(PROJECT, "legacy"))).toBeUndefined();
    expect(await storage.get(throttleKey(PROJECT, "old"))).toBeUndefined();
    expect(await storage.get(throttleKey(PROJECT, "fresh"))).toBeDefined();
    expect(await storage.get("other/attempt/old")).toBeDefined();
    expect(await storage.get(`${PROJECT}/curation.pending`)).toBe(2);
  });

  it("paginates across scan pages", async () => {
    const storage = new FakeStorage(37);
    const now = Date.UTC(2035, 0, 1);
    for (let i = 0; i < 120; i += 1) {
      await storage.set(
        hintKey(PROJECT, "s1", `p-${String(i).padStart(3, "0")}`),
        now - HINT_RETENTION_MS - 1000,
      );
    }
    expect(await pruneLedgerState(storage, PROJECT, now)).toBe(120);
    expect(
      [...storage.data.keys()].filter((key) =>
        key.startsWith(`${PROJECT}/hint/`),
      ),
    ).toHaveLength(0);
  });

  it("re-checks a key under the lock before removing it", async () => {
    // Simulate a write landing between scan and remove: `scan` reports the
    // value as aged, while the durable `get` returns the fresh timestamp.
    class StaleScanStorage extends FakeStorage {
      override async scan(options: {
        readonly prefix: string;
        readonly after?: string;
        readonly limit?: number;
      }) {
        const page = await super.scan(options);
        return {
          ...page,
          entries: page.entries.map((entry) =>
            entry.key === hintKey(PROJECT, "s1", "p")
              ? { key: entry.key, value: 0 }
              : entry,
          ),
        };
      }
    }
    const storage = new StaleScanStorage();
    const now = Date.UTC(2035, 0, 1);
    await storage.set(hintKey(PROJECT, "s1", "p"), now - 1000);

    expect(await pruneLedgerState(storage, PROJECT, now)).toBe(0);
    expect(await storage.get(hintKey(PROJECT, "s1", "p"))).toBe(now - 1000);
  });

  it("never touches another project's aged keys", async () => {
    const storage = new FakeStorage();
    const now = Date.UTC(2035, 0, 1);
    await storage.set("other/hint/s1/old", now - HINT_RETENTION_MS - 1);
    expect(await pruneLedgerState(storage, PROJECT, now)).toBe(0);
    expect(await storage.get("other/hint/s1/old")).toBeDefined();
  });

  it("propagates storage failures to the caller (which catches)", async () => {
    await expect(
      pruneLedgerState(new ThrowingStorage(), PROJECT),
    ).rejects.toThrow("storage down");
  });
});
