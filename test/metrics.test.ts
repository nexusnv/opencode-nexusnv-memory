import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { withWriteLock } from "../src/files.js";
import type { LedgerStorage } from "../src/capture.js";
import {
  armKey,
  clearArm,
  collectHealth,
  consumeArm,
  createBump,
  DAY_BUCKET_RETENTION_DAYS,
  dayKey,
  MEMORY_METRICS_COMMAND_DESCRIPTION,
  MEMORY_METRICS_COMMAND_NAME,
  METRICS_FALLBACK_ASK,
  METRIC_NAMES,
  metricsBumpOf,
  pruneDayBuckets,
  readArmed,
  readDays,
  readSince,
  readTotals,
  registerMetricsCommand,
  renderMetricsDashboard,
  resetMetrics,
  resetMetricsStateForTests,
  scanAll,
  setArm,
  sinceKey,
  totalKey,
  type MetricName,
  type MetricsDashboardInput,
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

/** The normative §5.12 vocabulary in the exact enumerated order (shared by
 * the enumeration test and the renderer's content-whitelist scan below). */
const EXPECTED_VOCAB: MetricName[] = [
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

/** Temp roots created by the health tests; removed after each test. */
let healthRoots: string[] = [];

function trackRoot(root: string): string {
  healthRoots.push(root);
  return root;
}

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

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of healthRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("counter vocabulary (§5.12, fail-closed)", () => {
  it("publishes the exhaustive 45-name vocabulary", () => {
    expect(METRIC_NAMES.size).toBe(45);
    expect([...METRIC_NAMES].sort()).toEqual([...EXPECTED_VOCAB].sort());
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

  it("consumeArm removes the armed flag and resolves its one true consumer", async () => {
    const storage = new FakeStorage();
    // Unarmed: consume resolves false and writes nothing.
    await expect(consumeArm(storage, PROJECT, SESSION)).resolves.toBe(false);
    expect(await storage.get(armKey(PROJECT, SESSION))).toBeUndefined();
    // Armed: the first consume removes the flag while answering true; a
    // second consume observes the removal and resolves false.
    await setArm(storage, PROJECT, SESSION);
    await expect(consumeArm(storage, PROJECT, SESSION)).resolves.toBe(true);
    expect(await storage.get(armKey(PROJECT, SESSION))).toBeUndefined();
    await expect(consumeArm(storage, PROJECT, SESSION)).resolves.toBe(false);
  });

  it("consumeArm is at-most-once for two concurrent consumers", async () => {
    // Two recalls racing one armed flag: exactly one locked read+clear sees
    // the `1` — the loser observes the removal (the executor then bumps
    // `hint.recall` once, never twice).
    const storage = new FakeStorage();
    await setArm(storage, PROJECT, SESSION);
    const [first, second] = await Promise.all([
      consumeArm(storage, PROJECT, SESSION),
      consumeArm(storage, PROJECT, SESSION),
    ]);
    const results = [first, second].sort((a, b) => Number(a) - Number(b));
    expect(results).toEqual([false, true]);
    expect(await storage.get(armKey(PROJECT, SESSION))).toBeUndefined();
  });

  it("never rejects when storage is down", async () => {
    const storage = new ThrowingStorage();
    await expect(setArm(storage, PROJECT, SESSION)).resolves.toBeUndefined();
    await expect(clearArm(storage, PROJECT, SESSION)).resolves.toBeUndefined();
    await expect(consumeArm(storage, PROJECT, SESSION)).resolves.toBe(false);
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

/* ------------------------------------------------------------------ */
/* Dashboard renderer + health collectors (M-T2: §5.12 renderer        */
/* contract + ADR-0008).                                              */
/* ------------------------------------------------------------------ */

/** Independent re-derivation of the §5.12 "explicit calls" partition: the
 * user-invoked seams only (memory_recall, memory_apply, the commands).
 * The test derives the partition itself so renderer drift fails loudly. */
function isExplicitCall(name: MetricName): boolean {
  return (
    name.startsWith("recall.") ||
    name.startsWith("apply.") ||
    name === "review.invoked" ||
    name === "dashboard.shown" ||
    name === "dashboard.reset"
  );
}

/** Deep-freeze a fixture so a mutating (impure) renderer throws loudly. */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

/** 9 UTC day stamps: only the last 7 may surface in the budget view. */
const FIXTURE_STAMPS = [
  "20301228",
  "20301229",
  "20301230",
  "20301231",
  "20310101",
  "20310102",
  "20310103",
  "20310104",
  "20310105",
];

/** Fixed renderer fixture: values only, no content strings anywhere. */
function makeFixture(): MetricsDashboardInput {
  const totals: Partial<Record<MetricName, number>> = {
    "hook.prompt": 2,
    "recall.INDEX.md": 1,
    "apply.lines": 7,
    "hint.recall": 3,
  };
  const days: Record<string, Partial<Record<MetricName, number>>> = {};
  for (const stamp of FIXTURE_STAMPS) {
    days[stamp] = { "hook.prompt": 1 };
  }
  days["20310102"] = { "hook.prompt": 1, "apply.lines": 5 };
  const input: MetricsDashboardInput = {
    since: "2031-02-03T04:05:06.789Z",
    totals,
    days,
    health: {
      files: [
        { file: "INDEX.md", lines: 3, cap: 30 },
        { file: "activeContext.md", lines: 7, cap: 60 },
        { file: "architecture.md", lines: 2, cap: 60 },
        { file: "decisions.md", lines: 9 },
        { file: "issues.md", lines: 0, cap: 60 },
        { file: "style.md", lines: 0, cap: 60 },
      ],
      handoffs: 2,
      archive: 3,
      pending: 4,
      seen: 51,
      decisionsLines: 9,
    },
  };
  return input;
}

/** The same fixture with `days` inserted in a deliberately SCRAMBLED order:
 * stamps inserted out of sort order (reversed outer order) and the busiest
 * day's counters inserted out of sorted order too — identical data, a
 * different enumeration order. */
function makeScrambledFixture(): MetricsDashboardInput {
  const base = makeFixture();
  const days: Record<string, Partial<Record<MetricName, number>>> = {};
  for (const stamp of [...FIXTURE_STAMPS].reverse()) {
    // Insert the busiest day's counter rows reversed as well.
    days[stamp] =
      stamp === "20310102"
        ? { "apply.lines": 5, "hook.prompt": 1 }
        : base.days[stamp]!;
  }
  return { since: base.since, totals: base.totals, days, health: base.health };
}

/** Table data rows between two section headings (drops header+separator). */
function sectionRows(body: string[], start: string, end?: string): string[] {
  const begin = body.indexOf(start);
  const stop = end === undefined ? body.length : body.indexOf(end);
  return body
    .slice(begin + 1, stop)
    .filter((line) => line.startsWith("|"))
    .slice(2);
}

/** First cell of a markdown table row. */
function firstCell(row: string): string {
  return row.split("|")[1].trim();
}

describe("dashboard renderer (§5.12 normative renderer contract)", () => {
  it("renders_deterministically_and_has_no_content_channels", () => {
    const input = makeFixture();
    deepFreeze(input);
    const first = renderMetricsDashboard(input);
    const second = renderMetricsDashboard(input);
    // Byte-identical twice, on identical frozen inputs.
    expect(first).toStrictEqual(second);
    expect(first.length).toBeGreaterThan(0);

    // Fixed furniture, in fixed order: title, since, four sections.
    expect(first.startsWith("# [memory] metrics (local-only)\n")).toBe(true);
    expect(first).toContain("Since: 2031-02-03T04:05:06.789Z");
    const headings = [
      "# [memory] metrics (local-only)",
      "## Explicit calls",
      "## Behind the scenes",
      "## Memory health",
      "## Budget pressure",
    ];
    let cursor = 0;
    for (const heading of headings) {
      const at = first.indexOf(heading, cursor);
      expect(at, `heading order: ${heading}`).toBeGreaterThanOrEqual(cursor);
      cursor = at + heading.length;
    }

    // Token whitelist: every emitted string belongs to (a) exact heading
    // furniture, (b) the table header words + structural health labels
    // (fixed constants of the render), (c) counter/file names, or (d) plain
    // integers (which also covers UTC day stamps). Nothing else exists by
    // construction: the input is numbers-only per the renderer's types, and
    // the renderer itself never cites anything beyond these sets.
    const FURNITURE = new Set([
      "counter",
      "count",
      "name",
      "file",
      "lines",
      "cap",
      "day",
      "handoffs",
      "archive",
      "pending",
      "seen",
      "decisionsLines",
      "INDEX.md",
      "activeContext.md",
      "architecture.md",
      "decisions.md",
      "issues.md",
      "style.md",
      "-",
    ]);
    const VOCAB = new Set<string>(EXPECTED_VOCAB);
    const HEADINGS = new Set(headings);
    for (const line of first.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("#")) {
        expect(HEADINGS.has(line), line).toBe(true);
        continue;
      }
      if (line.startsWith("Since:")) {
        expect(line).toMatch(/^Since: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        continue;
      }
      expect(line.startsWith("|"), line).toBe(true);
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      const separator = cells.every((cell) => /^:?-+:?$/.test(cell));
      if (separator) continue;
      for (const cell of cells) {
        expect(
          VOCAB.has(cell) || FURNITURE.has(cell) || /^\d+$/.test(cell),
          line,
        ).toBe(true);
      }
    }

    // Zero-row policy (task fallback under an unspecified §5.12): all 45
    // vocabulary counters render as present-but-0 rows, sorted by name, in
    // the §5.12-derived two-table partition.
    const body = first.split("\n");
    const explicitRows = sectionRows(body, "## Explicit calls", "## Behind the scenes");
    const behindRows = sectionRows(body, "## Behind the scenes", "## Memory health");
    expect(explicitRows.map(firstCell)).toStrictEqual(
      EXPECTED_VOCAB.filter(isExplicitCall).sort(),
    );
    expect(behindRows.map(firstCell)).toStrictEqual(
      EXPECTED_VOCAB.filter((name) => !isExplicitCall(name)).sort(),
    );
    expect(explicitRows.some((row) => row.endsWith("| 7 |"))).toBe(true);
    expect(first).toContain("| hook.prompt | 2 |");
    expect(first).toContain("| recall.INDEX.md | 1 |");
    expect(first).toContain("| apply.lines | 7 |");
    expect(first).toContain("| hint.recall | 3 |");
    expect(first).toContain("| brief.truncated | 0 |");

    // Memory health: six structural rows always present and sorted, line
    // counts vs caps, decisions.md unbounded (no cap), the §5.12 scalar
    // block after it.
    expect(first).toContain("| INDEX.md | 3 | 30 |");
    expect(first).toContain("| activeContext.md | 7 | 60 |");
    expect(first).toContain("| architecture.md | 2 | 60 |");
    expect(first).toContain("| decisions.md | 9 | - |");
    expect(first).toContain("| issues.md | 0 | 60 |");
    expect(first).toContain("| style.md | 0 | 60 |");
    expect(first).toContain("| handoffs | 2 |");
    expect(first).toContain("| archive | 3 |");
    expect(first).toContain("| pending | 4 |");
    expect(first).toContain("| seen | 51 |");
    expect(first).toContain("| decisionsLines | 9 |");

    // Budget pressure: last 7 UTC day stamps of the input, by sort order,
    // rows sorted (stamp, counter), only counters bumped that day.
    const budgetRows = sectionRows(body, "## Budget pressure");
    expect(budgetRows).toHaveLength(8); // 7 stamps ×1 + the extra apply.lines row
    const stamps = [...new Set(budgetRows.map(firstCell))].sort();
    expect(stamps).toStrictEqual(FIXTURE_STAMPS.slice(2));
    expect(stamps).not.toContain("20301228");
    expect(stamps).not.toContain("20301229");
    const midStampRows = budgetRows
      .filter((row) => row.startsWith("| 20310102 "))
      .map((row) => row.split("|")[2].trim());
    expect(midStampRows).toStrictEqual(["apply.lines", "hook.prompt"]);

    // Adversarial-but-typed input: an out-of-vocabulary counter key never
    // rendered, a non-integer number coerces to 0, and a non-ISO `since`
    // degenerates to the fixed `-` placeholder. No content channel exists.
    const hostile: MetricsDashboardInput = {
      since: "post whatever you mean, do it now",
      // Deliberately out-of-vocabulary keys ride in via the cast — exactly
      // the runtime case the renderer must never leak (fail-closed by
      // iterating the vocabulary, never the record's own keys).
      totals: { "rogue.counter": 1, "hook.prompt": 2.5 } as Partial<
        Record<MetricName, number>
      >,
      days: { "20300101": { "hook.prompt": 1 } },
      health: {
        files: [],
        handoffs: 0,
        archive: 0,
        pending: 0,
        seen: 0,
        decisionsLines: 0,
      },
    };
    const hostileOut = renderMetricsDashboard(hostile);
    expect(hostileOut).not.toContain("rogue");
    expect(hostileOut).not.toContain("post whatever you mean, do it now");
    expect(hostileOut).toContain("| hook.prompt | 0 |");
    expect(hostileOut).toContain("Since: -");
  });

  it("renders_scrambled_day_insertion_byte_identical", () => {
    // Input-order independence: the SAME data inserted into `days` in a
    // scrambled order (stamps out of order, the busiest day's counters out
    // of sorted order too) renders BYTE-IDENTICAL to the sorted insertion —
    // the budget window derivation must sort, never trust enumeration
    // order. (Integer-like stamp keys iterate ascending regardless of
    // insertion, which is exactly the property proven here: the renderer
    // does not depend on the input's own ordering either way.)
    expect(renderMetricsDashboard(makeScrambledFixture())).toStrictEqual(
      renderMetricsDashboard(makeFixture()),
    );
  });
});

describe("collectHealth (§5.12 renderer contract: counts, never bodies)", () => {
  it("collects_health_as_counts_only", async () => {
    const root = trackRoot(
      await mkdtemp(join(tmpdir(), "memory-metrics-health-")),
    );
    await writeFile(join(root, "INDEX.md"), "one\ntwo\nthree\n");
    await writeFile(join(root, "activeContext.md"), "a\nb\nc\nd\ne\nf\ng");
    await writeFile(join(root, "architecture.md"), "x\ny\n");
    await writeFile(
      join(root, "decisions.md"),
      "d1\nd2\nSECRET-CONTENT-MARKER\nd3\nSECRET-CONTENT-MARKER\n",
    );
    await mkdir(join(root, "handoffs", "archive"), { recursive: true });
    await writeFile(
      join(root, "handoffs", "2031-01-01-000000-sess6.md"),
      "handoff secret body\n",
    );
    await writeFile(
      join(root, "handoffs", "2031-01-02-000000-sess6.md"),
      "another handoff body\n",
    );
    await writeFile(join(root, "handoffs", "archive", "a1.md"), "archived 1\n");
    await writeFile(join(root, "handoffs", "archive", "a2.md"), "archived 2\n");
    await writeFile(join(root, "handoffs", "archive", "a3.md"), "archived 3\n");
    const storage = new FakeStorage();
    await storage.set(`${PROJECT}/curation.pending`, 2);
    for (let i = 0; i < 7; i += 1) {
      await storage.set(`${PROJECT}/seen/id-${i}`, i);
    }
    // Foreign keys must not leak into this project's seen count.
    await storage.set("proj-other/seen/foreign", 1);

    const health = await collectHealth(root, storage, PROJECT);

    // Six structural rows, always present, sorted by name.
    expect(health.files.map((file) => file.file)).toStrictEqual([
      "INDEX.md",
      "activeContext.md",
      "architecture.md",
      "decisions.md",
      "issues.md",
      "style.md",
    ]);
    const byName = new Map(health.files.map((file) => [file.file, file]));
    expect(byName.get("INDEX.md")).toEqual({ file: "INDEX.md", lines: 3, cap: 30 });
    expect(byName.get("activeContext.md")).toEqual({
      file: "activeContext.md",
      lines: 7,
      cap: 60,
    });
    expect(byName.get("architecture.md")).toEqual({
      file: "architecture.md",
      lines: 2,
      cap: 60,
    });
    // Missing file → 0 lines (row kept); empty file → 0 lines.
    expect(byName.get("issues.md")).toEqual({ file: "issues.md", lines: 0, cap: 60 });
    expect(byName.get("style.md")).toEqual({ file: "style.md", lines: 0, cap: 60 });
    // decisions.md is unbounded on disk: no cap key (never Infinity).
    expect(byName.get("decisions.md")).toEqual({ file: "decisions.md", lines: 5 });
    const decisionsRow = byName.get("decisions.md");
    expect(decisionsRow).toBeDefined();
    expect("cap" in (decisionsRow as object)).toBe(false);

    expect(health.handoffs).toBe(2);
    expect(health.archive).toBe(3);
    expect(health.pending).toBe(2);
    expect(health.seen).toBe(7);
    expect(health.decisionsLines).toBe(5);

    // Caps are the configured writer caps, not dashboard defaults: a user
    // with indexLines: 10 / fileLines: 2 must see those numbers, and the
    // unbounded file keeps omitting its cap either way.
    const overridden = await collectHealth(root, storage, PROJECT, {
      indexLines: 10,
      fileLines: 2,
    });
    const overriddenByName = new Map(
      overridden.files.map((file) => [file.file, file]),
    );
    expect(overriddenByName.get("INDEX.md")).toEqual({
      file: "INDEX.md",
      lines: 3,
      cap: 10,
    });
    expect(overriddenByName.get("activeContext.md")).toEqual({
      file: "activeContext.md",
      lines: 7,
      cap: 2,
    });
    expect(overriddenByName.get("style.md")).toEqual({
      file: "style.md",
      lines: 0,
      cap: 2,
    });
    expect(overriddenByName.get("decisions.md")).toEqual({
      file: "decisions.md",
      lines: 5,
    });

    // Counts only: no file body or content string can appear anywhere.
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("SECRET-CONTENT-MARKER");
    expect(serialized).not.toContain("handoff secret body");
    expect(serialized).not.toContain("archived");
    for (const file of health.files) {
      expect(Number.isInteger(file.lines) && file.lines >= 0).toBe(true);
      if (file.cap !== undefined) {
        expect(Number.isInteger(file.cap) && file.cap >= 0).toBe(true);
      }
    }
  });

  it("reads zeroes when the memory root and ledger are empty", async () => {
    const root = trackRoot(await mkdtemp(join(tmpdir(), "memory-metrics-empty-")));
    // A plain `handoffs` file (not a directory) must still resolve to counts.
    await writeFile(join(root, "handoffs"), "not a directory\n");
    const health = await collectHealth(root, new FakeStorage(), PROJECT);
    expect(health.files).toHaveLength(6);
    for (const file of health.files) {
      expect(file.lines).toBe(0);
      // decisions.md carries no cap (unbounded); bounded rows carry a cap int.
      if (file.cap !== undefined) {
        expect(Number.isInteger(file.cap) && file.cap > 0).toBe(true);
      }
    }
    expect(health.handoffs).toBe(0);
    expect(health.archive).toBe(0);
    expect(health.pending).toBe(0);
    expect(health.seen).toBe(0);
    expect(health.decisionsLines).toBe(0);
  });

  it("caps the seen count at 500 regardless of page count", async () => {
    // A nonexistent root: fs counters are 0; only the ledger matters here.
    const storage = new FakeStorage();
    for (let i = 0; i < 503; i += 1) {
      await storage.set(`${PROJECT}/seen/id-${i}`, i);
    }
    const health = await collectHealth("/nonexistent/memory/root", storage, PROJECT);
    expect(health.seen).toBe(500);
    expect(health.handoffs).toBe(0);
    expect(health.decisionsLines).toBe(0);

    // The scan result itself honors its limit across page granularity: the
    // suite's fake pages in 3-entry steps, so a limit of 7 stops at the
    // 9th collected entry and must resolve exactly the first 7 keys — 9
    // would mean a full extra page slipped past the bound.
    const nineSeen = new FakeStorage();
    for (let i = 0; i < 9; i += 1) {
      await nineSeen.set(`${PROJECT}/seen/id-${i}`, i);
    }
    const sliced = await scanAll(nineSeen, `${PROJECT}/seen/`, 7);
    expect(sliced).toHaveLength(7);
    expect(sliced[0]?.key).toBe(`${PROJECT}/seen/id-0`);
    expect(sliced[6]?.key).toBe(`${PROJECT}/seen/id-6`);
  });
});

/* ------------------------------------------------------------------ */
/* /memory-metrics command (§5.12 command row + G-M1, M-T5).           */
/* ------------------------------------------------------------------ */

interface AddedCommand {
  name: string;
  description?: string;
  execute: (input: {
    sessionID: string;
    prompt: {
      text: string;
      files?: unknown;
      agents?: unknown;
      skills?: unknown;
    };
    delivery: string;
  }) => Promise<void>;
}

/** Collect the (≤1) G-M1 deploy line out of a console.warn spy. */
function gm1Lines(warn: {
  mock: { calls: ReadonlyArray<unknown[]> };
}): ReadonlyArray<unknown[]> {
  return warn.mock.calls.filter(
    (call) =>
      typeof call[0] === "string" &&
      call[0]!.startsWith("[memory-metrics] synthetic posted"),
  );
}

/**
 * §5.12's `dashboard.shown` is "successful /memory-metrics render+post" —
 * one increment per resolved synthetic post. A reset's report is such a
 * post too, while the prompt fallback is the degraded model-turn channel
 * and never counts.
 */
async function drainAndCountShown(
  storage: LedgerStorage,
): Promise<number | undefined> {
  await settle();
  const value = await storage.get(totalKey(PROJECT, "dashboard.shown"));
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Minimal fake context for `registerMetricsCommand` — only what the
 * executor touches: options/location/storage + `command.transform` +
 * `session.synthetic`/`session.prompt` spies. */
function fakeForMetricsCommand(params?: {
  storage?: LedgerStorage;
  synthetic?: (input: unknown) => Promise<unknown>;
  prompt?: (input: unknown) => Promise<unknown>;
}) {
  const added: AddedCommand[] = [];
  const synthetic = vi.fn(async (_input: unknown): Promise<unknown> => undefined);
  const prompt = vi.fn(async (_input: unknown): Promise<unknown> => undefined);
  if (params?.synthetic !== undefined) {
    synthetic.mockImplementation(params.synthetic);
  }
  if (params?.prompt !== undefined) {
    prompt.mockImplementation(params.prompt);
  }
  const storage = params?.storage ?? new FakeStorage();
  const fakeCtx = {
    options: {},
    location: {
      directory: "/tmp/metrics-cmd",
      project: {
        id: PROJECT,
        directory: "/tmp/metrics-cmd",
        canonical: "/tmp/metrics-cmd",
      },
    },
    storage,
    command: {
      transform: async (
        cb: (editor: { add: (definition: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (definition) => added.push(definition) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      synthetic: (input: unknown) => synthetic(input),
      prompt: (input: unknown) => prompt(input),
    },
  };
  return {
    added,
    synthetic,
    prompt,
    // The executor only ever uses the LedgerStorage shape; the tests that
    // reach into `data` construct the default FakeStorage here.
    storage: storage as FakeStorage,
    fakeCtx: fakeCtx as unknown as Plugin.Context,
  };
}

function invokeOf(command: AddedCommand): (text: string) => Promise<void> {
  return (text) =>
    command.execute({
      sessionID: SESSION,
      prompt: { text, files: [], agents: [], skills: [] },
      delivery: "steer",
    });
}

/** Delegates to FakeStorage (reads + writes succeed, so the table renders
 * with real rows), but every `remove` throws — the reset WIPE itself can
 * never complete while everything else behaves. */
class NoRemoveStorage implements LedgerStorage {
  constructor(readonly inner: FakeStorage) {}
  async get(key: string): Promise<unknown> {
    return this.inner.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.inner.set(key, value);
  }
  async remove(_key: string): Promise<void> {
    throw new Error("remove down");
  }
  async scan(options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }> {
    return this.inner.scan(options);
  }
}

describe("memory-metrics command (§5.12 command row + G-M1, M-T5)", () => {
  it("command_posts_synthetic_and_logs_gm1_then_bumps_shown", async () => {
    // Seed one real counter so the table has a non-zero row + a since stamp.
    const storage = new FakeStorage();
    createBump(storage, PROJECT)("hook.prompt");
    await settle();
    const { added, fakeCtx, synthetic, storage: fakeStorage } =
      fakeForMetricsCommand({ storage });
    const registration = await registerMetricsCommand(fakeCtx);

    expect(added).toHaveLength(1);
    expect(added[0]!.name).toBe(MEMORY_METRICS_COMMAND_NAME);
    expect(MEMORY_METRICS_COMMAND_NAME).toBe("memory-metrics");
    expect(added[0]!.description).toBe(MEMORY_METRICS_COMMAND_DESCRIPTION);
    expect(MEMORY_METRICS_COMMAND_DESCRIPTION).toBe(
      "Local usage metrics dashboard for the memory plugin (stays on this machine)",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invoke = invokeOf(added[0]!);

    // First invocation: the table posts exactly once through synthetic (one
    // channel per execute — never synthetic AND prompt), and the run's own
    // bump lands after the post.
    await invoke("");
    expect(synthetic).toHaveBeenCalledTimes(1);
    const posted = synthetic.mock.calls[0]![0]! as {
      sessionID: string;
      text: string;
    };
    expect(Object.keys(posted).sort()).toEqual(["sessionID", "text"]);
    expect(posted.sessionID).toBe(SESSION);
    expect(posted.text).toContain("# [memory] metrics (local-only)");
    expect(posted.text).toContain("| hook.prompt | 1 |");
    // shown is bumped AFTER the post, so the freshly rendered table still
    // shows the pre-bump zero (deterministic ordering).
    expect(posted.text).toContain("| dashboard.shown | 0 |");

    await settle();
    expect(await fakeStorage.get(totalKey(PROJECT, "dashboard.shown"))).toBe(1);
    // G-M1: exactly one deploy line for the process's first resolved post,
    // carrying the first six chars of the sessionID.
    expect(gm1Lines(warn)).toHaveLength(1);
    expect(gm1Lines(warn)[0]![0]).toBe(
      "[memory-metrics] synthetic posted (sess-m); confirm the table rendered without a model turn",
    );

    // Second invocation: the line is once-per-PROCESS — never again, while
    // shown counts each successful render+post.
    await invoke("");
    expect(synthetic).toHaveBeenCalledTimes(2);
    expect(gm1Lines(warn)).toHaveLength(1);
    await settle();
    expect(await fakeStorage.get(totalKey(PROJECT, "dashboard.shown"))).toBe(2);
    expect(await drainAndCountShown(fakeStorage)).toBe(2);

    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("command_falls_back_to_prompt_on_synthetic_reject", async () => {
    const { added, fakeCtx, prompt, storage } = fakeForMetricsCommand({
      synthetic: async () => {
        throw new Error("synthetic surface drifted");
      },
    });
    const registration = await registerMetricsCommand(fakeCtx);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const invocationPrompt = {
      text: "",
      files: [{ uri: "file:///attached/notes.md" }],
      agents: [{ name: "primary" }],
      skills: [{ id: "memory-skill" }],
    };
    await expect(
      added[0]!.execute({
        sessionID: SESSION,
        prompt: invocationPrompt,
        delivery: "steer",
      }),
    ).resolves.toBeUndefined();

    // Exactly one fallback re-submission, §5.5 spread (P7): files/agents/
    // skills survive; sessionID + delivery come from the invocation; text
    // LAST so the ask wins.
    expect(prompt).toHaveBeenCalledTimes(1);
    const call = prompt.mock.calls[0]![0]! as Record<string, unknown>;
    expect(call["sessionID"]).toBe(SESSION);
    expect(call["delivery"]).toBe("steer");
    expect(call["files"]).toEqual(invocationPrompt.files);
    expect(call["agents"]).toEqual(invocationPrompt.agents);
    expect(call["skills"]).toEqual(invocationPrompt.skills);
    expect(call["text"]).toBe(METRICS_FALLBACK_ASK);
    // The ask instructs the agent to call memory_metrics and echo the table
    // verbatim — counts only, numbers never paraphrased.
    expect(METRICS_FALLBACK_ASK).toContain("memory_metrics");
    expect(METRICS_FALLBACK_ASK).toContain("verbatim");
    expect(METRICS_FALLBACK_ASK).toContain("do not paraphrase");

    // Nothing rendered+posted: dashboard.shown is NEVER bumped, and the
    // rejected post leaves storage untouched.
    expect(await drainAndCountShown(storage)).toBeUndefined();
    expect([...storage.data.keys()]).toEqual([]);
    // G-M1 stays silent: nothing was actually posted.
    expect(gm1Lines(warn)).toEqual([]);

    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("reset_removes_metrics_and_re_stamps_since", async () => {
    const storage = new FakeStorage();
    await storage.set(totalKey(PROJECT, "hook.prompt"), 3);
    await storage.set(dayKey(PROJECT, "20300101", "hook.prompt"), 2);
    await storage.set(armKey(PROJECT, SESSION), 1);
    await storage.set(sinceKey(PROJECT), "2030-01-01T00:00:00.000Z");
    // Everything OUTSIDE <projectID>/metrics/… must survive (US-29: the
    // reset is namespace-scoped numbers-only state): ledger keys, another
    // project's metrics, and a near-miss sibling prefix.
    await storage.set(`${PROJECT}/curation.pending`, 2);
    await storage.set(`${PROJECT}/seen/id-1`, 1);
    await storage.set("proj-other/metrics/total/hook.prompt", 9);
    await storage.set(`${PROJECT}/metrics-not-a-metric`, 5);

    const { added, fakeCtx, synthetic, storage: fresh } =
      fakeForMetricsCommand({ storage });
    const registration = await registerMetricsCommand(fakeCtx);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await added[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "reset" },
      delivery: "queue",
    });
    await settle();

    // Every seeded <projectID>/metrics/total|day|arm/… key is gone; the
    // namespace holds only the fresh since stamp + the two counters the
    // reset and its successful report just bumped themselves.
    const metricsKeys = [...storage.data.keys()]
      .filter((key) => key.startsWith(`${PROJECT}/metrics/`))
      .sort();
    const today = dayStampOf(Date.now());
    expect(metricsKeys).toEqual(
      [
        `${PROJECT}/metrics/day/${today}/dashboard.reset`,
        `${PROJECT}/metrics/day/${today}/dashboard.shown`,
        `${PROJECT}/metrics/since`,
        `${PROJECT}/metrics/total/dashboard.reset`,
        `${PROJECT}/metrics/total/dashboard.shown`,
      ].sort(),
    );
    const since = await readSince(storage, PROJECT);
    expect(since).toBeDefined();
    expect(since).not.toBe("2030-01-01T00:00:00.000Z");
    expect(await storage.get(totalKey(PROJECT, "dashboard.reset"))).toBe(1);

    // The report confirms the restart: the presented table is the fresh one
    // (Since = the new stamp; pre-reset counters rendered as present-but-0).
    expect(synthetic).toHaveBeenCalledTimes(1);
    const posted = synthetic.mock.calls[0]![0]! as {
      sessionID: string;
      text: string;
    };
    expect(posted.text).toContain(`Since: ${since}`);
    expect(posted.text).toContain("| hook.prompt | 0 |");
    expect(posted.text).not.toContain("| hook.prompt | 3 |");
    // The reset report is also a successful render+post (G-M1 line applies,
    // dashboard.shown counts it).
    expect(gm1Lines(warn)).toHaveLength(1);
    expect(await storage.get(totalKey(PROJECT, "dashboard.shown"))).toBe(1);

    // The wipe stayed inside the metrics namespace.
    expect(await storage.get("proj-other/metrics/total/hook.prompt")).toBe(9);
    expect(await storage.get(`${PROJECT}/seen/id-1`)).toBe(1);
    expect(await storage.get(`${PROJECT}/metrics-not-a-metric`)).toBe(5);
    expect(await storage.get(`${PROJECT}/curation.pending`)).toBe(2);
    expect(fresh).toBe(storage);

    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("reset_token_is_case_insensitive_and_unrelated_arguments_change_nothing", async () => {
    // "RESET" (incl. surrounding whitespace) resets.
    const upper = fakeForMetricsCommand();
    await registerMetricsCommand(upper.fakeCtx);
    await upper.storage.set(sinceKey(PROJECT), "2030-01-01T00:00:00.000Z");
    await upper.added[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "  RESET " },
      delivery: "steer",
    });
    await settle();
    expect(await upper.storage.get(totalKey(PROJECT, "dashboard.reset"))).toBe(
      1,
    );
    expect(
      (await readSince(upper.storage, PROJECT)) !==
        "2030-01-01T00:00:00.000Z",
    ).toBe(true);

    // "resetAll" is NOT the reset token: the command reports the dashboard,
    // but never wipes or bumps the reset counter.
    const other = fakeForMetricsCommand();
    await registerMetricsCommand(other.fakeCtx);
    await other.storage.set(sinceKey(PROJECT), "2030-01-01T00:00:00.000Z");
    await other.added[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "resetAll" },
      delivery: "steer",
    });
    await settle();
    expect(
      await other.storage.get(totalKey(PROJECT, "dashboard.reset")),
    ).toBeUndefined();
    expect(other.synthetic).toHaveBeenCalledTimes(1);
    // The seeded stamp was not re-stamped: only "reset" restarts metrics.
    expect(await readSince(other.storage, PROJECT)).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });

  it("reset_command_reports_through_table_channel_even_when_the_wipe_fails", async () => {
    // Seed a completed bump so the (unwiped) table has a nonzero row.
    const inner = new FakeStorage();
    createBump(inner, PROJECT)("hook.prompt");
    await settle();
    const { added, fakeCtx, synthetic, storage } = fakeForMetricsCommand({
      storage: new NoRemoveStorage(inner),
    });
    const registration = await registerMetricsCommand(fakeCtx);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await added[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "reset" },
      delivery: "steer",
    });
    await settle();

    // The wipe never completed (removes throw) — resolve-only executor, and
    // a reset that did not happen is never counted.
    expect(await storage.get(totalKey(PROJECT, "dashboard.reset"))).toBeUndefined();
    // The report still ran through the NORMAL table channel, on the intact
    // (unwiped) table: the seeded row still shows its real value.
    expect(synthetic).toHaveBeenCalledTimes(1);
    const posted = synthetic.mock.calls[0]![0]! as {
      sessionID: string;
      text: string;
    };
    expect(posted.sessionID).toBe(SESSION);
    expect(posted.text).toContain("# [memory] metrics (local-only)");
    expect(posted.text).toContain("| hook.prompt | 1 |");
    // The wipe-less report that resolved IS a successful render+post, so
    // dashboard.shown counts it (never the reset counter, which did not wipe).
    expect(await storage.get(totalKey(PROJECT, "dashboard.shown"))).toBe(1);
    // The wipe failure reached the logDiagnostic path.
    expect(
      warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0]!.startsWith("[memory] metrics diagnostic:"),
      ).length,
    ).toBeGreaterThan(0);

    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("executor_never_throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const diagnostics = () =>
      warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0]!.startsWith("[memory] metrics diagnostic:"),
      ).length;

    // (a) Storage fully down + both channels defaulting to reject: the reads
    // throw inside collectAndRender, so no post/fallback is even attempted.
    const down = fakeForMetricsCommand({
      storage: new ThrowingStorage(),
      synthetic: async () => {
        throw new Error("synthetic down");
      },
      prompt: async () => {
        throw new Error("prompt down");
      },
    });
    const downRegistration = await registerMetricsCommand(down.fakeCtx);
    await expect(
      down.added[0]!.execute({
        sessionID: SESSION,
        prompt: { text: "" },
        delivery: "steer",
      }),
    ).resolves.toBeUndefined();
    expect(down.synthetic).not.toHaveBeenCalled();
    expect(down.prompt).not.toHaveBeenCalled();
    expect(diagnostics()).toBeGreaterThan(0);
    expect(gm1Lines(warn)).toEqual([]);

    // (b) Healthy reads, but BOTH delivery channels reject: the table is
    // rendered, the post attempt rejects, the §5.5 fallback runs exactly once
    // and ITS rejection is caught too — the executor still resolves via
    // logDiagnostic only.
    const before = diagnostics();
    const healthy = fakeForMetricsCommand({
      synthetic: async () => {
        throw new Error("synthetic gone");
      },
      prompt: async () => {
        throw new Error("prompt gone");
      },
    });
    const healthyRegistration = await registerMetricsCommand(healthy.fakeCtx);
    await expect(
      healthy.added[0]!.execute({
        sessionID: SESSION,
        prompt: { text: "" },
        delivery: "steer",
      }),
    ).resolves.toBeUndefined();
    expect(healthy.synthetic).toHaveBeenCalledTimes(1);
    expect(healthy.prompt).toHaveBeenCalledTimes(1);
    expect(diagnostics()).toBeGreaterThan(before);
    await settle();
    // No bump was scheduled on either failure path.
    expect(
      await healthy.storage.get(totalKey(PROJECT, "dashboard.shown")),
    ).toBeUndefined();
    expect(
      await healthy.storage.get(totalKey(PROJECT, "dashboard.reset")),
    ).toBeUndefined();
    expect(gm1Lines(warn)).toHaveLength(0);

    await expect(downRegistration.dispose()).resolves.toBeUndefined();
    await expect(healthyRegistration.dispose()).resolves.toBeUndefined();
  });

  it("resetMetrics never throws and reports failure when storage is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(resetMetrics(new ThrowingStorage(), PROJECT)).resolves.toBe(
      false,
    );
    expect(
      warn.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0]!.startsWith("[memory] metrics diagnostic:"),
      ).length,
    ).toBeGreaterThan(0);
  });
});
