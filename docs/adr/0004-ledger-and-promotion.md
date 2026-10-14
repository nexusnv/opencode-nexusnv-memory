# ADR-0004 — Idempotent capture (ledger) + human-approved promotion; no silent durable writes

**Status:** accepted. **Date:** 2026-10-15.

## Context

Supermemory #106: a timed-out capture batch (guarded only by an in-memory set) was re-POSTed on every later event and at session end — one fact stored 55×. The surveyed alternative is per-turn LLM extraction with ADD/UPDATE/DELETE/NOOP resolution, which adds cost, latency, and drift surface.

## Decision

- Capture is zero-LLM and failure-/boundary-only (failed shell/build/test truncated to 20 lines; idle snapshots; explicit `remember`). Every write passes a persisted ledger (`ctx.storage`): check-before-write, persisted attempts, retry only inside ~30s. Restarts and replays are no-ops.
- Scratchpad (`activeContext.md`) is append-only during work. The sole path to durable files (`decisions.md`, `architecture.md`, `style.md`) is `/memory-review` (or the scoped `memory-manager` subagent): propose, human approves, then write.

## Consequences

- Positive: no duplicates across timeouts/restarts; no per-turn LLM cost; durable files stay trustworthy because a human gated every line.
- Negative: durable memory lags real time until review; accepted — scratchpad + handoffs cover the gap, and staleness beats corruption.
