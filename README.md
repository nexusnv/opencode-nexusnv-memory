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

## Install

Two independent axes: **where the plugin code lives** (drop-in vs package) and **which config file declares it** (`.opencode/` vs repo root). Pick one cell.

| Code location | Config file | `plugins` entry |
|---|---|---|
| `.opencode/plugins/memory/` (drop-in, auto-discovered; no config edit) | — | — (auto-discovery) |
| `.opencode/plugins/memory/` | `.opencode/opencode.jsonc` | `"plugins": ["./plugins/memory"]` (relative to the containing config) |
| `.opencode/plugins/memory/` | repo-root `opencode.jsonc` | `"plugins": ["./.opencode/plugins/memory"]` |
| npm package `opencode-nexusnv-memory` | either config | `"plugins": ["opencode-nexusnv-memory"]` or `{ "package": "opencode-nexusnv-memory", "options": { … } }` |

Global variant: `~/.config/opencode/plugins/`. Arrays merge global → project → `.opencode` (they do not replace). Never mix the two relative spellings for one location. Inside `.opencode/plugins/memory/`, only `index.ts` is the entrypoint; sibling modules load via relative imports.

Verify with `opencode plugin list` (shows `memory`); reload by touching the entry file or restarting the runtime per its reload guidance. Supported range: OpenCode `2.0.x` with `@opencode/plugin` pinned to the exact `2.0.29` in `package.json` (never `latest`).

### Plugin options (all optional)

```jsonc
{
  // "indexLines": 30,              // INDEX.md cap (lines, on disk)
  // "fileLines": 60,               // activeContext/architecture/style/issues + per-handoff cap
  // "injectBudgetLines": 80,       // total auto-inject payload (INDEX attach + brief + status + hint)
  // "captureFailures": true,       // append failed shell/build/test output to activeContext.md
  // "snapshotThrottleMinutes": 10  // min interval between context-hook snapshots per session
}
```

Invalid or missing values warn once and fall back to defaults; loading never throws. The memory directory is fixed at `.opencode/memory` and intentionally not configurable. The plugin never edits `opencode.jsonc`; on first run it scaffolds the directory and prints this snippet for you to paste.

### Permissions (required)

Ship this rule alongside the plugin so `memory_apply` prompts instead of failing open (the base `*/* → allow` policy would otherwise auto-allow the novel action with no matching rule):

```jsonc
{
  "permissions": [
    { "action": "memory_write", "resource": "*", "effect": "ask" }
  ]
}
```

On setup the plugin emits an unconditional loud warning that this rule must be installed — effective rules cannot be verified at setup. If the optional `memory-manager` delegation path is enabled, the parent agent also needs `{ "action": "subagent", "resource": "memory-manager", "effect": "allow" }`.

## Budgets

`INDEX.md` ≤ 30 lines on disk; `activeContext`/`architecture`/`style`/`issues` ≤ 60 lines; `decisions.md` unbounded with a ≤60-line injectable tail; handoffs ≤ 60 lines/file. Auto-inject payload = `INDEX ≤30 + brief ≤48 + status ≤1 + hint ≤1` (≤80 total). An over-cap `INDEX.md` is not attached; `/memory-review` reports the violation instead.

## Uninstall

Remove the `plugins` entry and/or delete `.opencode/plugins/memory/`; remove the `AGENTS.md` protocol block by hand. `.opencode/memory/` stays in git until an explicit `git rm` (never auto-deleted). The `ctx.storage` ledger is harmlessly orphaned. No daemon, server, keys, or index to purge. Acceptance: `opencode plugin list` hides `memory`; hooks stop; history restores any prior state.
