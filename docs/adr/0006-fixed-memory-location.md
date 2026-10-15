# ADR-0006 — Fixed memory location; minimal config; no `references` entry

**Status:** accepted. **Date:** 2026-10-15.

## Context

The plugin's safety story depends on where memory lives and which writes are gated:

- The `memory-manager` subagent's permissions are declared as **static** frontmatter. Since ADR-0007 the
  agent is read-only (no `edit`, no `shell`), so this argument is no longer load-bearing for `edit` — but
  it is exactly the fragility that made a configurable root dangerous: a static `resource` glob cannot
  track a configurable path, and it would silently widen or break the scope.
- Read-path security (`readCapped`) and the recall allowlist are keyed to a stable root.
- An earlier draft exposed a `memoryDir` option while every path, the allowlist, and the agent
  permission remained hardcoded to `.opencode/memory` — an option that could not actually be honored.

Separately, the draft registered `references: { memory: { path: ".opencode/memory/INDEX.md" } }`.
On V2 a reference attaches a **directory** (or Git repo) and is a client-initiated attachment intended
for directories *outside* the project. The file-level form was invalid, the directory form is
redundant for an in-project path already reachable via `memory_recall` + the `AGENTS.md` protocol, and
references are not an automatic injection channel.

## Decision

- Memory lives at the **fixed** path `.opencode/memory/`. It is not configurable.
- The plugin exposes exactly five options (`indexLines`, `fileLines`, `injectBudgetLines`,
  `captureFailures`, `snapshotThrottleMinutes`), all optional, read via `ctx.options`.
- The plugin registers **no** `references` entry and never edits `opencode.jsonc` or `AGENTS.md`; on
  first run it scaffolds memory files and emits the commented options snippet and protocol block for
  the user to paste.
- If a future need for a configurable root is proven, the memory root must be threaded through
  `readCapped`/`writeCapped`, the recall allowlist, and any generated agent frontmatter together.

## Consequences

- Positive: agent `edit` scoping is enforceable; read-path gating has one stable choke point; config
  surface stays at one file with ≤5 options; removes the invalid/redundant reference.
- Negative: users cannot relocate the memory directory; accepted because relocation has no current
  use case and would break permission scoping.
