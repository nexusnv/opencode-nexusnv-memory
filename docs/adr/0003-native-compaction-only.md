# ADR-0003 — Survive compaction via the native `compaction` hook only

**Status:** accepted. **Date:** 2026-10-15.

## Context

Supermemory's custom compaction reimplemented the trigger (80% threshold) and continuation, causing: summary overflow on the smaller compaction model, sessions stuck on the compaction model, an undisablable threshold, and races with native `compaction.auto` (#69), plus premature compaction from model-limit fallback (#85, #88).

## Decision

The plugin registers `ctx.session.hook("compaction")` solely to inject priors into the summary context and to record the resulting summary as a handoff. Shape-guarded: if `event.system` exists, push capped + redacted priors; always handle `event.result` (set it to record the summary when supported, else save the produced summary as a `handoffs/` file). No custom threshold, no synthetic continuation, no model override. Pre-compaction state is already on disk from ledger-guarded capture, so a bad summary loses nothing durable.

## Consequences

- Positive: no races, no model-window mismatches, no stuck sessions; intra-session memory survives with ~10 lines of hook code.
- Negative: dependent on the experimental hook's stability; accepted with a fallback (priors also persist as handoffs readable on demand).
