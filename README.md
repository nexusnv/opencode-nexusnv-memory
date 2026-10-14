# No-Fuss Memory Plugin for OpenCode V2

Local-first, zero-subscription, zero-daemon, zero-embeddings memory for OpenCode V2. Git-backed markdown is the source of truth; hooks are passive and budget-capped; curation is human-approved.

## What it remembers

Project background, architectural decisions + why + rejected options, last refactors, planned GitHub issues, and your working style (no tech-debt deferral, architecture lock across model swaps, contract-first implementation with ripple lists).

## What it never does by default

No transcripts, no embeddings/vector search, no cloud/server/API keys, no per-turn LLM extraction, no silent durable writes, no custom compaction triggers.

## Layout

```
.opencode/
├── AGENTS.md                  # hand-owned protocol + links only (never auto-written, never content)
├── opencode.jsonc             # .opencode/opencode.jsonc → plugins: ["./plugins/memory"]; repo-root → ["./.opencode/plugins/memory"]; plus agents: { memory-manager }
├── agents/memory-manager.md   # on-demand curator (edit: .opencode/memory/**, shell: deny)
├── plugins/memory/index.ts    # prompt/context/compaction hooks, memory_recall, /memory-review
└── memory/                    # six files (INDEX, activeContext, decisions, architecture, style, issues) + handoffs/ root (snapshots) + handoffs/archive/ (retired lines)
```

## Try it without code (P0)

Create the six memory files by hand, add the protocol block to root `AGENTS.md`, and use the `memory-manager` subagent manually. A new session should restore context from `INDEX.md` + `activeContext.md` with no re-explaining.

## Docs

- `docs/c4-01-system-context.md` → `c4-06-code.md`: C4 Context, Container, Component, Code, plus supplementary specs A (interfaces, `c4-04`) and B (data model, `c4-05`).
- `docs/adr/0001–0005.md`: the five load-bearing decisions.
- Root: `motivation.md` (normative overview + skeleton; file list, budgets, and hook contracts defer to `c4-05`/`c4-04` on conflict).
