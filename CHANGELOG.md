# Changelog

## Unreleased

- Local usage metrics (spec §5.12, ADR-0008, M-T1–M-T6): count-only, on-machine, never-throw `bump` taps over the plugin-scoped `ctx.storage` (`<projectID>/metrics/…` — monotonic totals + ≤90-day UTC buckets + lazy `since`, enumerated fail-closed names, numbers only, 1,000-bump flood containment); metrics health (six structural file line counts, handoffs/archive/pending/seen counts via the shared scan walker); the read-only `memory_metrics` tool; and the `memory-metrics` command registered at setup (`/memory-metrics [reset]`): synthetic-post dashboard → once-per-process G-M1 deploy line → §5.5 `memory_metrics`-echo fallback on a rejected post. Optional file-based `commands/memory-metrics.md` affordance ships alongside (plugin command is normative, later source wins). No memory file, budget, injection, or hook-outcome behavior changes.
- Five-option config contract unchanged (ADR-0006: metrics always on, no sixth option; `/memory-metrics reset` is the control; uninstall orphans the keys like the ledger).

Supported OpenCode range: `2.0.x` (built and type-checked against `@opencode/plugin 2.0.29`).

## 0.1.1 (2026-10-16)

- Release automation: npm trusted publishing (OIDC) replaces the default publish-token path (a token fallback remains to *stage* releases via manual dispatch); release workflow split into gated build and minimal publish jobs with tag-on-main and tag/manifest guards; first workflow-published release (validates the trusted-publisher configuration).
- No plugin behavior changes since 0.1.0.

## 0.1.0 (P1-T10, 2026-10-15)

- P1 acceptance gate (`test/acceptance.test.ts`, 21 tests): end-to-end proof of every §9 bullet — budgets on all write paths with an end-to-end ≤80-line payload check, over-cap INDEX unattached, no INDEX duplication in the brief, priors carry the decisions tail with no `event.result` assignment anywhere in `src/`, secrets + `<private>` (incl. unclosed) redaction on write and inject, recall traversal rejects via the `toolResult` envelope, apply asserts once per line with tool-context IDs under the shipped `memory_write → ask` rule, untrusted candidates excluded from bulk approval, `HHmmss-<session6>` handoff routing at `handoffs/` root, foreign events dropped before any write, single reused `AbortController`, rotation-once + nudge-at-≥5 + reset-via-`candidates:[]`, poison-fixture containment (summary-only brief), fence/quote provenance rejection, and the deploy-time `event.type` log confirming `session.idle` + `session.compaction.ended` delivery.
- Evals reported as three numbers: static = 10, per-prompt with content = 90, session-total = per-prompt × model steps (4 steps ≈ 360); hint throttled to once per prompt/session.
- Docs: README gains Evals, Deploy check (`event.type` log guidance), and Compatibility sections; supported range stays OpenCode `2.0.x` (`@opencode/plugin 2.0.29`); published-form package verified to load via `opencode plugin list`.

Supported OpenCode range: `2.0.x` (built and type-checked against `@opencode/plugin 2.0.29`).

## 0.1.0 (P1-T1, 2026-10-15)

- Scaffold the `opencode-nexusnv-memory` plugin package: manifest (`@opencode/plugin` pinned exact `2.0.29`), strict `tsconfig`, wiring-only `Plugin.define({ id: "memory", setup })` entrypoint with a single `AbortController`, a `registrations` array, and async cleanup (abort + `dispose()`).
- Add `src/config.ts`: exactly 5 optional options (`indexLines=30`, `fileLines=60`, `injectBudgetLines=80`, `captureFailures=true`, `snapshotThrottleMinutes=10`); invalid values warn once and fall back to defaults, never throw.
- Add `src/templates.ts`: six-file scaffolds + `handoffs/` (+ archive dir), commented ≤5-option snippet, mandatory `memory_write → ask` permissions snippet, and the `AGENTS.md` protocol block text.
- Ship `agents/memory-manager.md` (read-only: leading `* → deny`, then `read`/`glob`/`grep → allow` only; proposal-only body) and the optional file-based `commands/memory-review.md` stub (plugin command is normative).
- Docs: README install matrices (drop-in vs package, `.opencode/` vs root paths, merge order, `plugin list` verify, reload guidance), budgets, and uninstall; supported OpenCode range `2.0.x` (`@opencode/plugin 2.0.29`).

Supported OpenCode range: `2.0.x` (built and type-checked against `@opencode/plugin 2.0.29`).
