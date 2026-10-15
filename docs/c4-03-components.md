# C4 Level 3 — Components: No-Fuss Memory Plugin for OpenCode V2

**Status:** proposed. **Sources:** Synthesized Report §§4.3–4.6; V2 docs `/v2/docs/build/plugins/` (hooks, transforms, storage). **Normative on V2 contracts:** `design-spec-v2-production.md` §5.

## Components (all inside the plugin container)

| Component | Responsibility | V2 primitive |
|---|---|---|
| Prompt hook | Async, never-throws; sole injector of `INDEX.md` content (capped; over-cap file is *not* attached); deduped — skip if already attached; root `AGENTS.md` carries protocol+links only, never content; retry-safe. One bounded side effect: a `source:user` directive appends to `decisions.md` (the only hook that sees the user's turn before admission; serialized, never-throw, ledger-idempotent, no pending increment) | `session.hook("prompt")` |
| Context hook | **Async, never-throws**; push active brief at bottom (max 5 message-derived error lines; never INDEX map nor decisions tail) + one `[memory]` status line (rotation notice / review-due nudge) + 1-line tell-tale hint on exact INDEX match only, **throttled via `<projectID>/hint/<sessionID>/<promptHash>`**; brief does **not** duplicate INDEX | `session.hook("context")`, `event.system.push` |
| Compaction hook | Inject capped + redacted priors (`loadPriors`: activeContext slice + decisions tail + handoff pointer) into summary context; **never sets `event.result`** (that would skip the native summary); never change model/threshold/trigger; never throws | `session.hook("compaction")` |
| Tool hook | Failure-only capture on `execute.after` (`event.status === "error"`; `Tool.Error{message}` only, no cmd/code); redact, ledger check-before-write; writes a `source:tool` message-derived summary line (G4) + **optional** recall-only detail block; scratchpad writes increment pending | `ctx.tool.hook("execute.after")` |
| Event subscriber | `session.idle` snapshots (hash-guarded via `<projectID>/snapshot/<sessionID>`; G1 proven; location-less only for known sessions, else drop) + `session.compaction.ended` summary capture (`data.text`+`recent`, replay-guarded via `<projectID>/seen/<event.id>`; G1 proven) + sampled diagnostics; per-dispatch never-throw (a throw on N must not stop N+1); **filters via `event.location` + session/project IDs** before writing; single abortable stream | `ctx.event.subscribe` + `AbortController` |
| Provenance classifier | Pure, zero-LLM **detection**: tags every entry `source:user \| tool \| model \| snapshot`; only an explicit user directive (documented `remember:` line-start form, outside fences/quotations) is `user`; the `source:user` write is performed in the `prompt` hook (serialized, never-throw) | pure function |
| Injection guard | `flagInjection` advisory flags + untrusted labelling + `sanitizeForBrief` (message-derived summary line only, max 5; bodies never enter the payload) | pure functions |
| Capture ledger | Persisted (`ctx.storage`, never in-memory alone); `<projectID>/seen/<id>`, `<projectID>/attempt/<id>`, `<projectID>/curation.pending` (scratchpad-only), `<projectID>/curation.rotated`, `<projectID>/snapshot/<sessionID>`, `<projectID>/snapshotThrottle/<sessionID>`, `<projectID>/hint/<sessionID>/<promptHash>`; single-flight per content ID (no CAS); ~30s retry window; pruned via `scan({prefix:"<projectID>/seen/"})` | `ctx.storage` |
| `memory_recall` tool | Allowlisted single-file read (`INDEX/activeContext/decisions/architecture/style/issues` + `handoffs/<name>.md` + `handoffs/archive/<name>.md`; recallable on demand, never auto-injected); capped + redacted; returns the executor envelope via `toolResult` (default `{ content }`); error on unknown/traversal; description doubles as retrieval policy | `ctx.tool.transform` |
| `memory_apply` tool | The **only** channel that writes approved lines: executor-bound IDs, one `assert({action:"memory_write",resources:[file],save:[]})` per candidate sequentially (deny propagates; `candidates:[]` resets); requires shipped `memory_write → ask`; untrusted lines cannot be bulk-approved | `ctx.tool.transform` |
| `/memory-review` command | Propose scratchpad → durable promotions (`decisions/architecture/style/issues`); validate `issues.md` manual edits; human approves | `ctx.command.transform` |
| Loaders | `indexWithinCap`, `loadBrief`, `loadPriors`, `matchIndex` (all async + awaited), `readCapped`/`writeCapped` (`node:fs/promises`, budget-enforcing) | async functions |
| Redactor | Secrets blocklist + `<private>` stripping before any write/inject | pure function |

```mermaid
flowchart TD
  T[Tool failure: execute.after] --> TH[Tool hook] --> Prov[Provenance classifier: source:tool] --> Ledger[(Ledger: ctx.storage)] --> Scratch[activeContext.md: summary + recall-only detail, rotate to archive]
  E[Events: session.idle / session.compaction.*] --> Sub[Event subscriber] --> Hand[handoffs/ root; archive/ for retired lines]
  P[Prompt admission] --> PH[Prompt hook: sole INDEX injector, deduped] --> IDX[INDEX.md attach]
  A[Root AGENTS.md chain] --> Proto[Protocol + links only, never content]
  C[Model dispatch] --> CH[Context hook] --> Brief[Brief summary lines + status line + hint]
  K[Compaction] --> KH[Compaction hook: priors only, never event.result]
  Agent --> Tool[memory_recall: allowlisted, recall-only bodies] --> Files[Memory files]
  U[User directive: remember] --> Prov2[source:user] --> Dec[decisions.md append-only, tagged]
  Dev --> Cmd[/memory-review] --> Prop[Proposal table + provenance + flags]
  Prop --> Approve[Human approves per line via memory_apply: assert per line] --> Durable[decisions/architecture/style/issues]
  Durable --> Reset[memory_apply resets curation.pending + rotated marker]
  Guard[Injection guard: flagInjection advisory + untrusted labelling] -.-> Prov
  Guard --> Cmd
```

## Verification-note (P1 runtime gates; G1/G2/G4 proven via `@opencode/plugin@2.0.29` types)

- Failure capture uses the documented tool hook (`event.status === "completed"|"error"`; `Tool.Error{message}` only — no cmd/code/stdout).
- `session.idle` (ephemeral, `data:{sessionID}`) and `session.compaction.started/delta/ended/failed` are enumerated in `@opencode/schema`; `compaction.ended.data` carries `{text,recent,…}`. A deploy-time `event.type` log confirms delivery. Fallbacks: an async, fire-and-forget, serialized, hash-guarded `context`-hook snapshot writer (throttle `<projectID>/snapshotThrottle/<sessionID>`); pointer-only compaction handoff when the event is missing.
- `session.idle` ≠ session end — it may fire N times; the handler MUST be content-hash-guarded (`<projectID>/snapshot/<sessionID>`: branch via `vcs.get()` + status + pending); same content → no-op.
- **G5 (retired):** a plugin command **cannot** target a subagent (`CommandInvocation` has no agent selector), and a session permission lock does not contain `T1` (it is time-scoped — the reviewed text persists in the transcript — and it would deny the user's own tools). The review is **proposal-only** and every write is per-line approved, so no sandbox is required. The read-only `memory-manager` subagent remains an optional isolated venue.

## Rules

- Hooks transform the current call only; durable writes happen exclusively through ledger-guarded capture (scratchpad), the `source:user` fast path (`decisions.md`, written in the `prompt` hook), and approved promotion via `memory_apply` (durable). `issues.md` accepts manual edits but `/memory-review` validates format/caps/redaction.
- `decisions.md` and `handoffs/` are append-only/immutable; `architecture.md`/`style.md`/`issues.md` are review-gated rewrites (git blame preserves lineage).
- **Memory content is untrusted data, never instructions.** No component acts on text read from memory; the review writes nothing and only proposes, and every durable write is approved per line (`memory_apply`) — not merely a system-prompt instruction; captured command output never enters the auto-injected payload except as a tagged summary line; untrusted candidates are never bulk-approved (ADR-0007).
- No component calls the network, embeddings, or an LLM in the default path.
- Decisions: ADR-0001 through ADR-0007.
