# C4 Level 3 — Components: No-Fuss Memory Plugin for OpenCode V2

**Status:** proposed. **Sources:** Synthesized Report §§4.3–4.6; V2 docs `/v2/docs/build/plugins/` (hooks, transforms, storage).

## Components (all inside the plugin container)

| Component | Responsibility | V2 primitive |
|---|---|---|
| Prompt hook | Sole injector of `INDEX.md` content (capped); deduped — skip if already attached; `AGENTS.md` carries protocol+links only, never content; retry-safe, no side effects | `session.hook("prompt")` |
| Context hook | Push active brief at bottom + 1-line tell-tale hint on exact INDEX match only | `session.hook("context")`, `event.system.push` |
| Compaction hook | Inject priors into summary context (shape-guarded: `event.system.push` when present; always handle `event.result`); record summary as handoff; never change model/threshold/trigger | `session.hook("compaction")` |
| Event subscriber | Failure-only capture (`tool.execute.after` — verify against live V2 event catalog at P1), content-hash-guarded idle snapshots (same content → no-op); abortable stream | `ctx.event.subscribe` + `AbortController` |
| Capture ledger | Persisted (`ctx.storage`, never in-memory alone); check-before-write, persisted attempts, ~30s retry window | `ctx.storage` |
| `memory_recall` tool | Allowlisted single-file read (`INDEX/activeContext/decisions/architecture/style/issues` + `handoffs/*.md`); capped + redacted; error on unknown; description doubles as retrieval policy | `ctx.tool.transform` |
| `/memory-review` command | Propose scratchpad → durable promotions (`decisions/architecture/style/issues`); validate `issues.md` manual edits; human approves | `ctx.command.transform` |
| Loaders | `loadBrief`, `loadPriors`, `matchIndex`, `readCapped` (all budget-enforcing) | pure functions |
| Redactor | Secrets blocklist + `<private>` stripping before any write/inject | pure function |

```mermaid
flowchart TD
  E[Events: tool failures, session idle] --> Sub[Event subscriber] --> Ledger[(Ledger: ctx.storage)] --> Scratch[activeContext.md: append-until-60, then rotate to archive]
  P[Prompt admission] --> PH[Prompt hook: sole INDEX injector, deduped] --> IDX[INDEX.md attach]
  A[AGENTS.md chain] --> Proto[Protocol + links only, never content]
  C[Model dispatch] --> CH[Context hook] --> Brief[Brief + hint line]
  K[Compaction] --> KH[Compaction hook: shape-guarded priors + result] --> Hand[handoffs/ root; archive/ for retired lines]
  Agent --> Tool[memory_recall: allowlisted] --> Files[Memory files]
  Dev --> Cmd[/memory-review] --> Durable[decisions/architecture/style/issues]
```

## Event-note (must verify at P1)

Event strings `tool.execute.after` and `session.idle` are provisional: confirm against the live `/v2/docs/build/plugins/` event catalog via runtime log before merge. If absent, fallback is prompt-hook file-diff capture. `session.idle` ≠ session end — idle may fire N times; handler MUST be content-hash-guarded (branch + status + pending); same content → no-op.

## Rules

- Hooks transform the current call only; durable writes happen exclusively through ledger-guarded capture (scratchpad) and approved promotion (durable). `issues.md` accepts manual edits but `/memory-review` validates format/caps/redaction.
- `decisions.md` and `handoffs/` are append-only/immutable; `architecture.md`/`style.md`/`issues.md` are review-gated rewrites (git blame preserves lineage).
- No component calls the network, embeddings, or an LLM in the default path.
- Decisions: ADR-0001 through ADR-0005.
