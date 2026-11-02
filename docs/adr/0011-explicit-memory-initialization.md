# ADR-0011 — Explicit memory initialization gate

**Status:** accepted. **Date:** 2026-11-02. **Supersedes:** the first-run scaffold contract in ADR-0006 and design-spec §§4.4/7 step 0.

## Context

The plugin used to create `.opencode/memory/` during `setup()`. That made the
plugin a writer before the user asked for a memory store, and it meant a
partial or unwanted scaffold could activate indexing, capture, and metrics.
A project should be inert until the user explicitly initializes it.

## Decision

- A project is initialized when `.opencode/memory/INDEX.md` exists as a
  regular file (`lstat().isFile()`). Existing installs activate with no
  migration; deleting INDEX deactivates the plugin without a restart.
- `setup()` never creates the memory directory, prints no first-run checklist,
  and stays silent for an uninitialized project. It keeps the existing
  `memory_write → ask` warning and AGENTS.md nudge only after initialization.
- `/memory-init` is the only init affordance. It is plugin-registered,
  user-invoked, accepts no arguments except `--help`, and never appears as a
  model-facing tool.
- `/memory-init` is idempotent repair: create only missing directories and
  templates, never overwrite, create `INDEX.md` last. If INDEX was absent and
  any earlier target failed, INDEX is not created and the project remains
  uninitialized.
- Before initialization, only `/memory-init`, `/memory-status`, and
  `memory_status` work. Every other memory tool/command returns
  `[memory] not initialized; run /memory-init to create .opencode/memory`.
  No hook injects, captures, snapshots, remembers, or bumps a metric.
- `/memory-status` always renders the full doctor, including an
  `initialization` row and a `/memory-init` next action.
- Pre-init `remember:` is silently ignored. The AGENTS.md protocol block is
  not installed until the first-init checklist is printed.

## Consequences

- Positive: no writes or model-visible injection before explicit consent; a
  partial scaffold cannot activate the plugin; existing installs need no
  migration; INDEX deletion is a safe deactivation.
- Negative: a new user must discover `/memory-init` from the README or
  `/memory-status`; a pre-init `remember:` is lost; deleting INDEX
  accidentally deactivates the plugin. These are accepted under the
  fully-inert choice.
- The five-option contract, metric vocabulary, storage keys, and permission
  behavior are unchanged. `src/files.ts` and `src/capture.ts` gain no gate;
  the gate lives at the production surfaces.

## Alternatives considered

- **Dedicated marker file or storage flag:** rejected because INDEX presence
  already distinguishes an installed store, and a marker adds a legacy
  adoption rule for every existing install.
- **Scaffold-only gate:** rejected because hooks could still create files and
  bump counters before the user asked for memory.
- **Lazy dynamic registration:** rejected because it depends on hook/tool
  registration being safe after setup and complicates cleanup; per-surface
  guards are simpler to test.
