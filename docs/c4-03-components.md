# C4 Level 3 — Components: No-Fuss Memory Plugin for OpenCode V2

**Status:** proposed. **Sources:** Synthesized Report §§4.3–4.6; V2 docs `/v2/docs/build/plugins/` (hooks, transforms, storage).

## Components (all inside the plugin container)

| Component | Responsibility | V2 primitive |
|---|---|---|
| Prompt hook | Attach `INDEX.md` (capped) to current prompt only; retry-safe, no side effects | `session.hook("prompt")` |
| Context hook | Push active brief at bottom + 1-line tell-tale hint on exact INDEX match only | `session.hook("context")`, `event.system.push` |
| Compaction hook | Inject priors into summary context; record summary as handoff | `session.hook("compaction")` (`event.result` optional) |
| Event subscriber | Failure-only capture (`tool.execute.after`), idle snapshots; abortable stream | `ctx.event.subscribe` + `AbortController` |
| Capture ledger | Check-before-write, persisted attempts, ~30s retry window | `ctx.storage` |
| `memory_recall` tool | Capped single-file read; description doubles as retrieval policy | `ctx.tool.transform` |
| `/memory-review` command | Propose scratchpad → durable promotions; human approves | `ctx.command.transform` |
| Loaders | `loadBrief`, `loadPriors`, `matchIndex`, `readCapped` (all budget-enforcing) | pure functions |
| Redactor | Secrets blocklist + `<private>` stripping before any write/inject | pure function |

```mermaid
flowchart TD
  E[Events: tool failures, session idle] --> Sub[Event subscriber] --> Ledger[(Ledger)] --> Scratch[activeContext.md]
  P[Prompt admission] --> PH[Prompt hook] --> IDX[INDEX.md attach]
  C[Model dispatch] --> CH[Context hook] --> Brief[Brief + hint line]
  K[Compaction] --> KH[Compaction hook] --> Hand[handoffs/]
  Agent --> Tool[memory_recall] --> Files[Memory files]
  Dev --> Cmd[/memory-review] --> Durable[decisions/architecture/style]
```

## Rules

- Hooks transform the current call only; durable writes happen exclusively through ledger-guarded capture and approved promotion.
- No component calls the network, embeddings, or an LLM in the default path.
- Decisions: ADR-0001 through ADR-0005.
