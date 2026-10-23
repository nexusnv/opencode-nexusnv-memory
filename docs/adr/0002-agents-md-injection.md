# ADR-0002 — Inject through AGENTS.md + session hooks; never the `instructions` array; never auto-write nested AGENTS.md

**Status:** accepted. **Date:** 2026-10-15.

## Context

An early blueprint injected memory via `"instructions": ["…/INDEX.md", "…/activeContext.md"]` and assumed all AGENTS.md edits live-reload.

## Decision

- Memory reaches the model in three parts, each with one owner (no double injection):
  1. Root/global `AGENTS.md` chain — durable protocol + links only, top position, never file content.
  2. `prompt` hook — sole injector of `INDEX.md` content (capped), with dedup guard (skip if already attached); also the sole site of the `source:user` append to `decisions.md` (the only hook that sees the user's turn before admission — see ADR-0004 revision).
  3. `context` hook append — stable active-context brief at the bottom (`event.system.push`); volatile status/hint/pointer are prompt-tail notices (see revision below).
- The V2 `instructions` config array is not used — but **not** because V2 ignores it. V2 _does_ resolve
  `instructions` (relative/glob paths, `~/`, absolute, `http(s)`); the design routes memory through root
  `AGENTS.md` + the `prompt`/`context` hooks instead, so injection has a single owner, stays
  budget-capped, and needs no client config edit. (An earlier revision cited a V2 doc line saying
  instructions were not yet added to the model; that line no longer matches the V2 instructions page.)
- Auto-written memory lives only in `.opencode/memory/`, never in nested (below-workspace) `AGENTS.md` files, because V2 does not auto-detect edits to already-loaded nested files (new session required).

## Consequences

- Positive: injection actually works on V2; AGENTS.md stays tiny (protocol + links, never content); injection surface bounded by budgets even as history grows.
- Negative: nested-scope memory requires new sessions to pick up; accepted and documented in the lifecycle (§4.3 stage 8).

## Revision 2026-10-20 — prompt-tail notices (E8-A)

The `prompt` hook remains the sole `INDEX.md` injector and the sole `source:user` writer, and now also appends at most three volatile data-only notice lines (newest-handoff pointer, status, hint) to the canonical user prompt after the user's text. The block is marker-guarded so a retried admission does not duplicate it. The `context` hook now carries only the stable active-context brief via `event.system.push`; it no longer carries status, hint, or the newest-handoff pointer. Root `AGENTS.md` remains protocol + links only. This keeps the per-model-call system prefix stable without creating a second memory-content injector.
