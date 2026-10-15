# No-Fuss Memory Plugin for OpenCode V2

Local-first, zero-subscription, zero-daemon, zero-embeddings memory for OpenCode V2. Git-backed markdown is the source of truth; hooks are passive and budget-capped; curation is human-approved.

## What it remembers

Project background, architectural decisions + why + rejected options, last refactors, planned GitHub issues, and your working style (no tech-debt deferral, architecture lock across model swaps, contract-first implementation with ripple lists).

## What it never does by default

No transcripts, no embeddings/vector search, no cloud/server/API keys, no per-turn LLM extraction, no silent durable writes, no custom compaction triggers. The `compaction` hook injects priors only and never sets `event.result` (ADR-0003).

Memory content is treated as **untrusted data, never instructions** (ADR-0007). Raw captured command output is never auto-injected — the brief carries one tagged summary line per known error and the bodies stay recall-only. `/memory-review` **writes nothing**: it only produces a proposal table, and untrusted candidates are never bulk-approved — each approved line goes through the `memory_apply` tool, which checks permissions once per line. The review is deliberately **not** sandboxed: a session permission lock is time-scoped (it would defer, not contain, the threat) and would deny your own tools. The optional read-only `memory-manager` subagent isolates the pass to a child session. Prompt-injection *detection* is explicitly not a security boundary; minimisation, provenance, and per-line human approval are. The one write that is not review-gated is a `source:user` directive (an explicit "remember X" in your own message), which the plugin appends to the append-only `decisions.md` immediately (ADR-0004 revision).

## Layout

```
AGENTS.md (repo root)         # hand-owned protocol + links only (never auto-written, never content)
.opencode/
├── opencode.jsonc             # .opencode/opencode.jsonc → plugins: ["./plugins/memory"]; repo-root → ["./.opencode/plugins/memory"]; plus agents: { memory-manager } and ≤5 plugin options (ADR-0006: no references entry)
├── agents/memory-manager.md   # on-demand curator, read-only: `*` deny, `read/glob/grep` allow only (proposes only; ADR-0007)
├── plugins/memory/index.ts    # prompt/context/compaction hooks, execute.after capture, memory_recall, memory_apply, /memory-review
└── memory/                    # six files (INDEX, activeContext, decisions, architecture, style, issues) + handoffs/ root (snapshots) + handoffs/archive/ (retired lines)
```

The memory directory is fixed at `.opencode/memory` — not configurable — because the `readCapped`/`writeCapped` choke point and the recall allowlist depend on a stable root (ADR-0006). The plugin never edits `opencode.jsonc` or `AGENTS.md`; it scaffolds templates and emits a commented options snippet.

## Try it without code (P0)

Create the six memory files by hand, add the protocol block to root `AGENTS.md`, and use the `memory-manager` subagent manually. A new session should restore context from `INDEX.md` + `activeContext.md` with no re-explaining.

## Docs

- `docs/design-spec-v2-production.md`: **the design spec — normative on V2 contracts and implementation.** Self-contained: verified V2 contract (§1), package/options (§2–3), install/config (§4), component specs (§5), data model/budgets (§6), lifecycle (§7), deferrals (§8), build/test/release (§9), roadmap (§10). Supersedes the other documents on any V2-contract conflict.
- `docs/c4-01-system-context.md` → `c4-06-code.md`: C4 Context, Container, Component, Code, plus supplementary specs A (interfaces, `c4-04`) and B (data model, `c4-05`). `c4-01–c4-06` are `proposed`; all are aligned to the design spec.
- `docs/user-stories.md`: User (US-01–27), Agent (AS-01–09), and Harness (HS-01–11) stories with acceptance criteria.
- `docs/adr/0001–0007.md`: the load-bearing decisions (normative on decision intent). `0003` was revised (compaction never sets `event.result`); `0004` was revised (provenance gate: user-asserted facts are durable immediately); `0006` is new (fixed memory location, minimal config, no `references` entry); `0007` is new (memory content is untrusted: minimisation, provenance, proposal-only review, per-line approval).
- Root: `motivation.md` (background synthesis + the superseded §4.6 sketch; **not** normative on V2 contracts).

**Precedence:** ADRs are normative on decision intent; `design-spec-v2-production.md` is normative on V2 contracts and implementation; the C4 docs and `user-stories.md` are descriptive and defer to the spec; `motivation.md` is background and its §4.6 skeleton is superseded and non-normative.
