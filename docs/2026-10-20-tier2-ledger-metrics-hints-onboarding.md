# Tier 2 UX Polish Implementation Plan

> **For workers:** Execute task-by-task via the `tdd` skill and close the branch with
> `verification-before-completion`. Review gates: `implementation-plan-review` (this file, before any
> code) and an independent implementation review (after all tasks). Same discipline as
> `docs/2026-10-19-tier1-status-and-search.md`: failing test first, `npx tsc --noEmit` +
> `npx vitest run` per task, one commit per task. Reuse existing helpers/fakes; never weaken or delete
> an existing assertion to make a task pass — extend it.

**Goal:** Ship the Tier-2 UX work from the 2026-10-19 repo analysis — four changes that keep the
plugin's own state bounded, make the metrics surface understandable and safe to reset, teach the
documented `remember:` form at the moment a user misses it, and turn first run into one actionable
install checklist:

- **E9 — Ledger hygiene:** `attempt/*`, `hint/*`, `snapshot/*`, and `snapshotThrottle/*` currently
  grow forever. Bound them with deterministic retention, reusing the existing once-per-UTC-day
  housekeeping piggyback. Snapshot hashes gain a timestamp so they can age; legacy string values are
  migrated by removal on the first pass (a possible one-time duplicate handoff, documented).
- **E10 — Metrics polish:** the dashboard gains a fixed human-readable `meaning` column for every
  counter, and `/memory-metrics reset` becomes two-step (`reset` explains; `reset confirm` wipes), so
  an accidental reset cannot destroy the local history. No new counter names (ADR-0008 vocabulary
  stays frozen), no new option (ADR-0006 stays at five).
- **E11 — `remember:` near-miss nudge:** when the latest user text looks like a memory request but
  is not one of the documented line-start forms, the context hook emits one `[memory-hint]` line
  explaining the exact form. It shares the existing once-per-prompt hint throttle and the one hint
  slot; it never arms the hint→recall correlation because it is not a recall call-to-action.
- **E12 — First-run checklist + quickstart:** first run prints one consolidated install message
  (required permission rule, protocol block, optional options snippet, `/memory-status` pointer)
  instead of a separate warning + dump. The README gains a five-minute quickstart. The
  `memory-manager` presence check already shipped in Tier 1 (`memory_status`) and is **not**
  duplicated.

**Architecture:** Changes stay inside the existing seams:

`src/capture.ts` (retention + timestamped snapshot values) → `src/metrics.ts` (labels, reset
confirmation, daily-piggyback call) → `src/provenance.ts` (pure near-miss detector) → `src/hints.ts`
(near-miss hint + shared throttle) → `src/index.ts` (context-hook precedence/arming + first-run
print) → `src/templates.ts` (first-run text). No new module, no new dependency, no new option, no
new metric name, and no new memory-file write path.

**Tech Stack:** TypeScript `strict: true`, `type: module`, pinned `@opencode/plugin@2.0.29`;
`ctx.storage` (`get/set/remove/scan`), `withWriteLock`, `node:fs/promises`; `vitest` +
`npx tsc --noEmit` gates.

**References:** `docs/design-spec-v2-production.md` §§4.4 (install/permissions), 5.2 (context hook),
5.11 (provenance), 5.12 (metrics/command), 6 (data model/ledger), 7 (lifecycle), 9 (gates), 10
(roadmap); `docs/adr/0004-ledger-and-promotion.md` (ledger idempotency), `0006` (five options),
`0008-local-usage-metrics.md` (numbers-only vocabulary, reset, labels); `docs/user-stories.md`
US-04/26/28/29; `docs/c4-05-data-model.md` (ledger + metrics rows), `docs/c4-06-code.md`
(`matchIndex`, `snapshotHandoffIfChanged`, `ledger`); `README.md` §§Quickstart/Install/Budgets/
Tools/Metrics; `CHANGELOG.md` (Unreleased).

**Branch:** `feature/tier2-ux-polish` (created from `main` at `f806ddb`, already checked out; the
plan itself is committed first, before code).

---

## Non-goals (explicitly deferred — do NOT touch)

- E8 (brief re-emission cost), E13 (forget/purge + handoff GC, US-22 — needs an ADR revision), and
  E14 (cross-process write safety). They remain Tier 3/deferred.
- No FTS, embeddings, fuzzy search, TTL/decay, or TUI panel (spec §8 D-C/D-D/D-G are intentional).
- No sixth plugin option (ADR-0006: exactly five). No new metric name: the ADR-0008 vocabulary must
  stay exactly the 45 enumerated names.
- No change to memory-file write behavior, budgets, injection order, provenance classification, or
  `/memory-review`/`memory_apply`.
- No `architecture.md`/`style.md`/`issues.md` content changes; no edits to `agents/memory-manager.md`
  or `commands/*.md`.
- No new dependency and no version bump (release work is separate).

---

## File Structure

**Source**

- Modify `src/capture.ts` — retention constants; timestamped snapshot records; `pruneLedgerState`;
  `setSnapshotHash` accepts `now`; `getSnapshotHash` reads both record and legacy string.
- Modify `src/metrics.ts` — `METRIC_LABELS`; renderer `meaning` column; `reset confirm` handling +
  fixed confirmation notice; daily piggyback calls `pruneLedgerState`.
- Modify `src/provenance.ts` — pure `isRememberNearMiss`.
- Modify `src/hints.ts` — `matchRememberNearMiss` sharing `hint/<session>/<promptHash>` throttle.
- Modify `src/index.ts` — near-miss hint precedence + arm only on a real INDEX hint; consolidated
  first-run install message (one `console.warn`).
- Modify `src/templates.ts` — `firstRunInstallText()` built from the existing snippets/block.

**Tests**

- Modify `test/ledger.test.ts` — retention, pagination, snapshot record round-trip.
- Modify `test/metrics.test.ts` — labels, reset confirmation, daily ledger-prune piggyback.
- Modify `test/provenance.test.ts` — near-miss detection table.
- Modify `test/hooks.test.ts` — near-miss hint emission, precedence, throttle, no arm; existing
  hint/arm tests stay green.
- Modify `test/scaffold.test.ts` — consolidated first-run output.
- Modify `test/acceptance-metrics.test.ts` — reset confirmation and label-aware exact rows.
- Modify `test/tools.test.ts` — label-aware exact dashboard rows.

**Docs**

- Modify `README.md` — Quickstart; hint behavior; labels; reset confirmation; ledger retention.
- Modify `CHANGELOG.md` — Unreleased entries for E9–E12.
- Modify `docs/design-spec-v2-production.md` — §§5.2, 5.11, 5.12, 6, 7, 9, 10.
- Modify `docs/adr/0004-ledger-and-promotion.md` — ledger pruning/retention note.
- Modify `docs/adr/0008-local-usage-metrics.md` — labels + two-step reset amendment.
- Modify `docs/user-stories.md` — US-29 amendment, US-04 amendment, new US-32.
- Modify `docs/c4-05-data-model.md`, `docs/c4-06-code.md` — ledger row, hint/snapshot descriptions.
- Modify `docs/c4-02-containers.md`, `docs/c4-03-components.md`, `docs/c4-04-interfaces.md` —
  stale seen-only-prune / one-step-reset descriptions.

**Dependency order:** Task 1 (E9) → Task 2 (E10a) → Task 3 (E10b) → Task 4 (E11) → Task 5 (E12) →
Task 6 (docs) → Task 7 (final gate). Tasks 1 and 4 are logically independent, but both touch
`test/hooks.test.ts`/shared fakes and `src/index.ts` call sites; run them sequentially to keep each
commit reviewable. Task 6 needs every user-visible string frozen by Tasks 1–5.

---

## Background the implementer needs

### Current state (verified 2026-10-20 on `main` after Tier 1, commit `f806ddb`)

- Baseline gates are green: `npx tsc --noEmit` passes; `npx vitest run` passes **15 files / 298
  tests**.
- `src/capture.ts` owns the ledger:
  - keys: `seenKey`, `attemptKey`, `pendingKey`, `rotatedKey`, `snapshotKey`,
    `throttleKey`, `hintKey`;
  - `pruneSeenTo500` paginates `<projectID>/seen/` via `scan({prefix, after})`, sorts oldest-first,
    and removes the overflow under `withWriteLock`;
  - `getSnapshotHash`/`setSnapshotHash` store a **plain string hash** under
    `<projectID>/snapshot/<sessionID>`;
  - `getThrottle`/`setThrottle` store a number under `<projectID>/snapshotThrottle/<sessionID>`;
  - `hasHint`/`setHint` store a timestamp under `<projectID>/hint/<sessionID>/<promptHash>`;
  - `markAttempt` stores a timestamp under `<projectID>/attempt/<contentID>`, and `shouldRetry`
    treats values older than `RETRY_WINDOW_MS` (30s) as abandoned but never removes them.
- `src/metrics.ts`:
  - `METRIC_NAME_LIST` has exactly 45 names; `createBump` writes total + day + lazy `since`, then on
    the first bump after a UTC day change (per project, per process) calls
    `pruneDayBuckets(...).catch(logDiagnostic)`;
  - `renderMetricsDashboard` is pure and emits `| counter | count |` rows for explicit calls and
    behind-the-scenes counters, `| name | count |` health rows, and
    `| day | counter | count |` budget rows;
  - `registerMetricsCommand` treats any case-insensitive `reset` argument as an immediate wipe,
    re-posts the table, and bumps `dashboard.reset` on a completed wipe.
- `src/provenance.ts` detects only line-start `remember:` / `remember that` directives outside
  fences/quotes (`directiveFact` + `visibleLines`); everything else is `tool`.
- `src/hints.ts` `matchIndex` extracts the latest user-authored text, matches a whole INDEX term,
  throttles once per prompt hash via `hasHint`/`setHint`, and returns one `[memory-hint]` line.
- `src/index.ts` context hook currently computes exactly one `hint` via `matchIndex`, pushes it,
  bumps `hint.shown`, and `setArm`s the hint→recall correlation whenever `hint !== undefined`.
- `src/index.ts` setup currently prints the permissions warning on every setup and, on first run,
  a separate `console.log` with the options snippet + protocol block. Tier 1 added the non-first-run
  AGENTS.md nudge and `memory_status` agent/module checks.
- `test/ledger.test.ts` `FakeStorage` supports a configurable page size
  (`new FakeStorage(pageSize)`); the `FakeStorage` in `test/metrics.test.ts` uses a fixed page size
  and must not be changed for Task 1. `test/hooks.test.ts` `setupHooks` drives the real plugin setup
  against a temp root and fake storage; `contextEvent` wraps a `userMessage(text)`.

### Design decisions (locked)

1. **Retention is fixed, not configurable.** No sixth option. Attempts are abandoned after the
   existing 30s retry window, so aged attempt keys are semantically identical to absent keys and are
   removed. Prompt-hint keys are aged at **7 UTC days**; snapshot hashes and throttle stamps at
   **30 UTC days**. A repeated prompt after 7 days may hint once more, and a resumed session after
   30 days may write one duplicate handoff — both are benign and documented; no memory content is
   affected.
2. **Snapshot values carry their age.** `setSnapshotHash` stores
   `{ hash: string, at: number }` under the same key; `getSnapshotHash` accepts that record and the
   legacy plain-string form. `pruneLedgerState` removes aged records. Legacy plain-string values
   carry no timestamp and are removed on the first prune pass: this is a one-time upgrade
   normalization with a possible single duplicate handoff for a session resumed across the upgrade;
   it is preferable to leaving unageable keys forever. The hash itself remains opaque and is never
   emitted.
3. **Pruning reuses the daily metrics piggyback.** `createBump` already has a per-project,
   once-per-UTC-day-per-process gate and the only guaranteed cross-hook activity; it calls
   `pruneLedgerState` beside `pruneDayBuckets` (both fire-and-forget, both `.catch(logDiagnostic)`).
   No new storage key and no new timer. The prune scans outside the lock and re-checks each victim
   under `withWriteLock` before removing, so an in-process write that lands between scan and remove
   is never deleted; cross-process races remain best-effort like every other ledger prune.
4. **Prune is project-scoped and fail-closed on malformed state.** Only the exact
   `<projectID>/attempt/`, `<projectID>/hint/`, `<projectID>/snapshot/`, and
   `<projectID>/snapshotThrottle/` prefixes are touched. Non-numeric hint/throttle values are left
   alone (a present key suppresses a re-hint; deleting it would change behavior); malformed attempt
   values are left alone too. A storage failure propagates to the caller's existing
   `.catch(logDiagnostic)` and never reaches a hook.
5. **Labels are fixed display furniture, not content.** `METRIC_LABELS` is an exhaustive
   `Record<MetricName, string>` of static prose; no input can reach it. The renderer gains one
   `meaning` column; counter names remain the row identity so existing vocabulary assertions and
   budget-pressure ordering stay intact.
6. **Reset is two-step and deterministic.** Bare `reset` (case-insensitive, whitespace-normalized)
   never wipes: it renders the dashboard prefixed with one fixed notice telling the user to run
   `/memory-metrics reset confirm`. Only `reset confirm` calls `resetMetrics`, bumps
   `dashboard.reset` on a completed wipe, and re-posts the fresh table. Both paths bump
   `dashboard.shown` because both successfully rendered+posted. No new counter distinguishes the
   steps (vocabulary frozen). On a rejected synthetic post, the fallback prompt carries the same
   fixed notice when the request was a bare reset.
7. **Near-miss detection is narrow and pure.** `isRememberNearMiss(text)` returns true only when:
   no valid directive fact exists in the text; and a visible (non-fenced, non-blockquoted) line,
   after inline-code removal and trimming, starts with an optional politeness prefix
   (`please`, `kindly`, `can you`, `could you`, `would you`) followed by `remember`; and the word
   after `remember` is not a narrative wh-word (`when`, `how`, `what`, `where`, `who`, `why`).
   Thus `remember:`/`remember that` valid directives, `I remember…`, `we should remember…`, and
   fenced/quoted text never nudge; `Please remember: X`, `remember X`, bare `remember:`, and
   `can you remember that X` do.
8. **The near-miss hint shares the one hint slot and the existing throttle.** `matchRememberNearMiss`
   uses the same `<projectID>/hint/<sessionID>/<promptHash>` key as `matchIndex`; it returns at most
   one `[memory-hint]` line. The context hook prefers the near-miss line when both apply. Only a
   real INDEX hint (`matchIndex` result) arms `<projectID>/metrics/arm/hint/<sessionID>`; a
   near-miss nudge never arms, so a later recall cannot inflate `hint.recall`. `hint.shown` still
   counts either line (it is a hint shown; no new counter).
9. **First-run output is one message, not two.** `firstRunInstallText()` composes the existing
   `permissionsSnippet()`, `AGENTS_PROTOCOL_BLOCK`, and `optionsSnippet()` with a numbered checklist
   and `/memory-status` pointer. First run emits it through one `console.warn`; non-first-run keeps
   the spec §4.4 unconditional permissions warning and the Tier-0 AGENTS nudge. No snippet text
   changes, so the spec byte-exact protocol-block test stays green.
10. **Docs are part of the feature.** Every user-visible string and storage-shape change lands in
    the spec, ADRs, user stories, C4 data/code docs, README, and CHANGELOG in the same branch.

### Contract summary

| Surface | Input | Output | Side effects |
|---|---|---|---|
| `pruneLedgerState(storage, projectID)` | ledger | number removed | removes aged project-scoped ledger keys only |
| `setSnapshotHash(..., hash, now?)` | hash + clock | — | stores `{hash, at}` under `snapshot/<session>` |
| `renderMetricsDashboard(input)` | counts + health | deterministic markdown | none |
| `/memory-metrics reset` | command | dashboard + fixed notice | `dashboard.shown` only |
| `/memory-metrics reset confirm` | command | fresh dashboard | wipe + `dashboard.reset` + `dashboard.shown` |
| `matchRememberNearMiss(input, options)` | latest user text | one hint line or `undefined` | `hint/<session>/<promptHash>` throttle write |
| `firstRunInstallText()` | — | one checklist string | none |

---

## Task 0: Commit this plan (orchestrator, after the review loop)

The plan is committed **before** implementation, per the delivery flow:

```bash
git add docs/2026-10-20-tier2-ledger-metrics-hints-onboarding.md
git commit -m "docs: tier 2 ledger, metrics, hints, onboarding plan"
```

Do not start Task 1 until the independent plan review is green and this commit exists.

---

## Task 1 (E9): Bound ledger state — `src/capture.ts`, `src/metrics.ts`, `test/ledger.test.ts`, `test/metrics.test.ts`

### Failing tests first

Add to `test/ledger.test.ts` (imports gain `pruneLedgerState`, `HINT_RETENTION_MS`,
`SNAPSHOT_RETENTION_MS`, `ATTEMPT_RETENTION_MS`, and the snapshot record type if exported):

```ts
describe("pruneLedgerState (bounded ledger keys)", () => {
  it("removes abandoned attempts, aged hints, and aged session state", async () => {
    const storage = new FakeStorage();
    const now = Date.UTC(2035, 0, 1);
    // attempt: aged by the existing 30s retry window
    await storage.set(attemptKey(PROJECT, "old"), now - ATTEMPT_RETENTION_MS - 1);
    await storage.set(attemptKey(PROJECT, "fresh"), now - 1000);
    await storage.set(attemptKey(PROJECT, "future"), now + 1000);
    await storage.set(attemptKey(PROJECT, "junk"), "not-a-number");
    // hint: 7-day retention
    await storage.set(hintKey(PROJECT, "s1", "old"), now - HINT_RETENTION_MS - 1);
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
      [...storage.data.keys()].filter((key) => key.startsWith(`${PROJECT}/hint/`)),
    ).toHaveLength(0);
  });

  it("re-checks a key under the lock before removing it", async () => {
    // Simulate a write landing between scan and remove: `scan` reports the
    // value as aged, while the durable `get` returns the fresh timestamp.
    class StaleScanStorage extends FakeStorage {
      override async scan(options: {
        prefix: string;
        after?: string;
        limit?: number;
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
    await expect(pruneLedgerState(new ThrowingStorage(), PROJECT)).rejects.toThrow(
      "storage down",
    );
  });
});
```

Extend the existing snapshot round-trip test in `test/ledger.test.ts`:

```ts
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
```

Add to `test/metrics.test.ts` inside `describe("once-per-UTC-day prune piggyback")`:

```ts
it("also prunes aged ledger state on the first bump after a day change", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const base = Date.UTC(2035, 5, 2);
  vi.setSystemTime(base);
  const storage = new FakeStorage();
  await storage.set(
    hintKey(PROJECT, "s1", "old"),
    base - HINT_RETENTION_MS - 1,
  );
  const bump = createBump(storage, PROJECT);
  bump("hook.prompt");
  await settle();
  expect(await storage.get(hintKey(PROJECT, "s1", "old"))).toBeUndefined();
  // Same UTC day: a re-planted old key survives (no second prune).
  await storage.set(
    hintKey(PROJECT, "s1", "old"),
    base - HINT_RETENTION_MS - 1,
  );
  bump("hint.recall");
  await settle();
  expect(await storage.get(hintKey(PROJECT, "s1", "old"))).toBeDefined();
});
```

Add a `ThrowingStorage` to `test/ledger.test.ts` if one is not already present.

### Implementation

In `src/capture.ts`:

```ts
/** Attempts older than the retry window are semantically abandoned. */
export const ATTEMPT_RETENTION_MS = RETRY_WINDOW_MS;
/** Prompt-hint throttle keys are bounded to one week. */
export const HINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Snapshot hashes and throttle stamps are bounded to 30 days. */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SnapshotRecord {
  readonly hash: string;
  readonly at: number;
}
```

- Change `snapshotKey` doc to `{hash, at} | legacy string`.
- `setSnapshotHash(storage, projectID, sessionID, hash, now = Date.now())` writes
  `{ hash, at: now }` inside `withWriteLock`.
- `getSnapshotHash` returns the string for the legacy form, `value.hash` for a record with a string
  `hash`, and `undefined` otherwise.
- Add `pruneLedgerState(storage, projectID, now = Date.now())`:
  - paginate each of the four prefixes with the same `scan`/`after`/`next` walker used by
    `pruneSeenTo500` (factor a private `scanEntries(storage, prefix)` helper and reuse it in
    `pruneSeenTo500` if that stays simple; otherwise duplicate the 12-line walker);
  - classify victims outside the lock:
    - attempt: numeric finite value and `now - value >= ATTEMPT_RETENTION_MS`;
    - hint: numeric finite value and `now - value >= HINT_RETENTION_MS`;
    - throttle: numeric finite value and `now - value >= SNAPSHOT_RETENTION_MS`;
    - snapshot: either a legacy string (normalize out) or a record with a finite `at` and
      `now - at >= SNAPSHOT_RETENTION_MS`;
  - under one `withWriteLock`, re-read each victim and remove it only if it still matches the same
    classification (snapshot legacy strings always match; records must still be aged). Keep the
    remove loop inside a single lock so it serializes against in-process writes.
  - return the number actually removed.
- Wire `pruneLedgerState` into `src/metrics.ts` `createBump`'s existing day-change block:

```ts
if (stamp !== lastPruneStamps.get(projectID)) {
  lastPruneStamps.set(projectID, stamp);
  void pruneDayBuckets(storage, projectID).catch(logDiagnostic);
  void pruneLedgerState(storage, projectID).catch(logDiagnostic);
}
```

Import `pruneLedgerState` from `./capture.js`; the existing `metrics.ts → capture.ts` runtime import
already exists (`getPending`, `SEEN_LIMIT`), so no cycle is introduced (`capture.ts` imports only the
`MetricsBump` type from `metrics.ts`).

Do **not** remove attempt keys on the success path in this task: a removal failure after a landed
append must not change the capture outcome. The daily prune handles them.

### Verify

```bash
npx vitest run test/ledger.test.ts test/metrics.test.ts
npx tsc --noEmit
```

Commit: `feat: bound ledger attempt, hint, and snapshot state (E9)`.

---

## Task 2 (E10a): Human-readable dashboard labels — `src/metrics.ts`, `test/metrics.test.ts`

### Failing tests first

Add to `test/metrics.test.ts`:

```ts
describe("metric labels (E10a)", () => {
  it("labels every enumerated counter exactly once, with fixed text", () => {
    // `METRIC_NAMES` is the exported fail-closed Set; the underlying
    // `METRIC_NAME_LIST` is module-private.
    expect(Object.keys(METRIC_LABELS).sort()).toEqual([...METRIC_NAMES].sort());
    for (const [name, label] of Object.entries(METRIC_LABELS)) {
      expect(label.trim().length, name).toBeGreaterThan(0);
      expect(label).not.toMatch(/[|\n\r]/);
    }
    // Labels are display-only fixed prose, never derived from input.
    expect(METRIC_LABELS["hook.prompt"]).toBe("prompt hook runs");
    expect(METRIC_LABELS["hint.recall"]).toBe("hints followed by recall");
  });

  it("renders the meaning column in both counter tables and budget rows", () => {
    const table = renderMetricsDashboard(makeFixture());
    expect(table).toContain("| counter | meaning | count |");
    expect(table).toContain("| hook.prompt | prompt hook runs | 2 |");
    expect(table).toContain("| recall.INDEX.md | recall INDEX.md | 1 |");
    expect(table).toContain("| 20310102 | apply.lines | candidate lines applied | 5 |");
  });
});
```

Update the existing renderer tests:

- `renders_deterministically_and_has_no_content_channels` — add `"meaning"` to `FURNITURE`; allow
  every value of `METRIC_LABELS` in the token whitelist; update exact row assertions to the
  three-column shape.
- `renders_scrambled_day_insertion_byte_identical` stays unchanged.
- The budget-pressure parser still uses `row.split("|")[2]` for the counter name (day is cell 1,
  counter is cell 2); update only the count cell index if the test reads it.
- Update all exact row strings in `test/metrics.test.ts`, `test/acceptance-metrics.test.ts`, and
  `test/tools.test.ts` (grep for `| hook.prompt |`, `| dashboard.shown |`, `| apply.lines |`,
  `| recall.INDEX.md |`).

### Implementation

Add an exhaustive label map to `src/metrics.ts`:

```ts
export const METRIC_LABELS = {
  "hook.prompt": "prompt hook runs",
  "hook.context": "context hook runs",
  "hook.compaction": "compaction hook runs",
  "index.attach": "INDEX attached",
  "index.overCap": "INDEX over cap (not attached)",
  "index.already": "INDEX already attached",
  "remember.caught": "remember directives captured",
  "brief.empty": "brief empty",
  "brief.injected": "brief injected",
  "brief.lines": "brief lines injected",
  "brief.truncated": "brief truncated by budget",
  "status.shown": "status line shown",
  "status.dropped": "status line dropped by budget",
  "hint.shown": "memory hints shown",
  "compaction.priors": "priors injected on compaction",
  "priors.lines": "priors lines injected",
  "failure.captured": "failures captured",
  "failure.duplicate": "failure captures deduped",
  "failure.retry": "failure captures retried",
  "failure.failed": "failure captures failed",
  "snapshot.written": "handoff snapshots written",
  "snapshot.unchanged": "handoff snapshots unchanged",
  "snapshot.dropped": "handoff snapshots dropped",
  "snapshot.failed": "handoff snapshots failed",
  "compactionCapture.captured": "compaction summaries captured",
  "compactionCapture.duplicate": "compaction summaries deduped",
  "compactionCapture.dropped": "compaction summaries dropped",
  "compactionCapture.failed": "compaction summaries failed",
  "recall.INDEX.md": "recall INDEX.md",
  "recall.activeContext.md": "recall activeContext.md",
  "recall.decisions.md": "recall decisions.md",
  "recall.architecture.md": "recall architecture.md",
  "recall.style.md": "recall style.md",
  "recall.issues.md": "recall issues.md",
  "recall.handoff": "recall handoffs",
  "recall.error": "recall errors",
  "apply.batch": "apply calls",
  "apply.lines": "candidate lines applied",
  "apply.denied": "candidate lines denied",
  "apply.partialError": "apply partial failures",
  "apply.reset": "apply resets",
  "review.invoked": "review invocations",
  "dashboard.shown": "dashboard renders",
  "dashboard.reset": "metric resets",
  "hint.recall": "hints followed by recall",
} as const satisfies Record<MetricName, string>;
```

- `counterRows` renders `| counter | meaning | count |` / `|---|---|---:|` and
  `| ${name} | ${METRIC_LABELS[name]} | ${asCount(record[name])} |`.
- Budget pressure renders `| day | counter | meaning | count |` / `|---|---|---|---:|` and includes
  the label. Keep the row ordering `(stamp, counter name)`.
- Update the renderer doc comment: labels are a fixed display vocabulary, not input.

### Verify

```bash
npx vitest run test/metrics.test.ts test/acceptance-metrics.test.ts test/tools.test.ts
npx tsc --noEmit
```

Commit: `feat: add human-readable metric labels (E10a)`.

---

## Task 3 (E10b): Two-step reset confirmation — `src/metrics.ts`, `test/metrics.test.ts`, `test/acceptance-metrics.test.ts`

### Failing tests first

Add to `test/metrics.test.ts`:

```ts
it("bare reset explains and never wipes", async () => {
  const storage = new FakeStorage();
  await storage.set(totalKey(PROJECT, "hook.prompt"), 3);
  await storage.set(dayKey(PROJECT, "20300101", "hook.prompt"), 2);
  await storage.set(sinceKey(PROJECT), "2030-01-01T00:00:00.000Z");
  const { added, fakeCtx, synthetic } = fakeForMetricsCommand({ storage });
  await registerMetricsCommand(fakeCtx);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await added[0]!.execute({
    sessionID: SESSION,
    prompt: { text: "  RESET " },
    delivery: "steer",
  });
  await settle();

  expect(synthetic).toHaveBeenCalledTimes(1);
  const posted = synthetic.mock.calls[0]![0]! as { text: string };
  expect(posted.text).toContain(METRICS_RESET_CONFIRM_NOTICE);
  expect(posted.text).toContain("# [memory] metrics (local-only)");
  expect(posted.text).toContain("| hook.prompt | prompt hook runs | 3 |");
  // Nothing wiped, no reset count, but the render+post counted.
  expect(await storage.get(totalKey(PROJECT, "hook.prompt"))).toBe(3);
  expect(await storage.get(sinceKey(PROJECT))).toBe("2030-01-01T00:00:00.000Z");
  expect(await storage.get(totalKey(PROJECT, "dashboard.reset"))).toBeUndefined();
  expect(await storage.get(totalKey(PROJECT, "dashboard.shown"))).toBe(1);
});

it("reset confirm is whitespace/case-insensitive and wipes", async () => {
  // Existing reset tests are retargeted to "reset confirm"; add one
  // "  RESET   CONFIRM " case that proves normalization.
});

it("bare-reset fallback carries the confirmation notice", async () => {
  const { added, fakeCtx, prompt } = fakeForMetricsCommand({
    synthetic: async () => {
      throw new Error("synthetic surface drifted");
    },
  });
  await registerMetricsCommand(fakeCtx);
  await added[0]!.execute({
    sessionID: SESSION,
    prompt: { text: "reset" },
    delivery: "steer",
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  const text = (prompt.mock.calls[0]![0] as { text: string }).text;
  expect(text).toContain(METRICS_RESET_CONFIRM_NOTICE);
  expect(text).toContain(METRICS_FALLBACK_ASK);
});
```

Retarget the existing reset tests:

- `reset_removes_metrics_and_re_stamps_since` — execute `"reset confirm"`.
- `reset_token_is_case_insensitive_and_unrelated_arguments_change_nothing` — `"  RESET CONFIRM "`
  resets; `"resetAll"` still renders the plain dashboard with no notice and no wipe.
- `reset_command_reports_through_table_channel_even_when_the_wipe_fails` — execute
  `"reset confirm"`.
- `test/acceptance-metrics.test.ts` phase (d) — execute `"reset confirm"` only. Keep the existing
  post counts (`harnessA.posts` length 2) and namespace assertions; a bare-reset phase here would
  add a third post and force unrelated renumbering. Bare reset is covered by the focused
  `test/metrics.test.ts` cases above.
- Update exact dashboard row strings introduced in Task 2.

### Implementation

In `src/metrics.ts`:

```ts
export const METRICS_RESET_CONFIRM_ARG = "reset confirm";
export const METRICS_RESET_CONFIRM_NOTICE =
  "> Reset not applied. Re-run `/memory-metrics reset confirm` to wipe all local metrics.";
```

In `registerMetricsCommand.execute`:

```ts
const arg =
  typeof prompt?.text === "string"
    ? prompt.text.trim().toLowerCase().replace(/\s+/g, " ")
    : "";
const confirmReset = arg === METRICS_RESET_CONFIRM_ARG;
const resetRequested = arg === "reset";
if (confirmReset) {
  const reset = await resetMetrics(ledger, projectID);
  if (reset) void bump("dashboard.reset");
}
const options = parseMemoryOptions(ctx.options);
const table = await collectAndRender({ ... });
const text = resetRequested
  ? `${METRICS_RESET_CONFIRM_NOTICE}\n\n${table}`
  : table;
try {
  await ctx.session.synthetic({ sessionID, text });
} catch {
  await ctx.session.prompt({
    ...prompt,
    sessionID,
    delivery,
    text: resetRequested
      ? `${METRICS_RESET_CONFIRM_NOTICE}\n\n${METRICS_FALLBACK_ASK}`
      : METRICS_FALLBACK_ASK,
  });
  return;
}
logGm1SyntheticPostOnce(sessionID);
void bump("dashboard.shown");
```

- Update the command doc comment: bare `reset` is a confirmation prompt; `reset confirm` wipes.
- `dashboard.reset` only on a completed wipe from `reset confirm`.
- Do not change `memory_metrics` (read-only; no reset path).

### Verify

```bash
npx vitest run test/metrics.test.ts test/acceptance-metrics.test.ts
npx tsc --noEmit
```

Commit: `feat: require confirmation for metrics reset (E10b)`.

---

## Task 4 (E11): `remember:` near-miss nudge — `src/provenance.ts`, `src/hints.ts`, `src/index.ts`, tests

### Failing tests first

In `test/provenance.test.ts`, add:

```ts
describe("remember near-miss detection", () => {
  const near = [
    "Please remember: deploy on Fridays",
    "please remember that the branch is main",
    "Can you remember: rotate keys monthly",
    "could you remember that x is y",
    "remember x is y",
    "remember:",
    "remember that",
  ];
  const notNear = [
    "remember: deploy on Fridays",
    "remember that x is y",
    "I remember the old API",
    "we should remember to fix this",
    "remember when we used X",
    "remember how the cache works",
    "```\nremember: pasted\n```",
    "> remember: quoted",
    "`remember: inline code`",
    "",
  ];

  it("recognizes directive-shaped near misses", () => {
    for (const text of near) expect(isRememberNearMiss(text), text).toBe(true);
  });

  it("rejects valid directives, narrative uses, and fenced/quoted text", () => {
    for (const text of notNear) expect(isRememberNearMiss(text), text).toBe(false);
  });

  it("never throws on hostile input", () => {
    expect(isRememberNearMiss(undefined)).toBe(false);
    expect(isRememberNearMiss(null)).toBe(false);
    expect(isRememberNearMiss(42)).toBe(false);
  });
});
```

In `test/hooks.test.ts`, add to the `matchIndex`/context-hook area:

```ts
it("matchRememberNearMiss emits one line and throttles per prompt", async () => {
  const messages = [userMessage("Please remember: deploy on Fridays")];
  const opts = { storage, projectID: PROJECT, sessionID: SESSION };
  const hint = await matchRememberNearMiss(messages, opts);
  expect(hint).toBe(REMEMBER_NEAR_MISS_HINT);
  expect(hint!.split("\n")).toHaveLength(1);
  expect(hint).toContain("Nothing was recorded");
  expect(await matchRememberNearMiss(messages, opts)).toBeUndefined();
  // A different prompt can nudge again.
  expect(
    await matchRememberNearMiss(
      [userMessage("Please remember: rotate keys")],
      opts,
    ),
  ).toBe(REMEMBER_NEAR_MISS_HINT);
});

it("context hook prefers the near-miss nudge and does not arm", async () => {
  await writeMemory("INDEX.md", "- auth-service: login flow\n");
  const { hooks } = await setupHooks();
  const event = contextEvent([
    userMessage("Please remember: auth-service deploys on Fridays"),
  ]);
  await runHook(hooks, "context", event);
  const hint = event.system.find((p) => p.text.startsWith("[memory-hint]"));
  expect(hint!.text).toBe(REMEMBER_NEAR_MISS_HINT);
  // hint.shown counts it, but the arm key must not exist.
  expect(await storage.get(`${PROJECT}/metrics/arm/hint/${SESSION}`)).toBeUndefined();
});

it("a real INDEX hint still arms after a near-miss on a different prompt", async () => {
  await writeMemory("INDEX.md", "- auth-service: login flow\n");
  const { hooks } = await setupHooks();
  const armKey = `${PROJECT}/metrics/arm/hint/${SESSION}`;

  await runHook(
    hooks,
    "context",
    contextEvent([userMessage("Please remember: deploy Fridays")]),
  );
  expect(await storage.get(armKey)).toBeUndefined();

  await runHook(
    hooks,
    "context",
    contextEvent([userMessage("how does auth-service work?")]),
  );
  expect(await storage.get(armKey)).toBeDefined();
});

it("near-miss does not fire for narrative remember text", async () => {
  await writeMemory("INDEX.md", "- auth-service: login flow\n");
  const { hooks } = await setupHooks();
  const event = contextEvent([
    userMessage("remember when auth-service changed?"),
  ]);
  await runHook(hooks, "context", event);
  expect(
    event.system.some((part) =>
      part.text.includes("Nothing was recorded"),
    ),
  ).toBe(false);
  // The ordinary INDEX hint is still allowed for the same text.
  expect(event.system.some((part) => part.text.startsWith("[memory-hint]"))).toBe(
    true,
  );
});
```

Update the existing context-hook test that expects `event.system[2]` to be `[memory-hint]`: the
INDEX hint still occupies the same slot, so it stays green. Add an assertion that the INDEX-hint
path still writes the arm key (`metrics_taps_match_hook_outcomes` already covers this).

### Implementation

In `src/provenance.ts`:

```ts
const NEAR_MISS_PREFIX =
  /^(?:please\s+|kindly\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)?remember\b(.*)$/i;
const NARRATIVE_AFTER_REMEMBER = /^\s*(?:when|how|what|where|who|why)\b/i;

export function isRememberNearMiss(text: unknown): boolean {
  try {
    if (typeof text !== "string" || text.length === 0) return false;
    if (extractAssertedFacts(text).length > 0) return false;
    for (const line of visibleLines(text)) {
      const stripped = line.replace(INLINE_CODE, "").trim();
      const match = stripped.match(NEAR_MISS_PREFIX);
      if (match === null) continue;
      if (NARRATIVE_AFTER_REMEMBER.test(match[1] ?? "")) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
```

In `src/hints.ts`:

```ts
import { isRememberNearMiss } from "./provenance.js";

export const REMEMBER_NEAR_MISS_HINT =
  "[memory-hint] Nothing was recorded — start a line with `remember:` or `remember that` to save a fact to decisions.md.";

export async function matchRememberNearMiss(
  input: unknown,
  options: MatchIndexOptions,
): Promise<string | undefined> {
  try {
    if (!options || !options.storage) return undefined;
    const text = extractLatestUserText(input);
    if (text === undefined || !isRememberNearMiss(text)) return undefined;
    const promptHash = options.promptHash ?? promptHashFor(text);
    if (
      await hasHint(options.storage, options.projectID, options.sessionID, promptHash)
    ) {
      return undefined;
    }
    await setHint(
      options.storage,
      options.projectID,
      options.sessionID,
      promptHash,
      options.now,
    );
    return REMEMBER_NEAR_MISS_HINT;
  } catch {
    return undefined;
  }
}
```

In `src/index.ts` context hook:

```ts
const rememberHint = await matchRememberNearMiss(event.messages, {
  storage: ledger,
  projectID,
  sessionID: event.sessionID,
  memoryRoot,
});
const hint =
  rememberHint ??
  (await matchIndex(event.messages, {
    storage: ledger,
    projectID,
    sessionID: event.sessionID,
    memoryRoot,
  }));
const hintArms = rememberHint === undefined && hint !== undefined;
```

Replace the existing single `matchIndex` call. In the injection branch:

```ts
if (hint !== undefined) {
  event.system.push({ type: "text", text: hint });
  bump("hint.shown");
  if (hintArms) {
    await setArm(ledger, projectID, event.sessionID);
  }
}
```

Keep the budget logic unchanged: the hint still occupies exactly one line and is never dropped on a
hit. `matchRememberNearMiss` uses the same `hint/<session>/<promptHash>` key, so the two hint kinds
cannot both fire for one prompt.

### Verify

```bash
npx vitest run test/provenance.test.ts test/hooks.test.ts
npx tsc --noEmit
```

Commit: `feat: nudge remember near-misses with the documented form (E11)`.

---

## Task 5 (E12): Consolidated first-run checklist + README quickstart — `src/templates.ts`, `src/index.ts`, `test/scaffold.test.ts`, `README.md`

### Failing tests first

In `test/scaffold.test.ts`:

```ts
it("firstRunInstallText is one checklist with all install actions", () => {
  const text = firstRunInstallText();
  expect(text).toContain("scaffolded .opencode/memory/");
  expect(text).toContain("memory_write");
  expect(text).toContain('"effect": "ask"');
  expect(text).toContain(AGENTS_PROTOCOL_BLOCK);
  expect(text).toContain("indexLines");
  expect(text).toContain("snapshotThrottleMinutes");
  expect(text).toContain("/memory-status");
  expect(text).toContain("never edits");
  // One message, no duplicate permission snippet. Count the snippet itself,
  // not the word `memory_write` (the prose also names the action).
  expect(text.split(permissionsSnippet()).length - 1).toBe(1);
});

it("first run emits the consolidated checklist once and no separate log", async () => {
  resetInstallNudgesForTests();
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-first-run-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const setup = plugin.setup as unknown as (
      ctx: unknown,
    ) => Promise<(() => Promise<void>) | void>;
    await setup(installCtx(projectRoot));
    const checklist = warn.mock.calls.filter((c) =>
      String(c[0]).includes("first run"),
    );
    expect(checklist).toHaveLength(1);
    expect(String(checklist[0]![0])).toContain("/memory-status");
    expect(log).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
});

it("non-first-run keeps the unconditional permission warning", async () => {
  resetInstallNudgesForTests();
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-non-first-"));
  await preScaffold(projectRoot);
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    "## Project memory (.opencode/memory)\n- call memory_recall before editing contracts\n",
    "utf8",
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const setup = plugin.setup as unknown as (
      ctx: unknown,
    ) => Promise<(() => Promise<void>) | void>;
    await setup(installCtx(projectRoot));
    const permissionWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("memory_write → ask rule"),
    );
    expect(permissionWarnings).toHaveLength(1);
    expect(String(permissionWarnings[0]![0])).toContain(permissionsSnippet());
    // The first-run checklist is not printed on a pre-scaffolded project.
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("first run")),
    ).toBe(false);
  } finally {
    warn.mockRestore();
  }
});
```

Also extend `install_surface_P0_parity` to assert `firstRunInstallText()` contains each snippet
exactly once.

### Implementation

In `src/templates.ts`:

```ts
/**
 * One consolidated first-run install message (E12): required permission rule,
 * protocol block, optional options snippet, and the status-doctor pointer.
 * Fixed prose + the existing snippets only; no content channel.
 */
export function firstRunInstallText(): string {
  return `[memory] first run: scaffolded .opencode/memory/ (+ handoffs/).
Next steps:
1. Required — add the memory_write → ask rule to opencode.jsonc (without it, per-line approval fails open):
${permissionsSnippet()}
2. Paste this protocol block into root AGENTS.md (hand-owned, never auto-written):
${AGENTS_PROTOCOL_BLOCK}
3. Optional — paste the commented options into the same plugin entry:
${optionsSnippet()}
Verify the install anytime with /memory-status. The plugin never edits opencode.jsonc or AGENTS.md.`;
}
```

In `src/index.ts` setup, replace the current unconditional warning + first-run `console.log` with:

```ts
const firstRun = await scaffoldMemoryDir(projectRoot);

try {
  if (firstRun) {
    // One consolidated checklist (E12). It contains the required
    // memory_write → ask rule, so the spec §4.4 loud warning still fires.
    console.warn(firstRunInstallText());
  } else {
    // Spec §4.4: effective rules cannot be verified at setup, so the
    // install channel stays unconditional on every non-first-run setup.
    console.warn(
      "[memory] install the memory_write → ask rule or per-line approval fails open:\n" +
        permissionsSnippet(),
    );
  }
} catch {
  // Logging must never break plugin load.
}

```

Keep the existing `if (!firstRun) { ... }` AGENTS.md protocol-block nudge block (Tier 0, at
`src/index.ts` immediately after the warning block) **exactly as it is**; do not replace it with an
empty branch or delete it. The code snippet above only replaces the warning/first-run portion.

Import `firstRunInstallText` from `./templates.js`. Do not change `AGENTS_PROTOCOL_BLOCK`,
`optionsSnippet`, or `permissionsSnippet` text.

Add a `## Quickstart (5 minutes)` section to `README.md` before `## Try it without code (P0)`:

1. Install the plugin using one row of the Install matrix, then restart/reload OpenCode.
2. Paste the required `memory_write → ask` rule into the same `opencode.jsonc` (link to
   Permissions).
3. Paste the protocol block from `src/templates.ts` into root `AGENTS.md` (the first-run message
   prints it; link to Install).
4. Run `/memory-status` and fix every listed action.
5. Use `/memory-metrics` to see the local count-only dashboard; nothing is sent anywhere.

State that first run scaffolds `.opencode/memory/` and prints the checklist once, and that the
plugin never edits config or `AGENTS.md`.

### Verify

```bash
npx vitest run test/scaffold.test.ts
npx tsc --noEmit
```

Commit: `feat: consolidate first-run install checklist (E12)`.

---

## Task 6 (docs): Spec, ADRs, stories, C4, README, CHANGELOG

No new behavior. Freeze the strings and storage shapes from Tasks 1–5.

### Spec `docs/design-spec-v2-production.md`

- Header sources: ADRs `0001–0008`; user stories `US-01–32`.
- §4.4: first-run print is the consolidated checklist; non-first-run keeps the unconditional
  permission warning. The snippet/block bytes are unchanged.
- §5.2 (context hook bullet): the ≤1 hint slot is filled by either an INDEX hint or a
  `remember:` near-miss nudge; the near-miss line is fixed prose; only the INDEX hint arms the
  hint→recall correlation; both are throttled by the same `hint/<session>/<promptHash>` key.
- §5.11: add the near-miss detector contract (visible lines, optional politeness prefix, narrative
  wh-word exclusion, valid directives excluded) and state that it never writes memory — it only
  explains the documented form.
- §5.12: renderer now emits `counter | meaning | count` (and `day | counter | meaning | count`);
  labels come from `METRIC_LABELS`, an exhaustive fixed map (display furniture, no input). Command
  row: `/memory-metrics reset` renders a confirmation notice without wiping; `/memory-metrics reset
  confirm` wipes. Fallback carries the notice for a bare reset. `dashboard.reset` only on a
  completed `reset confirm` wipe.
- §6 ledger row: `snapshot/<sessionID>` stores `{hash, at}` (legacy strings normalized on the first
  prune); attempts are pruned at the 30s retry window, hints at 7 UTC days, snapshot/throttle at 30
  UTC days; the existing seen cap stays. The daily piggyback now runs both metrics and ledger
  housekeeping.
- §7 lifecycle: note the bounded ledger state and the two-step reset in the capture/promotion flow.
- §9 gates: add an E9–E12 gate bullet (retention/pagination/re-check; labels/determinism; reset
  confirmation; near-miss precedence/no-arm; first-run one-message).
- §10 roadmap: replace “E8–E14 remain deferred” with the delivered Tier-2 line and the remaining
  E8/E13/E14 deferrals.

### ADRs

- `docs/adr/0004-ledger-and-promotion.md`: update the ledger sentence to say aged attempt/hint/
  snapshot/throttle keys are pruned (same scan/remove pattern as `seen`), with the retention values
  and the daily piggyback; no change to idempotency guarantees.
- `docs/adr/0008-local-usage-metrics.md`: add a dated **Revision 2026-10-20** subsection:
  - display labels are fixed prose (`METRIC_LABELS`), never content and never input-derived;
  - reset is two-step: bare `reset` explains, `reset confirm` wipes; no new counter;
  - the vocabulary stays exactly 45 names and the five-option contract is untouched.

### User stories

- US-04: first run prints one consolidated checklist (permissions, protocol block, options,
  `/memory-status` pointer), not separate warning + dump; plugin still never edits config/AGENTS.
- US-28: dashboard rows carry a fixed human-readable meaning column.
- US-29: reset is two-step; bare `reset` renders without wiping; `reset confirm` wipes and re-stamps
  `since`.
- New **US-32 Find out why my “remember” was not recorded.** As a user, when my message looks like a
  memory request but is not the documented line-start form, I want one `[memory-hint]` line
  explaining the exact form, without a memory write and without arming hint→recall; acceptance:
  `isRememberNearMiss` table, shared throttle, one line, no arm key.

### C4

- `docs/c4-02-containers.md`: capture-ledger row mentions the daily aged-key prune (not only
  `seen`), and the metrics/command row points at two-step reset.
- `docs/c4-03-components.md`: context-hook row mentions the near-miss nudge sharing the one hint
  slot; capture-ledger row mentions `pruneLedgerState` retention; metrics row mentions labels +
  `reset confirm`.
- `docs/c4-04-interfaces.md`: the `/memory-metrics` command section changes `[reset]` to
  `[reset | reset confirm]`, explains that bare `reset` renders the confirmation notice without
  wiping, and documents the label column.
- `docs/c4-05-data-model.md`: ledger row gains retention and `{hash, at}` snapshot shape; metrics
  row gains labels + two-step reset; add a Tier-2 no-new-keys note (the only new ledger behavior is
  pruning/timestamping existing keys).
- `docs/c4-06-code.md`: `hints.ts` line mentions `matchRememberNearMiss`; `capture.ts` line mentions
  `pruneLedgerState`; `metrics.ts` line mentions labels/confirm; `ledger` bullet gains retention.

### README + CHANGELOG

- README: Quickstart section (Task 5); Tools/Commands `/memory-metrics reset confirm`; Metrics
  section labels + two-step reset + ledger retention; Budgets/Evals mention the near-miss hint
  shares the one hint slot (do not change the measured line counts: it is still ≤1 line). Update
  the stale `US-01–31` docs line to `US-01–32` and the Uninstall paragraph (which currently says
  `/memory-metrics reset` clears counters) to `reset confirm`.
- CHANGELOG Unreleased: four bullets (E9 ledger retention; E10 labels + two-step reset; E11
  near-miss nudge; E12 first-run checklist + quickstart), explicitly no new option/metric name/
  memory-file write behavior.

### Verify

```bash
npx tsc --noEmit
npx vitest run
```

Commit: `docs: tier 2 ledger, metrics, hints, onboarding contracts`.

---

## Task 7: Final gate (orchestrator)

```bash
npx tsc --noEmit
npx vitest run
npm run test:coverage   # thresholds: 85 lines / 78 branches / 90 functions / 85 statements
git status --short
```

Expected: typecheck clean; all tests pass (baseline 298 + new tests); coverage thresholds hold;
working tree clean after the final commit. If coverage drops, add tests for the new branches rather
than lowering thresholds.

Then run the independent implementation review, fix findings, loop until green, commit any
remaining files, push, open the PR, wait 10 minutes, and address PR comments/CI before stopping.

---

## Implementation-review checklist (for the post-implementation reviewer)

- E9: every aged-key removal is project-scoped; pagination walks all pages; the re-check prevents an
  in-process fresh write from being deleted; malformed values stay; storage failure reaches the
  existing catch; snapshot legacy normalization is documented; no attempt removal on the success
  path.
- E10a: `METRIC_LABELS` is exhaustive against `METRIC_NAME_LIST`; labels contain no `|`/newlines;
  renderer output is byte-identical for identical inputs; the no-content-channel test still proves
  only vocabulary/file/label/furniture/integer strings can appear.
- E10b: bare `reset` never calls `resetMetrics`, never bumps `dashboard.reset`, and always posts the
  notice; `reset confirm` normalizes case/whitespace; a failed wipe does not bump; fallback carries
  the notice; no new counter.
- E11: near-miss detection excludes valid directives, narrative forms, fences, quotes, and inline
  code; the hint is one line; it shares the prompt-hash throttle; it never writes the arm key;
  INDEX hints still arm and still bump `hint.recall` on recall.
- E12: first run emits exactly one consolidated message containing each snippet once; non-first-run
  still emits the unconditional permission warning and the once-per-process AGENTS nudge; the
  protocol-block bytes still match the spec exactly; README quickstart links are valid.
- Docs: no stale “reset” wording left in README/spec/stories; no claim of a sixth option or a new
  counter; Tier-3 deferrals still listed.
