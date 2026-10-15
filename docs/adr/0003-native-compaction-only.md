# ADR-0003 — Survive compaction via the native `compaction` hook only

**Status:** accepted. **Date:** 2026-10-15. **Revised:** 2026-10-15 (see Revision).

## Context

Supermemory's custom compaction reimplemented the trigger (80% threshold) and continuation, causing:
summary overflow, sessions stuck on the compaction model, an undisablable threshold, and races with
native compaction (#69), plus premature compaction from model-limit fallback (#85, #88).

On V2 the `compaction` session hook runs **before** the summary model call: `event.messages` is the
transcript being summarized and OpenCode appends its summary prompt after hooks run. Setting
`event.result` makes OpenCode **skip the model call** and use the supplied value as the summary.

## Decision

The plugin registers `ctx.session.hook("compaction")` solely to push capped, redacted priors into the
summary context (`event.system.push`). It **never sets `event.result`** in the default path — doing so
would skip the native summary and reintroduce exactly the failure class this ADR exists to prevent. It
never changes the model, threshold, or trigger, and never synthesises continuation. Pre-compaction
state is already on disk from ledger-guarded capture, so a bad summary loses nothing durable.

The **produced** summary is captured post-compaction from the public `session.compaction.*` event
stream (exact event names and payload verified at the P1 runtime gate); if the payload does not carry
the summary, only a pointer-only handoff (timestamp + branch + "compaction occurred") is written, or
the summary is recorded on demand via `/memory-review`.

## Consequences

- Positive: no races, no model-window mismatches, no stuck sessions, no suppressed summaries;
  intra-session memory survives with a few lines of hook code.
- Negative: produced-summary capture depends on an event payload that is not guaranteed to carry the
  summary text (tracked as spec §8 D-B); accepted because priors live on disk regardless.

## Revision

The original text said the hook should "always handle `event.result` (set it to record the summary
when supported)". That is wrong on V2: setting `event.result` suppresses the native summary. Replaced
with priors-only plus event-based capture. Cross-document references (`c4-03`, `c4-04`, `US-16`,
`motivation.md` §4.3-6/§4.6, `design-spec-v2-production.md` §5.6/§8 D-B) were aligned.
