import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import { withWriteLock } from "../src/files.js";
import type { LedgerStorage } from "../src/capture.js";
import {
  armKey,
  clearArm,
  createBump,
  DAY_BUCKET_RETENTION_DAYS,
  dayKey,
  METRIC_NAMES,
  metricsBumpOf,
  pruneDayBuckets,
  readArmed,
  readDays,
  readSince,
  readTotals,
  resetMetricsStateForTests,
  setArm,
  sinceKey,
  totalKey,
  type MetricName,
} from "../src/metrics.js";

/**
 * Metrics core behavior (spec §5.12 + ADR-0008): numbers-only keys under
 * `<projectID>/metrics/…`, fail-closed vocabulary, fire-and-forget bumps,
 * and the 90-day prune — described through the storage contract, not the
 * implementation.
 */

/** Small fixed page size so paginated scans really page. */
const PAGE_SIZE = 3;

class FakeStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? this.data.get(key) : undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async scan(options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }> {
    let keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .sort();
    if (options.after !== undefined) {
      const after = options.after;
      keys = keys.filter((k) => k > after);
    }
    const page = keys.slice(0, options.limit ?? PAGE_SIZE);
    return {
      entries: page.map((key) => ({ key, value: this.data.get(key) })),
      next:
        page.length > 0 && keys.length > page.length
          ? page[page.length - 1]
          : undefined,
    };
  }
}

/** Every method rejects: metrics must still resolve, never throw. */
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
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }> {
    throw new Error("storage down");
  }
}

const PROJECT = "proj-metrics";
const SESSION = "sess-metrics";
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStampOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Drain every scheduled metrics write (bump bodies + piggyback prune
 * removals): one macrotask lets storage scans resolve, then joining the
 * write chain behind them waits until all earlier work completes.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await withWriteLock(async () => undefined);
}

beforeEach(() => {
  // Each test starts from zero metrics state: the next bump is genuinely
  // the process's first (prune piggyback fires, warned labels are fresh).
  resetMetricsStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("counter vocabulary (§5.12, fail-closed)", () => {
  it("publishes the exhaustive 45-name vocabulary", () => {
    const expected = [
      "hook.prompt",
      "hook.context",
      "hook.compaction",
      "index.attach",
      "index.overCap",
      "index.already",
      "remember.caught",
      "brief.empty",
      "brief.injected",
      "brief.lines",
      "brief.truncated",
      "status.shown",
      "status.dropped",
      "hint.shown",
      "compaction.priors",
      "priors.lines",
      "failure.captured",
      "failure.duplicate",
      "failure.retry",
      "failure.failed",
      "snapshot.written",
      "snapshot.unchanged",
      "snapshot.dropped",
      "snapshot.failed",
      "compactionCapture.captured",
      "compactionCapture.duplicate",
      "compactionCapture.dropped",
      "compactionCapture.failed",
      "recall.INDEX.md",
      "recall.activeContext.md",
      "recall.decisions.md",
      "recall.architecture.md",
      "recall.style.md",
      "recall.issues.md",
      "recall.handoff",
      "recall.error",
      "apply.batch",
      "apply.lines",
      "apply.denied",
      "apply.partialError",
      "apply.reset",
      "review.invoked",
      "dashboard.shown",
      "dashboard.reset",
      "hint.recall",
    ];
    expect(METRIC_NAMES.size).toBe(45);
    expect([...METRIC_NAMES].sort()).toEqual([...expected].sort());
  });
});

describe("key shapes (spec §5.12)", () => {
  it("builds the four storage key namespaces", () => {
    expect(totalKey(PROJECT, "hook.prompt")).toBe(
      `${PROJECT}/metrics/total/hook.prompt`,
    );
    expect(dayKey(PROJECT, "20260217", "apply.lines")).toBe(
      `${PROJECT}/metrics/day/20260217/apply.lines`,
    );
    expect(sinceKey(PROJECT)).toBe(`${PROJECT}/metrics/since`);
    expect(armKey(PROJECT, SESSION)).toBe(
      `${PROJECT}/metrics/arm/hint/${SESSION}`,
    );
  });
});

describe("bump counters", () => {
  it("increments the total + day pair by the given delta", async () => {
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    bump("hook.prompt");
    bump("hook.prompt");
    bump("apply.lines", 7);
    await settle();
    const day = dayStampOf(Date.now());
    expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(2);
    expect(await storage.get(dayKey(PROJECT, day, "hook.prompt"))).toBe(2);
    expect(await storage.get(totalKey(PROJECT, "apply.lines"))).toBe(7);
    expect(await storage.get(dayKey(PROJECT, day, "apply.lines"))).toBe(7);
  });

  it("names day buckets with the UTC YYYYMMDD stamp", async () => {
    const storage = new FakeStorage();
    createBump(storage, PROJECT)("hook.prompt");
    await settle();
    const dayKeys = [...storage.data.keys()].filter((key) =>
      key.startsWith(`${PROJECT}/metrics/day/`),
    );
    expect(dayKeys).toHaveLength(1);
    const stamp = dayKeys[0].match(/\/metrics\/day\/(\d{8})\//)?.[1];
    expect(stamp).toBeDefined();
    expect(dayKeys[0]).toBe(`${PROJECT}/metrics/day/${stamp}/hook.prompt`);
    // Midnight-crossing tolerance: the bump's stamp is today's UTC day.
    expect(
      stamp === dayStampOf(Date.now()) || stamp === dayStampOf(Date.now() - DAY_MS),
    ).toBe(true);
    expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(1);
  });

  it("writes a lazy ISO-8601 since stamp once and keeps it", async () => {
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    expect(await readSince(storage, PROJECT)).toBeUndefined();
    bump("hook.prompt");
    await settle();
    const since = await readSince(storage, PROJECT);
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(await storage.get(sinceKey(PROJECT))).toBe(since);
    bump("hook.prompt");
    await settle();
    expect(await storage.get(sinceKey(PROJECT))).toBe(since);
    // Self-heal: a tampered since is rewritten on the next bump.
    storage.data.set(sinceKey(PROJECT), "garbage");
    bump("hook.prompt");
    await settle();
    const healed = await readSince(storage, PROJECT);
    expect(healed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(healed).not.toBe("garbage");
  });

  it("warns once and drops unknown counter names without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    const bogus = "definitely.not.a.metric" as MetricName;
    bump(bogus);
    bump(bogus);
    bump(bogus, 2);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(storage.data.size).toBe(0);
    expect(await readTotals(storage, PROJECT)).toEqual({});
  });

  it("drops malformed deltas without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    bump("hook.prompt", 0);
    bump("hook.prompt", -2);
    bump("hook.prompt", 1.5);
    bump("hook.prompt", Number.NaN);
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(storage.data.size).toBe(0);
    expect(await readTotals(storage, PROJECT)).toEqual({});
  });

  it("never throws synchronously and leaves no unhandled rejection when storage is down", async () => {
    const bump = createBump(new ThrowingStorage(), PROJECT);
    expect(() => {
      for (let i = 0; i < 25; i += 1) bump("hook.prompt");
    }).not.toThrow();
    await settle();
    // The shared write chain must stay healthy after the failures.
    await expect(withWriteLock(async () => "ok")).resolves.toBe("ok");
  });

  it("contains the first post-reset piggyback prune when storage is down", async () => {
    // beforeEach already reset the metrics state, so this is genuinely the
    // process's first bump: the piggyback prune fires against ThrowingStorage.
    const bump = createBump(new ThrowingStorage(), PROJECT);
    expect(() => {
      bump("hook.prompt");
    }).not.toThrow();
    await settle();
    // No unhandled rejection (vitest would fail the run) and the chain stays usable.
    await expect(withWriteLock(async () => "ok")).resolves.toBe("ok");
  });
});

describe("arm flag (hint→recall, binary as int 1)", () => {
  it("stores the armed flag as the number 1 and reads it back per session", async () => {
    const storage = new FakeStorage();
    await setArm(storage, PROJECT, SESSION);
    expect(await storage.get(armKey(PROJECT, SESSION))).toBe(1);
    expect(await readArmed(storage, PROJECT, SESSION)).toBe(true);
    expect(await readArmed(storage, PROJECT, "sess-other")).toBe(false);
  });

  it("clears the flag and tolerates double clears", async () => {
    const storage = new FakeStorage();
    await setArm(storage, PROJECT, SESSION);
    await clearArm(storage, PROJECT, SESSION);
    expect(await storage.get(armKey(PROJECT, SESSION))).toBeUndefined();
    expect(await readArmed(storage, PROJECT, SESSION)).toBe(false);
    await expect(clearArm(storage, PROJECT, SESSION)).resolves.toBeUndefined();
  });

  it("never rejects when storage is down", async () => {
    const storage = new ThrowingStorage();
    await expect(setArm(storage, PROJECT, SESSION)).resolves.toBeUndefined();
    await expect(clearArm(storage, PROJECT, SESSION)).resolves.toBeUndefined();
  });
});

describe("readers", () => {
  it("groups totals and day buckets, filtering non-vocabulary keys", async () => {
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    bump("hook.prompt");
    bump("recall.INDEX.md", 2);
    await settle();
    // Tampered keys (not writable through bump) are read-filtered fail-closed.
    storage.data.set(`${PROJECT}/metrics/total/rogue`, 5);
    storage.data.set(`${PROJECT}/metrics/day/badstamp/hook.prompt`, 1);
    // Extra segments after `<stamp>/<name>` are not a recognized counter.
    storage.data.set(`${PROJECT}/metrics/day/20260101/hook.prompt/extra`, 9);
    expect(await readTotals(storage, PROJECT)).toEqual({
      "hook.prompt": 1,
      "recall.INDEX.md": 2,
    });
    const days = await readDays(storage, PROJECT);
    const stamps = Object.keys(days);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatch(/^\d{8}$/);
    expect(days[stamps[0]]).toEqual({ "hook.prompt": 1, "recall.INDEX.md": 2 });
  });

  it("reads empty when nothing is persisted", async () => {
    const storage = new FakeStorage();
    expect(await readTotals(storage, PROJECT)).toEqual({});
    expect(await readDays(storage, PROJECT)).toEqual({});
    expect(await readSince(storage, PROJECT)).toBeUndefined();
    expect(await readArmed(storage, PROJECT, SESSION)).toBe(false);
  });
});

describe("numbers-only invariant (ADR-0008)", () => {
  it("persists only integer numbers; since is the sole string exception", async () => {
    const storage = new FakeStorage();
    const bump = createBump(storage, PROJECT);
    bump("hook.prompt");
    bump("recall.INDEX.md", 2);
    bump("hint.recall");
    await setArm(storage, PROJECT, SESSION);
    await settle();
    for (const [key, value] of storage.data) {
      if (key === sinceKey(PROJECT)) {
        expect(typeof value).toBe("string");
      } else {
        expect(typeof value).toBe("number");
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

describe("pruneDayBuckets", () => {
  it("keeps the last 90 day buckets and never touches totals", async () => {
    const storage = new FakeStorage();
    const now = Date.now();
    for (let i = 0; i < DAY_BUCKET_RETENTION_DAYS + 2; i += 1) {
      await storage.set(
        dayKey(PROJECT, dayStampOf(now - i * DAY_MS), "hook.prompt"),
        1,
      );
    }
    await storage.set(totalKey(PROJECT, "hook.prompt"), 55);
    const removed = await pruneDayBuckets(storage, PROJECT);
    expect(removed).toBe(2);
    const remaining = [...storage.data.keys()].filter((key) =>
      key.startsWith(`${PROJECT}/metrics/day/`),
    );
    expect(remaining).toHaveLength(90);
    expect(
      storage.data.has(
        dayKey(
          PROJECT,
          dayStampOf(now - (DAY_BUCKET_RETENTION_DAYS - 1) * DAY_MS),
          "hook.prompt",
        ),
      ),
    ).toBe(true);
    expect(
      storage.data.has(
        dayKey(PROJECT, dayStampOf(now - DAY_BUCKET_RETENTION_DAYS * DAY_MS), "hook.prompt"),
      ),
    ).toBe(false);
    expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(55);
    expect(await storage.get(sinceKey(PROJECT))).toBeUndefined();
  });

  it("leaves malformed and foreign keys alone", async () => {
    const storage = new FakeStorage();
    await storage.set(`${PROJECT}/metrics/day/garbage/hook.prompt`, 1);
    await storage.set("other-project/metrics/day/20200101/hook.prompt", 1);
    await storage.set(sinceKey(PROJECT), "2026-10-17T00:00:00.000Z");
    expect(await pruneDayBuckets(storage, PROJECT)).toBe(0);
    expect(storage.data.size).toBe(3);
  });
});

describe("once-per-UTC-day prune piggyback", () => {
  it("prunes off the first bump after a day change and not again the same day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.UTC(2035, 5, 1); // fixed UTC day, never the real today
    vi.setSystemTime(base);
    const oldStamp = dayStampOf(base - 92 * DAY_MS);
    const storage = new FakeStorage();
    await storage.set(dayKey(PROJECT, oldStamp, "hook.prompt"), 3);
    const bump = createBump(storage, PROJECT);

    bump("hook.prompt");
    await settle();
    expect(
      await storage.get(dayKey(PROJECT, oldStamp, "hook.prompt")),
    ).toBeUndefined();
    expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(1);

    // Same UTC day: a re-planted old bucket survives (no second prune).
    await storage.set(dayKey(PROJECT, oldStamp, "hook.prompt"), 3);
    bump("hint.recall");
    await settle();
    expect(await storage.get(dayKey(PROJECT, oldStamp, "hook.prompt"))).toBe(3);
    expect(await storage.get(totalKey(PROJECT, "hint.recall"))).toBe(1);
  });

  it("prunes per project: two projects each piggyback on the same UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.UTC(2040, 0, 1); // fixed UTC day, never the real today
    vi.setSystemTime(base);
    const oldStamp = dayStampOf(base - 92 * DAY_MS);
    const storageA = new FakeStorage();
    const storageB = new FakeStorage();
    await storageA.set(dayKey(PROJECT, oldStamp, "hook.prompt"), 4);
    await storageB.set(dayKey("proj-other", oldStamp, "hook.prompt"), 4);
    const bumpA = createBump(storageA, PROJECT);
    const bumpB = createBump(storageB, "proj-other");

    bumpA("hook.prompt");
    await settle();
    // Project A piggybacks: its expired bucket is gone.
    expect(
      await storageA.get(dayKey(PROJECT, oldStamp, "hook.prompt")),
    ).toBeUndefined();
    expect(await storageA.get(totalKey(PROJECT, "hook.prompt"))).toBe(1);

    // Project B piggybacks too on the SAME UTC day: A's first bump must not
    // advance the prune stamp for B (per-project, not global).
    bumpB("hook.prompt");
    await settle();
    expect(
      await storageB.get(dayKey("proj-other", oldStamp, "hook.prompt")),
    ).toBeUndefined();
    expect(await storageB.get(totalKey("proj-other", "hook.prompt"))).toBe(1);
  });
});

describe("metricsBumpOf (context adapter)", () => {
  it("derives the projectID from ctx.location.project.id and adapts ctx.storage", async () => {
    const storage = new FakeStorage();
    const ctx = {
      location: {
        directory: "/tmp/location",
        project: { id: PROJECT, directory: "/tmp/location", canonical: "/tmp/location" },
      },
      storage,
    } as unknown as Plugin.Context;
    metricsBumpOf(ctx)("hook.prompt");
    await settle();
    expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(1);
    expect(await readSince(storage, PROJECT)).toBeDefined();
  });

  it("falls back to location.directory when the context has no project", async () => {
    const storage = new FakeStorage();
    const ctx = {
      location: { directory: "/tmp/only-dir" },
      storage,
    } as unknown as Plugin.Context;
    metricsBumpOf(ctx)("hook.prompt");
    await settle();
    expect(await storage.get(totalKey("/tmp/only-dir", "hook.prompt"))).toBe(1);
    expect(await readTotals(storage, PROJECT)).toEqual({});
  });
});
