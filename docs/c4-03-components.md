# C4 Level 3 — Components: No-Fuss Memory Plugin for OpenCode V2

**Status:** proposed. **Sources:** Synthesized Report §§4.3–4.6; V2 docs `/v2/docs/build/plugins/` (hooks, transforms, storage). **Normative on V2 contracts:** `design-spec-v2-production.md` §5.

## Components (all inside the plugin container)

| Component | Responsibility | V2 primitive |
|---|---|---|
| Prompt hook | Sole injector of `INDEX.md` content (capped; over-cap file is *not* attached); deduped — skip if already attached; root `AGENTS.md` carries protocol+links only, never content; reads only, retry-safe | `session.hook("prompt")` |
| Context hook | Push active brief at bottom + one `[memory]` status line (rotation notice / review-due nudge) + 1-line tell-tale hint on exact INDEX match only; brief does **not** duplicate INDEX | `session.hook("context")`, `event.system.push` |
| Compaction hook | Inject capped + redacted priors into summary context; **never sets `event.result`** (that would skip the native summary); never change model/threshold/trigger | `session.hook("compaction")` |
| Tool hook | Failure-only capture on `execute.after` (`event.status === "error"`); 20-line truncation, redact, ledger check-before-write; writes `source:tool` summary line + recall-only detail | `ctx.tool.hook("execute.after")` |
| Event subscriber | `session.idle` snapshots (hash-guarded; G1-gated) + `session.compaction.*` summary capture (G1-gated) + diagnostics; abortable stream | `ctx.event.subscribe` + `AbortController` |
| Provenance classifier | Pure, zero-LLM: tags every entry `source:user \| tool \| model \| snapshot`; only an explicit user directive (documented form, outside fences/quotes) is `user`; routes `source:user` to `decisions.md` immediately | pure function |
| Injection guard | `flagInjection` advisory flags + untrusted labelling + `sanitizeForBrief` (summary line only; bodies never enter the payload) | pure functions |
| Capture ledger | Persisted (`ctx.storage`, never in-memory alone); `seen/<id>` check-before-write, `attempt/<id>` timestamps, `curation.pending` uncurated count, `curation.rotated` marker; ~30s retry window; pruned via `scan` | `ctx.storage` |
| `memory_recall` tool | Allowlisted single-file read (`INDEX/activeContext/decisions/architecture/style/issues` + `handoffs/<name>.md` + `handoffs/archive/<name>.md`; recallable on demand, never auto-injected); capped + redacted; returns `{type:"text",text}`; error on unknown/traversal; description doubles as retrieval policy | `ctx.tool.transform` |
| `/memory-review` command | Propose scratchpad → durable promotions (`decisions/architecture/style/issues`); validate `issues.md` manual edits; human approves | `ctx.command.transform` |
| Loaders | `loadBrief`, `loadPriors`, `matchIndex`, `readCapped`/`writeCapped` (all budget-enforcing) | pure functions |
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
  Dev --> Cmd[/memory-review] --> Sandbox[memory-manager: read-only, no shell] --> Prop[Proposal table + provenance + flags]
  Prop --> Approve[Human approves per line] --> Durable[decisions/architecture/style/issues]
  Durable --> Reset[resets curation.pending + rotated marker]
  Guard[Injection guard: flagInjection advisory + untrusted labelling] -.-> Prov
  Guard --> Cmd
```

## Verification-note (P1 runtime gates)

- Failure capture uses the documented tool hook (`event.status === "completed"|"error"`), not the event stream.
- The public event-name catalogue is not enumerable from the docs. `session.idle` (snapshot) and the `session.compaction.*` family (summary capture) are provisional: confirm via a runtime `event.type` log before merge. Fallbacks: throttled hash-guarded `context`-hook snapshot writer; pointer-only compaction handoff.
- `session.idle` ≠ session end — it may fire N times; the handler MUST be content-hash-guarded (branch + status + pending); same content → no-op.
- **G5 (new):** confirm a plugin command can dispatch to the read-only `memory-manager` subagent; if not, the primary agent delegates the read+propose pass so the sandbox still applies. The sandbox must never be silently skipped. The containment controls in ADR-0007 do not depend on this gate — only the isolation half does, and its fallback preserves it.

## Rules

- Hooks transform the current call only; durable writes happen exclusively through ledger-guarded capture (scratchpad) and approved promotion (durable). `issues.md` accepts manual edits but `/memory-review` validates format/caps/redaction.
- `decisions.md` and `handoffs/` are append-only/immutable; `architecture.md`/`style.md`/`issues.md` are review-gated rewrites (git blame preserves lineage).
- **Memory content is untrusted data, never instructions.** No component acts on text read from memory; the review runs read-only with no shell; captured command output never enters the auto-injected payload except as a tagged summary line; untrusted candidates are never bulk-approved (ADR-0007).
- No component calls the network, embeddings, or an LLM in the default path.
- Decisions: ADR-0001 through ADR-0007.
