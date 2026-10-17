/**
 * Local usage metrics core (spec §5.12 + ADR-0008; M-T1).
 *
 * Count-only, on-machine self-measurement over the plugin-scoped storage
 * under `<projectID>/metrics/…`: monotonic total counters, UTC day buckets,
 * a lazy `since` first-write stamp, and the one binary arm flag (stored as
 * the int `1` so the number-only invariant holds; `since` is the sole
 * ISO-8601 timestamp string). Nothing free-text is ever stored — counter
 * names come only from the enumerated §5.12 vocabulary, so `redact` is
 * deliberately not applied.
 *
 * `bump` is fire-and-forget (ADR-0008 §3): it validates the name against the
 * fail-closed `METRIC_NAMES` set (unknown/malformed → warn-once + drop,
 * never throw), then schedules ONE `withWriteLock` body that writes the
 * total + day pair (+ `since` when absent or malformed), with its own catch
 * — bumps never delay or alter a hook outcome, never throw, and never
 * reject unhandled. `setArm`/`clearArm` are still awaited at their call
 * sites (hint hit + recall success) but stay never-throw and inside the
 * same mutex. Day buckets prune after 90 UTC days, piggybacked once per
 * UTC day per project off the first bump after a day change (fire-and-
 * forget; module-level last-prune stamps per process, keyed by projectID,
 * so one project's first bump cannot advance the stamp for other projects
 * in the same process). Best-effort statistics: losing a bump to a crash
 * or cross-process race is accepted, unlike the correctness ledger.
 *
 * `metrics.ts` imports `getPending` and the `LedgerStorage` type from
 * `capture.ts`; `capture.ts` imports `MetricsBump` only as a type (Task 3),
 * so both directions stay cycle-free at runtime.
 *
 * The `/memory-metrics` command (spec §5.12 command row + §1.3 G-M1; M-T5)
 * also lives here: its deps resolve per execute call (spec P22), a no-arg
 * invocation renders `collectAndRender` and posts the table through
 * `ctx.session.synthetic`, and a case-insensitive `reset` argument wipes the
 * whole `<projectID>/metrics/…` namespace (`resetMetrics`: paginated scan +
 * locked removes, then a fresh `since`) and reports the restarted table
 * through the same channel. G-M1 is a deploy-time human check: the FIRST
 * RESOLVED synthetic post of the process logs the §1.3 line once (module-
 * level stamp; a rejected post logs nothing — the line claims "posted").
 * On a post rejection the executor degrades to the §5.5 prompt spread with
 * `METRICS_FALLBACK_ASK` (agent calls `memory_metrics` and echoes the table
 * verbatim); the executor never throws — every failure path, including both
 * channels rejecting, resolves through `logDiagnostic` only. `src/review.ts`
 * bumps its `review.invoked` counter via `metricsBumpOf`; this module never
 * imports it (no cycle).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  countLines,
  getCapForFile,
  resolveMemoryRoot,
  withWriteLock,
} from "./files.js";
import { getPending, SEEN_LIMIT, type LedgerStorage } from "./capture.js";
import { DEFAULT_MEMORY_OPTIONS, parseMemoryOptions } from "./config.js";
import type { Plugin } from "@opencode/plugin";

/**
 * Lock-pinned ordered name list — the normative §5.12 counter vocabulary.
 * Published as `MetricName`'s union; renaming a counter breaks only the
 * continuity of self-comparison, never any memory data.
 */
const METRIC_NAME_LIST = [
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
] as const;

/** One enumerated §5.12 counter name. */
export type MetricName = (typeof METRIC_NAME_LIST)[number];

/** Exhaustive fail-closed vocabulary: unknown names are warned + dropped. */
export const METRIC_NAMES: ReadonlySet<string> = new Set<string>(
  METRIC_NAME_LIST,
);

/** Day buckets are pruned after this many UTC days (ADR-0008 §5). */
export const DAY_BUCKET_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_STAMP = /^\d{8}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Best-effort diagnostic log; logging must never break a hook. */
function logDiagnostic(error: unknown): void {
  try {
    console.warn("[memory] metrics diagnostic:", error);
  } catch {
    // Logging must never break a hook.
  }
}

/** Unknown/malformed requests warn exactly once per label (the first
 * `WARNED_LIMIT` labels per process, keeping the Set bounded under an
 * adversarial flood), then silently drop. */
const WARNED_LIMIT = 128;
const warned = new Set<string>();

function warnOnce(label: string): void {
  try {
    if (warned.has(label)) return;
    if (warned.size >= WARNED_LIMIT) return;
    warned.add(label);
    console.warn(
      `[memory] metrics: dropping unknown or malformed counter request: ${label}`,
    );
  } catch {
    // Logging must never break a hook.
  }
}

function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[memory] metrics ${name} must be a non-empty string`);
  }
  return value;
}

function projectPrefix(projectID: string): string {
  return `${requireNonEmpty("projectID", projectID)}/`;
}

/** `<projectID>/metrics/total/<name>` → int counter, monotonic until reset. */
export function totalKey(projectID: string, name: MetricName): string {
  return `${projectPrefix(projectID)}metrics/total/${requireNonEmpty("counter name", name)}`;
}

/** `<projectID>/metrics/day/<YYYYMMDD>/<name>` → int counter per UTC day. */
export function dayKey(
  projectID: string,
  stamp: string,
  name: MetricName,
): string {
  if (!DAY_STAMP.test(requireNonEmpty("day stamp", stamp))) {
    throw new Error(`[memory] metrics day stamp must be YYYYMMDD: ${stamp}`);
  }
  return `${projectPrefix(projectID)}metrics/day/${stamp}/${requireNonEmpty("counter name", name)}`;
}

/** `<projectID>/metrics/since` → ISO-8601 first-write timestamp. */
export function sinceKey(projectID: string): string {
  return `${projectPrefix(projectID)}metrics/since`;
}

/** `<projectID>/metrics/arm/hint/<sessionID>` → armed flag (int `1`). */
export function armKey(projectID: string, sessionID: string): string {
  return `${projectPrefix(projectID)}metrics/arm/hint/${requireNonEmpty("sessionID", sessionID)}`;
}

/** Any stored metrics value coerces to a non-negative int or 0 (numbers only). */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** UTC day stamp `YYYYMMDD` for a timestamp. */
function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Fire-and-forget counter bump; `void bump(...)` — callers never await. */
export type MetricsBump = (name: MetricName, by?: number) => void;

/**
 * Last piggyback-pruned UTC day, keyed by projectID: the prune piggybacks
 * at most once per UTC day per project per process, so one project's first
 * bump cannot advance the day stamp for other projects sharing the process
 * (and because these are module-level rather than closure fields, the
 * per-execute context adapters cannot prune on every tool call either).
 */
const lastPruneStamps = new Map<string, string>();

/**
 * G-M1 (§1.3) once-per-process stamp for the `/memory-metrics` command's
 * deploy-time line. Whether the TUI renders a synthetic post without
 * spawning a model turn is not type-provable, so the first RESOLVED
 * synthetic post of the process (the deploy event) logs one line a human
 * confirms at deploy time (`[memory-metrics] synthetic posted (<session6>);…`
 * — §1.3, mirroring the §1.3 event-type check). G-M1 is a deploy-time human
 * check, not a runtime branch: no runtime state can represent "confirmed
 * delivery", and a post that REJECTED logs nothing (the line claims
 * "posted"); the stamp only turns on after an actual post.
 */
let firstSyntheticPostLogged = false;

function logGm1SyntheticPostOnce(sessionID: string): void {
  if (firstSyntheticPostLogged) return;
  firstSyntheticPostLogged = true;
  try {
    console.warn(
      `[memory-metrics] synthetic posted (${sessionID.slice(0, 6)}); confirm the table rendered without a model turn`,
    );
  } catch {
    // Logging must never break a command.
  }
}

/**
 * Test seam: clear the once-per-process metrics state (prune piggyback
 * stamps, warned labels, and the G-M1 first-post line) between isolated
 * suites, mirroring `resetWriteChainForTests` (files.ts) /
 * `resetLedgerSingleFlightForTests` (capture.ts). No on-disk state;
 * production code never calls this.
 */
export function resetMetricsStateForTests(): void {
  lastPruneStamps.clear();
  warned.clear();
  firstSyntheticPostLogged = false;
}

/**
 * The metrics bump for one project: validates the counter name against
 * `METRIC_NAMES` fail-closed, then schedules one locked body writing the
 * total + day pair (+ `since` when absent or malformed — the write path
 * self-heals whatever `readSince` would reject). The first bump after a
 * UTC day change piggybacks a fire-and-forget `pruneDayBuckets`, at most
 * once per UTC day per project. Every failure path is caught: this never
 * throws synchronously and never rejects unhandled.
 */
export function createBump(
  storage: LedgerStorage,
  projectID: string,
): MetricsBump {
  const bump: MetricsBump = (name, by = 1) => {
    try {
      if (!METRIC_NAMES.has(name)) {
        warnOnce(name);
        return;
      }
      if (!Number.isInteger(by) || by <= 0) {
        warnOnce(`malformed-delta:${name}`);
        return;
      }
      const stamp = dayStamp(Date.now());
      void withWriteLock(async () => {
        const total = totalKey(projectID, name);
        const current = asCount(await storage.get(total));
        await storage.set(total, current + by);
        const day = dayKey(projectID, stamp, name);
        const dayCurrent = asCount(await storage.get(day));
        await storage.set(day, dayCurrent + by);
        const since = await storage.get(sinceKey(projectID));
        // Lazy first-write stamp; also self-heals a stored value that
        // `readSince` would reject (non-string/malformed), so the next
        // dashboard read always sees a valid ISO timestamp.
        if (typeof since !== "string" || !ISO_TIMESTAMP.test(since)) {
          await storage.set(sinceKey(projectID), new Date().toISOString());
        }
      }).catch(logDiagnostic);
      // Piggyback the bounded-state prune off the bump — at most once per
      // UTC day per project (per-process map), fire-and-forget, scheduled
      // after the write body so a synchronous throw here cannot delay the
      // counter itself.
      if (stamp !== lastPruneStamps.get(projectID)) {
        lastPruneStamps.set(projectID, stamp);
        void pruneDayBuckets(storage, projectID).catch(logDiagnostic);
      }
    } catch (error) {
      logDiagnostic(error);
    }
  };
  return bump;
}

/** Name-sorted shallow copy for deterministic reads. */
function sortRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(record).sort()) {
    out[name] = record[name];
  }
  return out;
}

/**
 * Drain a paginated scan via `after`/`next` (modeled on the seen prune),
 * collecting at most `limit` entries when given. The RESULT never exceeds
 * `limit`, even when one page spans past it (a port pages in
 * page-size steps — the trailing slice enforces the bound); the loop
 * merely stops early where it can. Exported as the module's shared
 * fail-closed scan walker so the page-granular slice contract is
 * directly testable.
 */
export async function scanAll(
  storage: LedgerStorage,
  prefix: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<Array<{ readonly key: string; readonly value: unknown }>> {
  const all: Array<{ key: string; value: unknown }> = [];
  let after: string | undefined;
  for (;;) {
    const page =
      after === undefined
        ? await storage.scan({ prefix })
        : await storage.scan({ prefix, after });
    for (const entry of page.entries) all.push(entry);
    // No-progress guard: a broken/fake port repeating the same cursor must
    // terminate, never hang the awaiting caller.
    if (page.next === undefined || page.next === after) break;
    // `limit` (health's seen count): stop paging once the bound is reached,
    // no matter how many pages the port still offers.
    if (all.length >= limit) break;
    after = page.next;
  }
  // The hard cap: a page-granular port can overshoot the loop break by up
  // to one whole page, so trim the result to the limit regardless.
  return all.length > limit ? all.slice(0, limit) : all;
}

/** Total counters (`Record<name, int>`); unknown names dropped, name-sorted. */
export async function readTotals(
  storage: LedgerStorage,
  projectID: string,
): Promise<Record<string, number>> {
  const prefix = `${projectPrefix(projectID)}metrics/total/`;
  const out: Record<string, number> = {};
  for (const entry of await scanAll(storage, prefix)) {
    if (!entry.key.startsWith(prefix)) continue;
    const name = entry.key.slice(prefix.length);
    if (!METRIC_NAMES.has(name)) continue;
    out[name] = asCount(entry.value);
  }
  return sortRecord(out);
}

/** Day buckets (`Record<stamp, Record<name, int>>`), stamp- and name-sorted. */
export async function readDays(
  storage: LedgerStorage,
  projectID: string,
): Promise<Record<string, Record<string, number>>> {
  const prefix = `${projectPrefix(projectID)}metrics/day/`;
  const out: Record<string, Record<string, number>> = {};
  for (const entry of await scanAll(storage, prefix)) {
    if (!entry.key.startsWith(prefix)) continue;
    // Exactly `<stamp>/<name>`: extra segments are not a counter we
    // recognize, so the key is skipped (fail-closed reads).
    const segments = entry.key.slice(prefix.length).split("/");
    if (segments.length !== 2) continue;
    const stamp = segments[0];
    if (!DAY_STAMP.test(stamp)) continue;
    const name = segments[1];
    if (!METRIC_NAMES.has(name)) continue;
    if (out[stamp] === undefined) out[stamp] = {};
    out[stamp][name] = asCount(entry.value);
  }
  const sorted: Record<string, Record<string, number>> = {};
  for (const stamp of Object.keys(out).sort()) {
    sorted[stamp] = sortRecord(out[stamp]);
  }
  return sorted;
}

/** First-write timestamp (ISO-8601), or `undefined` before the first bump. */
export async function readSince(
  storage: LedgerStorage,
  projectID: string,
): Promise<string | undefined> {
  const value = await storage.get(sinceKey(projectID));
  return typeof value === "string" && ISO_TIMESTAMP.test(value)
    ? value
    : undefined;
}

/** True when the session's hint arm flag is currently set (the int `1`). */
export async function readArmed(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<boolean> {
  return (await storage.get(armKey(projectID, sessionID))) === 1;
}

/**
 * Arm the hint→recall correlation for the session (arm value = int `1`).
 * Awaited at its call site (never-throw, same mutex as bumps).
 */
export async function setArm(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<void> {
  try {
    await withWriteLock(async () => {
      await storage.set(armKey(projectID, sessionID), 1);
    });
  } catch (error) {
    logDiagnostic(error);
  }
}

/** Clear a session's arm flag on first use. Awaited + never-throw like `setArm`. */
export async function clearArm(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<void> {
  try {
    await withWriteLock(async () => {
      await storage.remove(armKey(projectID, sessionID));
    });
  } catch (error) {
    logDiagnostic(error);
  }
}

/**
 * `/memory-metrics reset` (spec §5.12 storage keys + US-29): wipe the whole
 * `<projectID>/metrics/…` namespace — every total counter, day bucket, the
 * `since` stamp, and every arm flag — never another project's namespace and
 * never any key outside it (the wipe is namespace-scoped numbers-only state;
 * ledger keys like `curation.pending`/`seen/…` and other projects' metrics
 * are untouched). One locked body modeled on `pruneDayBuckets` (paginated
 * scan first, then removes), followed by a FRESH `since` stamp so the
 * restarted counters open on a new self-comparison window (the bumps that
 * follow keep the stamp valid from then on). The scan runs OUTSIDE the lock,
 * which is a deliberate, accepted race (best-effort per ADR-0008 §3): a bump
 * racing the scan may survive the wipe (its write lands after the removes)
 * or be counted-then-wiped — every in-process write serializes through the
 * same mutex, so two locked bodies can never corrupt the namespace, and the
 * lost window is a statistic, never the correctness ledger. The REMOVES
 * PRECEDE the `since` re-stamp inside the locked body: a failed remove
 * aborts BEFORE the re-stamp, leaving a partially wiped namespace still
 * covered by the old `since` window and returning `false` to the caller.
 * Reset is rare and user-initiated: like the arm ops it is awaited at its
 * call site and never rejects — every failure (scan, remove, re-stamp) is
 * caught, logged via `logDiagnostic`, and reported as `false`, and the
 * command still reports through its table channel either way.
 */
export async function resetMetrics(
  storage: LedgerStorage,
  projectID: string,
): Promise<boolean> {
  try {
    const prefix = `${projectPrefix(projectID)}metrics/`;
    const victims: string[] = [];
    for (const entry of await scanAll(storage, prefix)) {
      if (entry.key.startsWith(prefix)) victims.push(entry.key);
    }
    await withWriteLock(async () => {
      for (const victim of victims) {
        await storage.remove(victim);
      }
      await storage.set(sinceKey(projectID), new Date().toISOString());
    });
    return true;
  } catch (error) {
    logDiagnostic(error);
    return false;
  }
}

/**
 * Bound the day buckets to the last `DAY_BUCKET_RETENTION_DAYS` UTC days:
 * paginate `scan` via `after`/`next` over `<projectID>/metrics/day/`,
 * remove every bucket whose day stamp has fully aged out, and touch nothing
 * else — malformed day keys and other namespaces are left alone. Resolves
 * the number of keys removed.
 */
export async function pruneDayBuckets(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  const prefix = `${projectPrefix(projectID)}metrics/day/`;
  const cutoff = dayStamp(Date.now() - DAY_BUCKET_RETENTION_DAYS * DAY_MS);
  const victims: string[] = [];
  for (const entry of await scanAll(storage, prefix)) {
    if (!entry.key.startsWith(prefix)) continue;
    const stamp = entry.key.slice(prefix.length).split("/")[0];
    // Keep anything not resembling a day bucket (fail-closed reads too).
    if (stamp === undefined || !DAY_STAMP.test(stamp) || stamp > cutoff) {
      continue;
    }
    victims.push(entry.key);
  }
  if (victims.length === 0) return 0;
  await withWriteLock(async () => {
    for (const victim of victims) {
      await storage.remove(victim);
    }
  });
  return victims.length;
}

/* ------------------------------------------------------------------ */
/* Health collectors + dashboard renderer (spec §5.12 renderer         */
/* contract + ADR-0008; M-T2).                                        */
/* ------------------------------------------------------------------ */

/**
 * The six structural file names whose line counts the health block always
 * reports (ADR-0008: the only file names a metric may carry), listed in
 * name-sorted order so the rows render sorted for free.
 */
export const MEMORY_HEALTH_FILES = [
  "INDEX.md",
  "activeContext.md",
  "architecture.md",
  "decisions.md",
  "issues.md",
  "style.md",
] as const;

/** One of the six structural file names above. */
export type MemoryHealthFile = (typeof MEMORY_HEALTH_FILES)[number];

/** One health line-count row; `cap` is omitted for the unbounded file
 * (`decisions.md` keeps growing on disk per §6). */
export interface MemoryHealthFileLine {
  readonly file: MemoryHealthFile;
  readonly lines: number;
  readonly cap?: number;
}

/**
 * Count-only memory-file health (§5.12 renderer contract): per-file line
 * counts vs caps, `handoffs/` and `handoffs/archive/` file counts, pending,
 * seen-set size, and the decisions.md line count. No body of any file is
 * ever included — every field is a plain integer count.
 */
export interface MemoryHealth {
  readonly files: readonly MemoryHealthFileLine[];
  readonly handoffs: number;
  readonly archive: number;
  readonly pending: number;
  readonly seen: number;
  readonly decisionsLines: number;
}

/**
 * Renderer input, typed so a content-bearing string cannot reach
 * `renderMetricsDashboard`: counter names come only from the vocabulary,
 * and every record **value** is a `number` (ADR-0008 numbers-only rule,
 * mirrored at the type level). `since` is the storage layer's ISO stamp —
 * the renderer validates it against the same ISO regex before emitting.
 * Row-content safety does NOT follow from the loose outer key types alone
 * (the `days` stamp keys are bare `string`s, and a cast can plant
 * out-of-vocabulary names in a record): at runtime it holds via the
 * `DAY_STAMP`/`ISO_TIMESTAMP` filters and the vocabulary-driven
 * iteration — the hostile-input render inside
 * `renders_deterministically_and_has_no_content_channels` (test/
 * metrics.test.ts) is the standing guard.
 */
export interface MetricsDashboardInput {
  readonly since: string | undefined;
  readonly totals: Readonly<Partial<Record<MetricName, number>>>;
  readonly days: Readonly<
    Record<string, Readonly<Partial<Record<MetricName, number>>>>
  >;
  readonly health: MemoryHealth;
}

/**
 * §5.12 table partition: "explicit calls (recall/apply/review)" — the
 * seams a user actually invokes (memory_recall, memory_apply, the
 * review/metrics commands). Everything hook-triggered lands "behind the
 * scenes", including the hint→recall correlation per the same §5.12
 * sentence. Derived from the vocabulary (not hand-maintained) so no
 * counter can be forgotten.
 */
function isExplicitCall(name: MetricName): boolean {
  return (
    name.startsWith("recall.") ||
    name.startsWith("apply.") ||
    name === "review.invoked" ||
    name === "dashboard.shown" ||
    name === "dashboard.reset"
  );
}

/** Vocabulary in name-sorted order: the deterministic render order. */
const COUNTER_NAMES_SORTED: ReadonlyArray<MetricName> = [
  ...METRIC_NAME_LIST,
].sort();

/** Explicit-calls table rows (§5.12 "recall/apply/review (+ commands)"). */
const EXPLICIT_CALL_NAMES: ReadonlyArray<MetricName> =
  COUNTER_NAMES_SORTED.filter(isExplicitCall);

/** Behind-the-scenes table rows (hook-triggered + hint→recall). */
const BEHIND_THE_SCENES_NAMES: ReadonlyArray<MetricName> =
  COUNTER_NAMES_SORTED.filter((name) => !isExplicitCall(name));

/** Last 7 UTC day stamps surface in the budget-pressure view (§5.12). */
const BUDGET_WINDOW_DAYS = 7;

/**
 * A pure, deterministic markdown dashboard over `{since, totals, days,
 * health}` — §5.12 renderer contract: no fs, no storage, no clock inside
 * (the 7-day budget window is derived purely from the input's day
 * stamps). The only strings it can emit are the fixed furniture below,
 * counter names, the six structural file names, UTC day stamps, integers,
 * and the validated ISO `since` stamp — ADR-0008's numbers-only rule, with
 * the dashboard as the one deliberate (constrained) text surface.
 *
 * Titles, tables, and rows:
 * `# [memory] metrics (local-only)` + `Since: <ISO|->`; `## Explicit calls`
 * and `## Behind the scenes` render the whole vocabulary (present-but-0
 * rows for stability, §5.12 leaves the zero-row policy unspecified), name
 * sorted; `## Memory health` renders the six structural file rows (cap
 * column `-` where unbounded) then the §5.12 scalar block (handoffs,
 * archive, pending, seen, decisionsLines) in §5.12's field order;
 * `## Budget pressure` renders the last `BUDGET_WINDOW_DAYS` day stamps of
 * the input (by sort order), one row per counter actually bumped that day,
 * sorted (stamp, counter name).
 */
export function renderMetricsDashboard(input: MetricsDashboardInput): string {
  const lines: string[] = [];
  lines.push("# [memory] metrics (local-only)");
  // The ISO check mirrors `readSince`: malformed values render as `-`,
  // never as their raw text.
  lines.push(
    `Since: ${
      typeof input.since === "string" && ISO_TIMESTAMP.test(input.since)
        ? input.since
        : "-"
    }`,
  );

  const counterRows = (
    names: ReadonlyArray<MetricName>,
    record: Readonly<Partial<Record<MetricName, number>>>,
  ): void => {
    lines.push("| counter | count |");
    lines.push("|---|---:|");
    for (const name of names) {
      lines.push(`| ${name} | ${asCount(record[name])} |`);
    }
  };

  lines.push("");
  lines.push("## Explicit calls");
  counterRows(EXPLICIT_CALL_NAMES, input.totals);

  lines.push("");
  lines.push("## Behind the scenes");
  counterRows(BEHIND_THE_SCENES_NAMES, input.totals);

  lines.push("");
  lines.push("## Memory health");
  lines.push("| file | lines | cap |");
  lines.push("|---|---:|---:|");
  for (const file of input.health.files) {
    const cap = file.cap;
    lines.push(
      `| ${file.file} | ${asCount(file.lines)} | ${
        typeof cap === "number" && Number.isFinite(cap) ? asCount(cap) : "-"
      } |`,
    );
  }
  lines.push("");
  lines.push("| name | count |");
  lines.push("|---|---:|");
  lines.push(`| handoffs | ${asCount(input.health.handoffs)} |`);
  lines.push(`| archive | ${asCount(input.health.archive)} |`);
  lines.push(`| pending | ${asCount(input.health.pending)} |`);
  lines.push(`| seen | ${asCount(input.health.seen)} |`);
  lines.push(`| decisionsLines | ${asCount(input.health.decisionsLines)} |`);

  lines.push("");
  lines.push("## Budget pressure");
  lines.push("| day | counter | count |");
  lines.push("|---|---|---:|");
  for (const stamp of Object.keys(input.days)
    .filter((candidate) => DAY_STAMP.test(candidate))
    .sort()
    .slice(-BUDGET_WINDOW_DAYS)) {
    const day = input.days[stamp] ?? {};
    for (const name of COUNTER_NAMES_SORTED) {
      const value = day[name];
      // Only counters bumped that day surface (§5.12 leaves this
      // unspecified; present-in-bucket is the compact, deterministic
      // choice). Unknown keys in the record are skipped by construction.
      if (value === undefined) continue;
      lines.push(`| ${stamp} | ${name} | ${asCount(value)} |`);
    }
  }
  return lines.join("\n") + "\n";
}

/** True for filesystem misses (ENOENT/ENOTDIR/EISDIR): expected zeros, not faults. */
function isMissingEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** File line count via `readFile` + `countLines`; missing/unreadable → 0. */
async function readFileLineCount(root: string, file: string): Promise<number> {
  try {
    return countLines(await readFile(join(root, file), "utf8"));
  } catch (error) {
    if (!isMissingEntry(error)) logDiagnostic(error);
    return 0;
  }
}

/**
 * File count of a health directory; missing/unreadable → 0. Directory
 * entries that are directories themselves never count, so the nested
 * `handoffs/archive/` is not mistaken for a handoff file (§5.12 counts
 * `handoffs/` and `handoffs/archive/` file counts separately).
 */
async function countDirEntries(root: string, dir: string): Promise<number> {
  try {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    return entries.filter((entry) => !entry.isDirectory()).length;
  } catch (error) {
    if (!isMissingEntry(error)) logDiagnostic(error);
    return 0;
  }
}

/**
 * Seen-set size via paginated `scan` (same `after`/`next` walk the readers
 * use), bounded by the ledger's own `SEEN_LIMIT` (§6: the seen set prunes
 * to 500, so the dashboard never needs to page past that bound).
 */
async function countSeen(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  const prefix = `${projectPrefix(projectID)}seen/`;
  // `scanAll`'s contract keeps the result at `SEEN_LIMIT` even when the
  // port's final page would span past it — no second clamp needed here.
  const entries = await scanAll(storage, prefix, SEEN_LIMIT);
  return entries.length;
}

/**
 * Live memory health for the dashboard: line counts of the six structural
 * files (`readFile` + `countLines`, never bodies), directory file counts,
 * the stored `<projectID>/curation.pending` int (via `getPending`, the
 * ledger's own coercion), and the seen-set size. Returns counts only —
 * no file content ever leaves this function. Storage errors propagate the
 * same way `readTotals`/`readDays` do (the executor wraps them); fs misses
 * resolve to zero counts rather than failing the render.
 *
 * `caps` are the line caps the writers actually enforce: callers that
 * parse user options pass `parseMemoryOptions(ctx.options)` so the health
 * rows report the user's `indexLines`/`fileLines` — a configured cap is a
 * fact about this install, not a dashboard default. The config defaults
 * apply when omitted.
 */
export async function collectHealth(
  memoryRoot: string,
  storage: LedgerStorage,
  projectID: string,
  caps?: { indexLines: number; fileLines: number },
): Promise<MemoryHealth> {
  const root = resolveMemoryRoot(memoryRoot);
  // Defaults match `capsOf`'s fallback in `files.ts` — the same values the
  // writers run with when no user option overrides them.
  const indexLines = caps?.indexLines ?? DEFAULT_MEMORY_OPTIONS.indexLines;
  const fileLines = caps?.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines;
  let decisionsLines = 0;
  const files: MemoryHealthFileLine[] = [];
  for (const file of MEMORY_HEALTH_FILES) {
    const lines = await readFileLineCount(root, file);
    if (file === "decisions.md") decisionsLines = lines;
    // Same caps the writers enforce, through `files.ts`'s own cap resolver
    // (decisions.md → Infinity → cap omitted).
    const cap = getCapForFile(file, indexLines, fileLines);
    files.push(
      Number.isFinite(cap) ? { file, lines, cap } : { file, lines },
    );
  }
  return {
    files,
    handoffs: await countDirEntries(root, "handoffs"),
    archive: await countDirEntries(root, join("handoffs", "archive")),
    pending: await getPending(storage, projectID),
    seen: await countSeen(storage, projectID),
    decisionsLines,
  };
}

/**
 * Thin context adapter over the plugin context (same pattern as
 * `asLedger`/`ledgerOf`): structural port of `ctx.storage` + the projectID
 * derivation used elsewhere (`ctx.location.project?.id ??
 * ctx.location.directory`). Bumps resolve per adapter call, never captured
 * once at load (spec P22).
 */
export function metricsBumpOf(ctx: Plugin.Context): MetricsBump {
  const storage: LedgerStorage = {
    get: (key) => ctx.storage.get(key),
    set: (key, value) =>
      ctx.storage.set(
        key,
        value as Parameters<Plugin.Context["storage"]["set"]>[1],
      ),
    remove: (key) => ctx.storage.remove(key),
    scan: (options) => ctx.storage.scan(options),
  };
  return createBump(storage, ctx.location.project?.id ?? ctx.location.directory);
}

/**
 * Inputs for the dashboard glue `collectAndRender` — the caller resolves
 * every dep per call from the live plugin context (spec P22); nothing here
 * may be captured once at load. `caps` are the operative line caps the
 * writers actually enforce (`parseMemoryOptions(ctx.options)`), so the
 * health rows report this install's caps rather than config defaults.
 */
export interface CollectAndRenderDeps {
  /** Ledger storage port over the plugin-scoped `ctx.storage`. */
  readonly storage: LedgerStorage;
  /** Project identity of the metrics namespace. */
  readonly projectID: string;
  /** Absolute path to `.opencode/memory` (health collectors' fs root). */
  readonly memoryRoot: string;
  /** Operative caps: `parseMemoryOptions(ctx.options)`'s two numbers. */
  readonly caps: { readonly indexLines: number; readonly fileLines: number };
}

/**
 * Dashboard glue for the `memory_metrics` tool (spec §5.12 tool row): read
 * the counter records + `since` stamp and the on-disk health, then render
 * the deterministic markdown table. Storage/reader errors PROPAGATE from
 * here (throw-readers style, like `readTotals`/`readDays` — the executor
 * host decides how to surface them); filesystem misses already resolve to
 * zero counts inside `collectHealth`. Returns counts/text only — no memory
 * content ever enters the render.
 */
export async function collectAndRender(
  deps: CollectAndRenderDeps,
): Promise<string> {
  const [since, totals, days] = await Promise.all([
    readSince(deps.storage, deps.projectID),
    readTotals(deps.storage, deps.projectID),
    readDays(deps.storage, deps.projectID),
  ]);
  const health = await collectHealth(
    deps.memoryRoot,
    deps.storage,
    deps.projectID,
    deps.caps,
  );
  return renderMetricsDashboard({ since, totals, days, health });
}

/* ------------------------------------------------------------------ */
/* /memory-metrics command (§5.12 command row + §1.3 G-M1; M-T5).      */
/* ------------------------------------------------------------------ */

/** Fixed memory root, relative to the project (spec ADR-0006; not configurable). */
const MEMORY_DIR = ".opencode/memory";

export const MEMORY_METRICS_COMMAND_NAME = "memory-metrics";

/** §5.12 command row: the dashboard is local-only, and the description says so. */
export const MEMORY_METRICS_COMMAND_DESCRIPTION =
  "Local usage metrics dashboard for the memory plugin (stays on this machine)";

/**
 * Fallback ask (spec §5.12 command row): the synthetic post rejected, so the
 * dashboard degrades to one cheap model turn — the agent calls the read-only
 * `memory_metrics` tool itself and echoes the count table verbatim, exactly
 * as received (counts only; numbers are never paraphrased, summarized, or
 * rounded by the model turn).
 */
export const METRICS_FALLBACK_ASK =
  "The metrics dashboard could not be delivered as a synthetic post. Call the memory_metrics tool and echo the markdown table it returns verbatim, exactly as received — every count, name, and row in place. Counts only: do not paraphrase, summarize, reorder, or round any numbers, and add no commentary beyond the table (it is count-only plugin statistics).";

/** Adapt the plugin-scoped `ctx.storage` to the ledger's structural port. */
function ledgerOf(ctx: Plugin.Context): LedgerStorage {
  return {
    get: (key) => ctx.storage.get(key),
    set: (key, value) =>
      ctx.storage.set(
        key,
        value as Parameters<Plugin.Context["storage"]["set"]>[1],
      ),
    remove: (key) => ctx.storage.remove(key),
    scan: (options) => ctx.storage.scan(options),
  };
}

function projectIDOf(ctx: Plugin.Context): string {
  return ctx.location.project?.id ?? ctx.location.directory;
}

/** Absolute path to the project's fixed `.opencode/memory` root (health fs). */
function memoryRootOf(ctx: Plugin.Context): string {
  const base = (
    ctx.location.project?.canonical ?? ctx.location.directory
  ).replace(/\/+$/, "");
  return join(base, MEMORY_DIR);
}

/**
 * The `/memory-metrics [reset]` command (spec §5.12 command row). Execution
 * shape, per call (spec P22 — ledger, projectID, memory root, and caps all
 * resolve from the live context; nothing is captured at load):
 *
 * - no argument → `collectAndRender` → `ctx.session.synthetic({sessionID,
 *   text})` → on a RESOLVED post: the G-M1 first-post line (once per
 *   process, module-level stamp) + a fired-and-forgotten `dashboard.shown`
 *   bump (§5.12 "successful /memory-metrics render+post").
 * - case-insensitive `reset` token → `resetMetrics` (awaited, never
 *   rejecting — like the arm ops), `dashboard.reset` on a completed wipe,
 *   then the fresh (restarted) table through the SAME channel below.
 * - a rejected post → the §5.5 spread `{ ...prompt, sessionID, delivery,
 *   text: METRICS_FALLBACK_ASK }` (text last, wins; files/agents/skills
 *   survive, P7) — degraded to one model turn; no `dashboard.shown` bump on
 *   either degraded path.
 * - never throws: any failure (storage down, publish/fallback rejecting,
 *   a broken context) is caught here and degraded to `logDiagnostic` only,
 *   so the executor always resolves.
 *
 * Wiring note: `index.ts` registers this alongside `registerMemoryReview`;
 * the command never writes durable memory and resets nothing except on
 * `reset`.
 */
export function registerMetricsCommand(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_METRICS_COMMAND_NAME,
      description: MEMORY_METRICS_COMMAND_DESCRIPTION,
      execute: async ({ sessionID, prompt, delivery }) => {
        try {
          const bump = metricsBumpOf(ctx);
          // All deps for THIS call resolve from the live context (P22).
          const ledger = ledgerOf(ctx);
          const projectID = projectIDOf(ctx);
          // One argument: the (trimmed, case-insensitive) reset token.
          // Anything else renders the plain dashboard.
          const arg =
            typeof prompt?.text === "string" ? prompt.text.trim() : "";
          if (arg.toLowerCase() === "reset") {
            const reset = await resetMetrics(ledger, projectID);
            // Only a wipe that actually completed counts; the fire-and-
            // forget bump cannot delay or fail the command (ADR-0008 §3).
            if (reset) void bump("dashboard.reset");
          }
          // Caps per call (P22): the same parse setup runs, so the health
          // rows report this install's caps, whatever the options now are.
          const options = parseMemoryOptions(ctx.options);
          const table = await collectAndRender({
            storage: ledger,
            projectID,
            memoryRoot: memoryRootOf(ctx),
            caps: {
              indexLines: options.indexLines,
              fileLines: options.fileLines,
            },
          });
          // Post the table through the synthetic channel; on a rejection
          // degrade to the §5.5 pattern instead. The `return` in the catch
          // makes the post-success crossing structural: everything below
          // runs only after a RESOLVED post and can never co-fire with the
          // fallback (no `shown` bump and no G-M1 line on either degraded
          // path — enforced by shape, not by call-site convention).
          try {
            await ctx.session.synthetic({ sessionID, text: table });
          } catch {
            // Synthetic rejected: degrade to the §5.5 pattern. Awaited here
            // so its rejection is caught by the outer body.
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: METRICS_FALLBACK_ASK,
            });
            return;
          }
          // Deploy-time human check (§1.3 G-M1): once per process, first
          // resolved post only — never logged for a rejected post.
          logGm1SyntheticPostOnce(sessionID);
          // §5.12: this successful render+post counts (reset reports too).
          void bump("dashboard.shown");
        } catch (error) {
          logDiagnostic(error);
        }
      },
    });
  });
}
