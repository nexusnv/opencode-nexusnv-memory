# ADR-0008 — Local usage metrics: count-only, on-machine, dashboard on demand

**Status:** accepted. **Date:** 2026-10-17.

## Context

Every adaptive constant in the plugin is a fixed guess with no feedback loop in production:

- `REVIEW_DUE_PENDING = 5` (review-due nudge, design-spec §5.7),
- `snapshotThrottleMinutes = 10` (context-hook snapshot fallback, §5.9),
- the once-per-prompt hint throttle (§5.2),
- the 80-line injection budget and its truncation order (§5.2).

The `[memory]` status line only speaks when a threshold *trips*; a user whose memory never rotates
and whose pending count never climbs receives no evidence either way. Spec §9's evals (recall
success vs tokens injected) exist only as numbers measured inside `test/acceptance.test.ts` against
fixtures — production usage is unmeasured. Nobody can answer today: does the tell-tale hint actually
drive `memory_recall`? how often does the budget truncate, and which line gets sacrificed? how much
is captured vs reviewed vs denied?

At the same time the privacy posture is absolute (motivation.md Goal, README): local-first,
zero-subscription, zero-daemon. Anything that leaves the machine is not a trade-off to weigh — it is
a contradiction of the product's premise.

So the question is only: can the plugin measure *itself* for its own user, on this machine, without
ever collecting content?

## Decision

1. **Count-only metrics.** Metrics live in the plugin-scoped `ctx.storage` under
   `<projectID>/metrics/…`:
   - Monotonic counters `<projectID>/metrics/total/<name>` (int) and UTC daily buckets
     `<projectID>/metrics/day/<YYYYMMDD>/<name>` (int), plus `<projectID>/metrics/since` (first
     write timestamp for the "since" line on the dashboard).
   - Counter names are an **enumerated, fixed vocabulary** in `src/metrics.ts` — fail-closed: an
     unknown name is logged and dropped, never written, so the key space cannot grow unboundedly.
   - **No content, ever.** No prompt text, tool output, captured-path strings, identities, or prose
     enters any metric key or value; every persisted metrics value is a JSON number (the arm flag is
     the int `1` when armed — binary semantics, numeric storage — so the number-only invariant is
     testable as a literal gate). Wherever a file
     name appears it is one of the six allowlisted structural names (or the aggregate `handoff` /
     `error` bucket for the open-ended handoff set). The rule the ledger already applies to content
     IDs (opaque hashes, ADR-0004) extends to metrics by construction.
2. **Always on — no sixth option.** The five-option config contract stands (ADR-0006). Count-only
   int metrics are the same data class the ledger already persists locally, so they ship on by
   default. The user's control is the dashboard command's `/memory-metrics reset`, which removes all
   `<projectID>/metrics/…` keys and stamps a fresh `since`. Uninstall orphans the keys like the
   ledger (US-24 parity; the storage location and manual `rm` are documented).
3. **Fire-and-forget, never-throw taps.** Every bump is dispatched off the hook's awaited path
   (`void bump(...)` with its own catch) through the existing per-process write mutex. A bump must
   never delay a hook, never change a hook's outcome, and never throw. The arm-flag transport is
   the sole exception to the off-path rule: `setArm` is **awaited** at the hint-hit site, and the
   recall-side consumption runs through `consumeArm` — read + clear in ONE locked body,
   never-throw, same mutex — because the subsequent counter depends on it and concurrent recall
   calls must convert an armed session at most once. Losing a counter on a crash
   or to cross-process concurrency is acceptable: metrics are best-effort statistics, unlike the
   correctness ledger (ADR-0004), which keeps its stronger check-before-write/idempotency guarantees
   untouched.
4. **Dashboard, on demand, deterministic — no model turn.** The rendered table is computed from
   counters + live memory-file health (line counts and entry counts only — nothing dark leaves the
   on-disk read) by a pure renderer. It surfaces two ways:
   - `memory_metrics` — a read-only tool registered beside `memory_recall`/`memory_apply`,
     returning the table through the same `toolResult` envelope (G2).
   - `/memory-metrics [reset]` — a plugin-registered command (`ctx.command.transform`) whose
     executor posts the table via `ctx.session.synthetic({ sessionID, text })`, **type-proven
     against `@opencode/plugin` / `@opencode/client` 2.0.29**. The one property types cannot prove —
     that the TUI renders the post without triggering a model turn — gets a deploy-time
     confirmation log (gate G-M1, same pattern as the §1.3 event-type check). G-M1 is a deploy-time
     human check, not a runtime branch (no runtime state can represent "confirmed delivery");
     whenever the post fails, the executor falls back to the §5.5 pattern
     (`ctx.session.prompt` spread) asking the agent to call `memory_metrics` and echo the table
     verbatim. That fallback also covers any later OpenCode build whose synthetic surface drifts.
5. **Bounded state.** Daily buckets are pruned after **90 UTC days** (paginated
   `scan` + `remove`, modeled on the `seen`-set prune) with a once-per-UTC-day piggyback check, so
   the namespace stays small and the dashboard render stays `O(days × names)`.
6. **Rich TUI panel deferred** (spec §8 D-G). A separate client-side `@opencode/plugin/tui` plugin
   (SolidJS + `@opentui`, live pages/slots/dialogs via `ui.router.register`/`ui.slot`) could render
   a real-time panel, but it is a second plugin type and a heavier install path for no additional
   fidelity over the markdown table. Revisit only on real demand.
7. **Amendment of prior absolutes.** These metrics taps are diagnostics, not memory writes; this ADR
   carves a documented exception into the letter of the read-only/no-side-effect absolutes (spec §5
   and §5.1) and the review "writes nothing" absolute (spec §5.5, ADR-0007 §3) — count-only
   `ctx.storage` counters never touch memory files and carry no content. Spec §1.2 (P24) records the
   correction; the underlying memory-write gates (provenance, budgets, per-line approval) are
   unchanged.

## Consequences

- Positive: the §9 evals get their production counterpart (recall success vs injected tokens becomes
  observable, not just fixture-measured); every fixed threshold becomes tunable with real numbers;
  the `hint.shown` → armed-recall correlation shows whether the tell-tale drives recall or is noise;
  the user finally sees the intervention rates (captures, truncations, denials, dedupes) that the
  status line only gestures at. All of it stays on the user's machine inside the plugin's storage
  namespace.
- Negative: `ctx.storage` grows by one bounded set per project (≤ the enumerated counter names +
  ≤ 90 day buckets × actually-bumped names); each bump writes two ints (total + day) fire-and-forget.
  The never-throw/volume suite asserts a 1,000-bump burst with a saturated storage queue cannot
  delay a hook — `bump` is a synchronous `void` that schedules at most one locked write body — so
  hook latency is structurally unaffected.
- Residual risk, stated honestly: on-machine usage-pattern metadata (counts + timestamps) is still
  metadata; a user may not want it even locally. The mitigations are the same class the repo already
  trusts — on-machine residence inside the plugin's own namespace, a documented storage location, a
  one-command reset, and plugin removal. It is smaller in kind than the ledger's existing
  opaque session-scoped keys and than what OpenCode itself records about sessions.
- Once published, counter names are load-bearing output (tests assert the enumeration and the
  fail-closed behavior). Renaming a counter breaks only the continuity of self-comparison, never any
  memory data. The CSV/JSON export is deliberately absent — the on-demand dashboard surfaces
  (`memory_metrics` tool + `/memory-metrics` command) are the only intended channels, which keeps the
  "no egress" property trivially true.

## Related

- ADR-0004 (ledger, promotion) — metrics live in the same storage family but never carry the ledger's
  correctness duties; ADR-0006 (five-option minimalism, fixed root) — kept; ADR-0007 (untrusted
  content) — the metrics rule ("no content, numbers only") is the same minimalism applied to
  telemetry. Spec §5.12 is the normative component contract; user stories US-28/US-29 + HS-12.
