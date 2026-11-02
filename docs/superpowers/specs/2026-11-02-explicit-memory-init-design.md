# Explicit memory initialization gate — design

**Status:** approved design, 2026-11-02
**Issue:** #20 — disable plugin self-initiation and move initialization on demand
**Supersedes:** the first-run scaffold contract in `docs/design-spec-v2-production.md` §§4.4 and 7 step 0, and the first-run sentence in ADR-0006.

## Goal

Make the memory plugin inert for a project until the user explicitly initializes it. The plugin must not create `.opencode/memory`, memory files, or handoffs on setup, and it must not inject, capture, remember, or write through any hook, tool, or command before initialization.

Initialization is one user-invoked command: `/memory-init`.

## Non-goals

- A TUI sidebar memory-status indicator (separate issue).
- Changing post-initialization capture, review, apply, forget, GC, metrics, or injection behavior.
- Automatic (non-command) migration, repair, or background initialization.
- Purging or resetting existing memory content.
- A new config option, metric name, storage key, or model-facing tool.

## Locked decisions

1. **Full gate.** Until initialization, the plugin performs no indexing, injection, capture, snapshot, `remember:`, or memory-write work, and bumps no metrics counters.
2. **`INDEX.md` presence is the signal.** A project is initialized when `.opencode/memory/INDEX.md` exists as a regular file. Existing installs therefore become active automatically. Deleting `INDEX.md` returns the project to the uninitialized state.
3. **`/memory-init` is the only init affordance.** It is a plugin command, user-invoked, and never exposed as a model-facing tool.
4. **`/memory-init` is idempotent repair.** It creates only missing directories and templates and never overwrites existing files.
5. **Pre-init discovery is `/memory-status` and the docs only.** `setup()` prints no warning, no checklist, and no AGENTS.md nudge while the project is uninitialized. There is no prompt-tail notice and no setup console message.
6. **Pre-init surface is minimal.** Only `/memory-init`, `/memory-status`, and the `memory_status` tool work. Every other memory command/tool returns one fixed message: `[memory] not initialized; run /memory-init to create .opencode/memory`. Blocked commands may still render `--help` usage; no operation runs.
7. **Pre-init `remember:` is silently ignored.** No write, no notice, no staging buffer. The AGENTS.md protocol block is not installed until the first-init checklist is printed, so the plugin has not promised automatic recording.
8. **First init prints the consolidated checklist.** A repair run prints only a created/already-present summary. A failure before `INDEX.md` is created leaves the project uninitialized and says so.
9. **Status stays a full doctor.** `/memory-status` and `memory_status` always render the existing report plus an explicit initialization row and a `/memory-init` next action.
10. **No new configuration or vocabulary.** Exactly the existing five options, the frozen metric vocabulary, and the existing storage keys remain.

## Behavior contract

### Setup

- `setup()` performs no memory-directory creation and prints no first-run checklist.
- If the project is initialized, the existing unconditional `memory_write → ask` permission warning and the once-per-process AGENTS.md protocol nudge remain.
- If the project is uninitialized, setup prints no memory-init or scaffold message. Existing config-option warnings (`parseMemoryOptions`) are unchanged.

### Before initialization

| Surface | Behavior |
| --- | --- |
| `prompt` hook | Returns before `event.prompt.files` or `event.prompt.text` is mutated. No INDEX attach, notices, hint, status, or `remember:` write. |
| `context` hook | Returns before brief injection and before the throttled snapshot writer. |
| `compaction` hook | Returns before priors injection. |
| `execute.after` hook | Returns before failure capture. |
| Event loop | Drops events before `dispatchEvent`; no idle snapshots or compaction captures. |
| `memory_recall`, `memory_search`, `memory_apply`, `memory_metrics` | Return the fixed pre-init message before any read, write, or metric. |
| `/memory-review`, `/memory-forget`, `/memory-gc`, `/memory-metrics` | `--help` renders usage; any actual operation returns the fixed pre-init message before its normal work. |
| `/memory-status`, `memory_status` | Work normally and report `not initialized`. They may read file counts/health but never write or inject. |
| Metrics | No counter is bumped, including `hook.*`. |

### `/memory-init`

1. Probe whether `INDEX.md` already exists.
2. Ensure `handoffs/` and `handoffs/archive/`.
3. Create each missing template from `getScaffoldFiles()`.
4. Create `INDEX.md` last.
5. If `INDEX.md` was absent at the start and no failure occurred, print the file summary followed by the existing consolidated install checklist (permission rule, AGENTS.md protocol block, commented options, `/memory-status` pointer).
6. If `INDEX.md` was already present, or only a repair was needed, print a deterministic created/already-present summary.
7. If `INDEX.md` was absent and any earlier file or directory failed, do not create `INDEX.md`. Report the failure and state that the project remains uninitialized.
8. If `INDEX.md` was absent at the start but any of the other five templates already existed (reported as `present`), warn that the newly created INDEX is the default map and does not reconstruct a lost custom map. Existing files are untouched.

The command accepts no arguments except `--help`. It posts its output through `postCommandOutput(..., required = true)`, so a synthetic-post failure falls back to the existing prompt pattern. It never throws.

### After initialization

- All current behavior is unchanged.
- Missing files are no longer created by setup. `/memory-init` is the repair path; post-init writers keep their existing auto-create behavior.
- If `INDEX.md` is deleted while the plugin is loaded, the next hook/tool/command probe sees the project as uninitialized and becomes inert without a restart.

## Architecture

### New module: `src/init.ts`

| Export | Responsibility |
| --- | --- |
| `MEMORY_INIT_COMMAND_NAME`, `MEMORY_INIT_COMMAND_DESCRIPTION`, `MEMORY_INIT_USAGE` | Command identity and help text. |
| `MEMORY_NOT_INITIALIZED` | One fixed message used by every blocked surface. |
| `isInitialized(memoryRoot)` | `lstat()` the fixed `INDEX.md`; true only for a regular file (symlinks are not regular files); any error returns false. Never throws. |
| `initializeMemory(input)` | Idempotent create/repair. Returns `created`, `present`, `failures`, and `firstInit`. |
| `renderInitResult(result)` | Deterministic summary + checklist on first init; failure text when initialization did not complete. |
| `registerMemoryInit(ctx)` | Registers `/memory-init` via `ctx.command.transform`. |

`initializeMemory` uses the existing `writeNewCapped()` choke point for files, so redaction, caps, the in-process lock, the cross-process lock, and atomic publish are unchanged. It creates `INDEX.md` last so a partially created scaffold is not considered initialized.

### Wiring: `src/index.ts`

- Delete `scaffoldMemoryDir()` and the first-run checklist block.
- Register `registerMemoryInit(ctx)`.
- Add an `isInitialized()` guard at the top of each hook body, before `bump` and before any event mutation.
- Add the same guard inside the event-loop `handleEvent` callback before `dispatchEvent`.
- After registrations, compute the initialization state once for setup messaging: initialized projects keep the existing permission warning and AGENTS.md nudge; uninitialized projects stay silent.

The setup cleanup path is unchanged: abort the one event controller and dispose every registration.

### Guarded surfaces

- `src/tools.ts`: guard all four tools at the start of each executor.
- `src/review.ts`: guard before the `review.invoked` metric and before the review prompt.
- `src/forget-command.ts`, `src/gc-command.ts`: guard after `--help` handling and before reads/plans/approvals.
- `src/metrics.ts`: guard the command before reset/read/render; the `memory_metrics` tool is guarded in `src/tools.ts`.
- `src/status-report.ts`:
  - Add `initialized: boolean` to `StatusReport`.
  - Populate it with `isInitialized(deps.memoryRoot)`.
  - Use the same regular-file probe for `indexExists`, so a directory or special file named `INDEX.md` is not reported as attachable while the initialization row says uninitialized.
  - Render an `| initialization | ... |` row.
  - Change the memory-directory row from “scaffolds on first run” to the explicit-init state.
  - Replace “restart/reload the plugin to scaffold” with `/memory-init` actions.
  - Suppress capture-activity advice while uninitialized.
- `src/templates.ts`: rename `firstRunInstallText()` to `initInstallText()` and make it the checklist body starting at `Next steps:`; `renderInitResult()` supplies the single outcome line so the command does not print two headings.

### Deliberately unchanged

- `src/files.ts` and `src/capture.ts` gain no initialization checks. The gate lives at the production surfaces; writers remain reusable by tests and future callers.
- No change to `src/config.ts`, the five-option contract, the metric vocabulary, storage key shapes, permissions, or redaction.

### Secondary surfaces

- `commands/memory-review.md`: add a preflight that stops and asks the user to run `/memory-init` when `INDEX.md` is missing.
- `agents/memory-manager.md`: add the same preflight so the read-only subagent does not propose work against a missing store.
- No `commands/memory-init.md` stub: a prompt-only file command cannot create the scaffold, and `/memory-init` is plugin-registered.

## Data flow

1. Plugin setup probes `isInitialized(projectRoot/.opencode/memory)`.
2. Every hook/tool/command probes the same path at invocation time. False means the fixed message or an early return.
3. The user runs `/memory-init`.
4. `initializeMemory` writes the missing directories and templates, with `INDEX.md` last.
5. The command posts the summary/checklist.
6. The next hook/tool/command probe sees `INDEX.md` and normal behavior resumes without a restart.

## Error handling

- `isInitialized` treats every `lstat` failure as “not initialized” (fail closed: the plugin stays inert).
- `initializeMemory` catches per-target errors and continues long enough to report them. If `INDEX.md` was absent, any earlier failure prevents INDEX creation.
- After the write loop, if `INDEX.md` is present but `isInitialized` is still false (for example, `INDEX.md` is a directory or special file), record an `INDEX.md is not a regular readable file` failure and report that initialization did not complete.
- `/memory-init` never throws. A completed mutation is not reported as an operation failure because output delivery failed.
- Error text is fixed prose plus allowlisted file names and a bounded one-line error message; no memory content is emitted.
- Two concurrent `/memory-init` calls are safe: `writeNewCapped` uses exclusive create and the existing locks, so one wins each file and the other reports “already present”.
- `/memory-init` does not call `ctx.permission.assert`: the user explicitly invoked the command, and setup previously performed the same scaffold writes without a permission prompt. No model-facing path can trigger it.

## Test plan

### New `test/init.test.ts`

- `isInitialized`: regular file true; missing false; directory false; symlink false; `lstat` error false.
- `initializeMemory`: creates six files + both directories; never overwrites; `INDEX.md` last; first-init flag; partial repair; failure before INDEX leaves the project uninitialized; concurrent calls are safe.
- `renderInitResult`: first-init checklist; repair summary; failure wording; lost-map warning.
- `/memory-init`: `--help`; unexpected argument; synthetic failure fallback; never throws.

### Pre-init gate matrix

- Setup creates no `.opencode/memory` files and prints no warning.
- All four hooks leave events unchanged and write no files or metrics.
- The event loop writes no handoffs or captures.
- Every blocked tool/command returns the fixed message.
- `/memory-status` and `memory_status` work and report `not initialized`.
- No metric counter changes.

### Lifecycle

- First init activates hooks, tools, and commands without restart.
- Existing `INDEX.md` activates without running init.
- Deleting `INDEX.md` re-inerts the plugin.
- Repair after deleting one template leaves the others untouched.

### Existing suites

- `test/scaffold.test.ts`: replace “setup scaffolds” assertions with “setup does not scaffold” plus init coverage.
- `test/hooks.test.ts`, `test/tools.test.ts`, `test/status-report.test.ts`, `test/acceptance-metrics.test.ts`: update strings and fixtures.
- Shared `setupHooks` helper pre-creates the full scaffold by default so existing behavior tests stay focused; gate tests opt into the uninitialized state.

## Documentation plan

- Add **ADR-0011 — Explicit memory initialization gate**; amend ADR-0006’s first-run sentence.
- Update `docs/design-spec-v2-production.md` §§4.4, 5.7, 5.13, 7 step 0, and 10.
- Update `docs/user-stories.md` US-04 and US-30.
- Update `README.md` Quickstart, lifecycle commands, uninstall, and troubleshooting.
- Update `CONTRIBUTING.md` layout/invariants and `docs/c4-03`, `docs/c4-04`, `docs/c4-06`.
- Add a `CHANGELOG.md` Unreleased entry.
- Update the `memory-review` stub and `memory-manager` preflight.

No new option, metric name, storage key, or model-facing tool is documented.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A new user does not discover `/memory-init`. | `/memory-status` reports it, and the README Quickstart makes it step 3. The accepted cost of staying silent pre-init. |
| A pre-init `remember:` is lost. | Accepted by the fully inert choice; the AGENTS.md block is not installed until init. |
| Deleting `INDEX.md` accidentally deactivates the plugin. | Status reports the state; `/memory-init` recreates the default map and warns that a lost custom map is not reconstructed. |
| Existing installs break. | Any existing regular `INDEX.md` activates the plugin automatically; no migration write is needed. |
| An INDEX that is a directory or unreadable is ambiguous. | Treated as uninitialized; status/init surface the condition and the failure. |
| Test churn is large. | Shared test helper initializes by default; only the new gate tests use the uninitialized state. |

## Acceptance criteria

- [ ] A fresh project: setup, hooks, event loop, tools, and commands create no `.opencode/memory` files and bump no metrics before init.
- [ ] Before init, only `/memory-init`, `/memory-status`, and `memory_status` work; every other surface returns the fixed message.
- [ ] `/memory-init` creates the six templates plus `handoffs/` and `handoffs/archive/`, with `INDEX.md` last, and prints the consolidated checklist on first init.
- [ ] `/memory-init` is idempotent, never overwrites, and reports partial failures without publishing INDEX.
- [ ] An existing regular `INDEX.md` activates the plugin without running init.
- [ ] Deleting `INDEX.md` re-inerts the plugin without a restart.
- [ ] `/memory-status` and `memory_status` render the full report with an initialization row and `/memory-init` actions.
- [ ] Post-init behavior is unchanged.
- [ ] No new option, metric name, storage key, or model-facing tool.
- [ ] ADR-0011, spec, user stories, README, CONTRIBUTING, C4 docs, command/agent preflights, and CHANGELOG are updated; tests and doc gates pass.
