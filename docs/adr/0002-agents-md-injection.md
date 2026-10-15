# ADR-0002 — Inject through AGENTS.md + session hooks; never the `instructions` array; never auto-write nested AGENTS.md

**Status:** accepted. **Date:** 2026-10-15.

## Context

An early blueprint injected memory via `"instructions": ["…/INDEX.md", "…/activeContext.md"]` and assumed all AGENTS.md edits live-reload.

## Decision

- Memory reaches the model in three parts, each with one owner (no double injection):
  1. Root/global `AGENTS.md` chain — durable protocol + links only, top position, never file content.
  2. `prompt` hook — sole injector of `INDEX.md` content (capped), with dedup guard (skip if already attached).
  3. `context` hook append — brief + status line + hint at the bottom (`event.system.push`).
- The V2 `instructions` config array is not used: V2 accepts it but does not resolve its files ("This configuration does not add instructions to the model yet").
- Auto-written memory lives only in `.opencode/memory/`, never in nested (below-workspace) `AGENTS.md` files, because V2 does not auto-detect edits to already-loaded nested files (new session required).

## Consequences

- Positive: injection actually works on V2; AGENTS.md stays tiny (protocol + links, never content); injection surface bounded by budgets even as history grows.
- Negative: nested-scope memory requires new sessions to pick up; accepted and documented in the lifecycle (§4.3 stage 8).
