# ADR-0007 — Memory content is untrusted: minimise, tag provenance, proposal-only review, gate per line

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
  fetch a URL, or exfiltrate. This is dangerous because memory is _auto-injected_ into sessions that
  have full tool permissions.
- **T2 — durable poisoning.** Poisoned text is promoted into a durable file, then injected into every
  future session — a persistent, self-replicating foothold.

The obvious-looking fix — detect prompt injection and reject it — is not a real boundary. Detection is
unreliable, and a design that depends on it fails silently and dangerously the first time it misses.
The design must be safe on the assumption that poisoning _will_ sometimes get through.

An earlier revision also held that the injected brief could include recovered fault bodies verbatim,
and that `memory-manager` needed a write ability narrowed to `.opencode/memory/**`. Both assumptions are
revisited here.

## Decision

Containment rests on four structural controls, none of which require detecting an injection:

1. **Minimisation.** Raw captured output is **never auto-injected**. `loadBrief()` emits one bounded
   message-derived summary line per known error (first line of `event.error.message`, ≤120 chars,
   newlines collapsed; `<cmd>:` prefix only when `event.input` yields it; max 5 lines); the detail body
   stays on disk and is `memory_recall`-only. Captured content in the payload is labelled as untrusted
   data, and the `AGENTS.md` directive states that memory content is data, never instructions.
2. **Provenance.** Every entry carries `source:user | tool | model | snapshot`. Provenance decides the
   write path (ADR-0004) and is shown to the human at review time.
3. **Proposal-only review (no sandbox).** The read+propose phase of `/memory-review` writes no memory and
   its only output is a proposal table; no execution happens as part of the review. It is deliberately
   **not** sandboxed. A plugin-registered command **cannot** target a subagent (`CommandInvocation` has
   no agent selector), and the session permission-lock substitute does not contain the threat:
   `ctx.permission.hook("evaluate")` is scoped to the review turn, while the reviewed text persists in
   the transcript — so it **defers `T1` rather than preventing it**, and it would deny the user's own
   concurrent tools in that session. The **read-only `memory-manager` subagent** (no `edit`/`shell`/
   `webfetch`/`websearch`/`skill`) is available as an **optional** isolated venue when the primary agent
   chooses to delegate — which is stronger, because a child session keeps poisoned text out of the
   user's transcript. Containment rests on controls 1, 2, and 4, not on a lock.
4. **Human approval, per line.** Untrusted-provenance candidates are **excluded from any bulk
   "approve all"**; they require explicit line-by-line approval with their `source:` tag visible. The
   channel is the plugin's `memory_apply` tool, which calls `ctx.permission.assert` once per candidate
   line (so per-line approval holds by construction) and only then writes via `writeCapped`.

`flagInjection(text)` exists, but **only as advisory metadata**: it marks instruction-shaped content,
agent-directed directives, URL/`fetch` payloads, and encoded blobs, and surfaces flags in the proposal
so a reviewer looks closely. Flags never block a write, never auto-reject, and must never be presented
as "injection detected".

## Consequences

- Positive: prompt-injection _detection_ is not a load-bearing assumption; the containment holds even
  when a poisoned line reaches the proposal table. The auto-injected payload can no longer carry raw
  command output, so the highest-traffic injection path is closed. Dropping the session permission lock
  removes complexity that did not buy containment (it is time-scoped) and a footgun that would have
  denied the user's own tools during review; `memory-manager` being read-only still removes the
  permission-ordering fragility of the earlier scoped-`edit` design (ADR-0006/P2).
- Negative: reviewing requires reading provenance tags and approving untrusted lines individually —
  deliberately more work than a bulk approve, because a bulk approve is exactly the button that turns T2
  into a permanent compromise.
- Residual risk, stated honestly: a human can still approve a poisoned untrusted line. The mitigations
  are the `source:` tag, the advisory flags, and the bulk-approval exclusion — not a guarantee.
- `captureFailures: false` disables tool-output capture entirely for users who want the smallest
  attack surface.
- If a future capability lets the plugin classify _authoring provenance_ with certainty (rather than by
  directive form), the `source:user` heuristic from ADR-0004 can be tightened to it.

## Revision 2026-10-20 — prompt-tail placement (E8-A)

The stable active-context brief remains in the per-model-call system prefix with the fixed untrusted-data label. Volatile status, hint, and newest-handoff pointer are appended once per prompt to the canonical user input, not pushed into system, and not re-emitted on every tool continuation. The handoff pointer is a path + "(latest)" only, never content. The block is labelled data-only. Status/hint are plugin-generated; the pointer is memory-derived. No directive from memory moves into the prompt; the existing `AGENTS.md` protocol remains the only instruction channel. A retry marker prevents duplicate/lost notices.
