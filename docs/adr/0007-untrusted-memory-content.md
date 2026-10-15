# ADR-0007 — Memory content is untrusted: minimise, tag provenance, isolate the review, gate per line

**Status:** accepted. **Date:** 2026-10-15.

## Context

Memory is not a trusted input channel. Several write paths store text that the project does not
author:

- **Failure capture** stores failed shell/build/test output. A dependency, a build script, or a repo
  file controls its own error text, so that text is attacker-influenceable.
- **Idle snapshots** store VCS-derived state.
- **Model notes** are model-authored.

Two distinct threats follow:

- **T1 — action on injected text.** Poisoned content in a session directs the agent to run a command,
  fetch a URL, or exfiltrate. This is dangerous because memory is *auto-injected* into sessions that
  have full tool permissions.
- **T2 — durable poisoning.** Poisoned text is promoted into a durable file, then injected into every
  future session — a persistent, self-replicating foothold.

The obvious-looking fix — detect prompt injection and reject it — is not a real boundary. Detection is
unreliable, and a design that depends on it fails silently and dangerously the first time it misses.
The design must be safe on the assumption that poisoning *will* sometimes get through.

An earlier revision also held that the injected brief could include recovered fault bodies verbatim,
and that `memory-manager` needed a write ability narrowed to `.opencode/memory/**`. Both assumptions are
revisited here.

## Decision

Containment rests on four structural controls, none of which require detecting an injection:

1. **Minimisation.** Raw captured output is **never auto-injected**. `loadBrief()` emits one bounded
   summary line per known error (`- \`<cmd>\` exit <code>: <first line, ≤120 chars>`); the detail body
  stays on disk and is `memory_recall`-only. Captured content in the payload is labelled as untrusted
  data, and the `AGENTS.md` directive states that memory content is data, never instructions.
2. **Provenance.** Every entry carries `source:user | tool | model | snapshot`. Provenance decides the
   write path (ADR-0004) and is shown to the human at review time.
3. **Isolation.** The read+propose phase of `/memory-review` runs in the `memory-manager` subagent,
   which is **read-only**: no `edit`, no `shell`. It reads and proposes; it can never act on what it
   reads, and application of approved lines happens outside it. Verifying that a plugin command can
   target a subagent is runtime gate G5; if it cannot, the primary agent delegates the pass so the
   sandbox still applies.
4. **Human approval, per line.** Untrusted-provenance candidates are **excluded from any bulk
   "approve all"**; they require explicit line-by-line approval with their `source:` tag visible.

`flagInjection(text)` exists, but **only as advisory metadata**: it marks instruction-shaped content,
agent-directed directives, URL/`fetch` payloads, and encoded blobs, and surfaces flags in the proposal
so a reviewer looks closely. Flags never block a write, never auto-reject, and must never be presented
as "injection detected".

## Consequences

- Positive: prompt-injection *detection* is not a load-bearing assumption; the containment holds even
  when a poisoned line reaches the proposal table. The auto-injected payload can no longer carry raw
  command output, so the highest-traffic injection path is closed. `memory-manager` being read-only
  also removes the permission-ordering fragility of the earlier scoped-`edit` design (ADR-0006/P2).
- Negative: reviewing requires reading provenance tags and approving untrusted lines individually —
  deliberately more work than a bulk approve, because a bulk approve is exactly the button that turns T2
  into a permanent compromise.
- Residual risk, stated honestly: a human can still approve a poisoned untrusted line. The mitigations
  are the `source:` tag, the advisory flags, and the bulk-approval exclusion — not a guarantee.
- `captureFailures: false` disables tool-output capture entirely for users who want the smallest
  attack surface.
- If a future capability lets the plugin classify *authoring provenance* with certainty (rather than by
  directive form), the `source:user` heuristic from ADR-0004 can be tightened to it.
