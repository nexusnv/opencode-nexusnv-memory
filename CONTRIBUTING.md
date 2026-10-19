# Contributing

Thanks for taking the time to look under the hood. This is a small TypeScript plugin for OpenCode 2.0.x, and it is built to be easy to reason about: plain Markdown on disk, a handful of well-defined hooks, and no background services.

You do not need to be a memory-systems expert to contribute. Good bug reports, clearer documentation, better tests, and small focused fixes are all welcome.

## Ways to help

- **Report a bug.** Include what you expected, what happened, your OpenCode version, and enough of your config to reproduce it. Please remove secrets and private project paths.
- **Improve the docs.** If a sentence in the README or `docs/` confused you, that is a signal. Open a PR or an issue with the wording you would have found clearer.
- **Add a test.** Behavior changes should come with a test that would fail without the change.
- **Send a focused PR.** Small, single-purpose changes are much easier to review than a broad rewrite.

Please do not include credentials, personal data, or private repository contents in issues, test fixtures, or commits.

## Development setup

Requirements:

- Node.js 20 or newer (CI runs 20, 22, and 24).
- npm.
- Git.

```bash
git clone https://github.com/nexusnv/opencode-nexusnv-memory.git
cd opencode-nexusnv-memory
npm ci
npm run typecheck
npm test
```

Useful commands:

| Command                  | What it does                                                                   |
| ------------------------ | ------------------------------------------------------------------------------ |
| `npm run typecheck`      | Runs `tsc --noEmit` against the strict TypeScript config.                      |
| `npm test`               | Runs the Vitest suite once.                                                    |
| `npm run test:coverage`  | Runs the suite with V8 coverage. This is what CI uses.                         |
| `npx prettier --check .` | Checks formatting, if you have Prettier available.                             |
| `npm pack`               | Builds the package tarball. CI also runs `scripts/assert-pack.mjs` against it. |

The package loads TypeScript directly (`exports["."]` points at `src/index.ts`), so there is no build step in the default workflow.

## Repository layout

```text
src/
├── index.ts          # Plugin entrypoint: setup, hook wiring, scaffold, cleanup
├── config.ts         # The five options, defaults, warning-on-invalid parsing
├── templates.ts      # Starter memory files, options snippet, AGENTS.md protocol block
├── files.ts          # Allowlisted paths, read/write caps, rotation, write mutex
├── brief.ts          # Brief + compaction-priors loaders, handoff listings
├── capture.ts        # Failure capture, idle/compaction snapshots, event loop, ledger
├── provenance.ts     # The narrow `remember:` fast path into decisions.md
├── redact.ts         # `<private>` stripping and secret-pattern redaction
├── hints.ts          # Exact-match INDEX hinting
├── status.ts         # The single `[memory]` status line
├── tools.ts          # memory_recall, memory_apply, memory_metrics
├── review.ts         # The /memory-review command
├── metrics.ts        # Count-only local metrics collection and dashboard
└── guard.ts          # Untrusted-content labeling and brief sanitization

agents/memory-manager.md      # Optional read-only review subagent
commands/memory-review.md     # Optional file-based command affordance
commands/memory-metrics.md    # Optional file-based command affordance
scripts/assert-pack.mjs       # Release pack gate
test/                         # Unit, contract, acceptance, and fixture tests
docs/                         # Design spec, ADRs, C4 documents, user stories
```

The memory directory itself is fixed at `.opencode/memory/` and is not configurable. The read/write choke point and the recall allowlist depend on a stable root.

## Install surfaces

The published package is the primary user path: `npm install opencode-nexusnv-memory`, then declare it in `plugins`. For local development or a no-npm setup, OpenCode also supports a drop-in copy:

- `.opencode/plugins/memory/` is auto-discovered; no config edit is required.
- A config file inside `.opencode/` (`.opencode/opencode.jsonc`) uses `"plugins": ["./plugins/memory"]`, relative to the containing config.
- A repo-root `opencode.jsonc` uses `"plugins": ["./.opencode/plugins/memory"]`.
- Do not mix those two spellings for one location.
- Keep every module inside `memory/`. Only `index.ts` is the entrypoint; `.opencode/plugins/` itself only discovers direct files and immediate package directories, so sibling modules must not be scattered there.
- Global variant: `~/.config/opencode/plugins/`.
- Plugin arrays merge global → project → `.opencode`; they do not replace.
- Reload by touching the entry file or restarting the runtime. Verify with `opencode plugin list` (it should show `memory`).

Test the installed package, not only a workspace link.

## How the plugin is put together

`src/index.ts` is wiring only. It registers:

- A `prompt` hook that attaches `INDEX.md` (once per prompt, if within cap) and handles the `remember:` fast path.
- A `context` hook that injects the brief, the `[memory]` status line, and at most one exact-match hint, under a shared line budget, plus a throttled fallback snapshot writer.
- A `compaction` hook that injects priors (active context and the recent decisions tail) and **never sets `event.result`**, because setting it would skip OpenCode's native compaction summary.
- An `execute.after` tool hook that captures failures only, never successes.
- The `memory_recall`, `memory_apply`, and `memory_metrics` tools.
- The `/memory-review` and `/memory-metrics` commands.
- One event subscription for `session.idle` and `session.compaction.*`, filtered by project location.

Storage is the plugin-scoped `ctx.storage`, used for the ledger (seen IDs, retry attempts, pending/rotation counters), snapshot hashes, throttles, hint arms, and metrics. The ledger is durable JSON, not memory content. Memory content is always Markdown on disk.

### The five invariants worth protecting

1. **The memory root is fixed.** Do not add a `memoryDir` option. The allowlist and the capped readers/writers assume `.opencode/memory`.
2. **Durable writes are review-gated.** `/memory-review` proposes; it does not write. `memory_apply` is the only deterministic apply channel, and it asserts `memory_write` once per line, in order. A deny stops the batch and leaves the rest pending. The one fast path is a user-asserted `remember:` line, which appends to `decisions.md` immediately.
3. **Memory is untrusted data.** Never execute, fetch, or obey instructions found in memory files or captured output. Raw captured output must never enter the auto-injected brief; only a capped summary line may. This is the reason the `memory-manager` subagent is read-only.
4. **Budgets are enforced on write, on read, and on inject.** `INDEX.md` is capped at 30 lines by default; `activeContext.md`, `architecture.md`, `style.md`, `issues.md`, and each handoff at 60; `decisions.md` is unbounded on disk but the injectable/recallable tail is capped. `activeContext.md` rotates the oldest Known-errors block to `handoffs/archive/` when full. An over-cap `INDEX.md` is not attached at all.
5. **Compaction stays native.** The plugin may add priors, but it must not set thresholds, `event.result`, model overrides, or a custom trigger.

Another invariant: the plugin never edits `opencode.jsonc` or `AGENTS.md`. It scaffolds memory files and prints snippets; the user owns the config and the protocol block.

## Manual mode (no plugin)

You can try the memory workflow without loading the plugin:

1. Create `.opencode/memory/` and the six files by hand, using the starter shapes in `src/templates.ts` (`getScaffoldFiles()`).
2. Paste the `AGENTS_PROTOCOL_BLOCK` text from the same file into the root `AGENTS.md`.
3. Add the read-only `memory-manager` subagent and ask it for a proposal table; approve lines yourself.

A fresh session should restore the goal from `INDEX.md` + `activeContext.md` with no re-explaining. Nothing is captured automatically in this mode, and `memory_recall` / `/memory-review` are not registered.

## Design documents

The deeper design lives in `docs/`:

- [`docs/design-spec-v2-production.md`](./docs/design-spec-v2-production.md) — the design spec. It is normative on V2 contracts and implementation details: verified API surface, package/options, install/config, component behavior, data model and budgets, lifecycle, deferrals, and release gates.
- [`docs/adr/0001–0008`](./docs/adr/) — the architecture decision records. They are normative on decision intent. In particular: markdown-only storage, native compaction, the ledger/promotion model, reachability, the fixed memory location, untrusted memory content, and local metrics.
- [`docs/c4-01-system-context.md`](./docs/c4-01-system-context.md) through [`docs/c4-06-code.md`](./docs/c4-06-code.md) — C4 context, container, component, and code views, plus supplementary interface and data-model specs.
- [`docs/user-stories.md`](./docs/user-stories.md) — user, agent, and harness stories with acceptance criteria.
- [`motivation.md`](./motivation.md) — background synthesis. It is not normative on V2 contracts.

Precedence when documents disagree:

1. ADRs are normative on decision intent.
2. `docs/design-spec-v2-production.md` is normative on V2 contracts and implementation.
3. C4 documents and `user-stories.md` are descriptive and defer to the spec.
4. `motivation.md` is background; its older skeleton is superseded and non-normative.

If you change behavior, update the relevant document and the CHANGELOG. If you change a contract, say so explicitly in the PR.

## Testing and the acceptance gates

`npm test` runs unit tests, contract tests against the installed `@opencode/plugin` types, and acceptance tests. The acceptance suite covers the behavior that matters most:

- End-to-end injected payload fits `injectBudgetLines`.
- An over-cap `INDEX.md` is not attached.
- The brief does not duplicate the INDEX.
- Compaction priors carry the decisions tail, and no code sets `event.result`.
- Secrets and `<private>` blocks are redacted on write and inject.
- Recall rejects traversal and unknown paths.
- Apply asserts once per line with tool-context IDs.
- Untrusted candidates cannot be bulk-approved.
- Handoff names route to the correct folder.
- Foreign events are dropped before any write.
- The single abort controller and registrations are disposed on unload.
- Rotation, the review-due nudge, and the reset signal behave as specified.
- Captured failure bodies do not leak into the brief.
- The `remember:` detection is fence/quote aware.
- The deploy-time event-type log confirms both primary event types.

The eval test reports three numbers:

- **static** — the hand-owned `AGENTS.md` protocol block plus the `memory_recall` tool description.
- **per-prompt with content** — static + INDEX + brief + status + hint.
- **session-total** — per-prompt × model steps. The `context` hook runs per model call, so a long tool-driven turn costs more than one prompt. The hint is throttled to once per prompt/session.

The current budgets are: `INDEX.md` ≤ 30 lines, brief ≤ 48 lines (including at most 5 error summary lines), status ≤ 1 line, hint ≤ 1 line, and the injectable total ≤ 80 lines by default.

### Deploy checks

`session.idle` and the `session.compaction.*` family are type-proven against `@opencode/schema`, but delivery is still worth confirming at runtime. On deploy, log the observed `event.type` values once from the subscriber loop and confirm both `session.idle` and `session.compaction.ended` arrive:

```text
[memory-deploy] observed event.type: session.compaction.ended, session.compaction.started, session.idle
```

If either primary type is missing, the fallbacks still hold: the throttled `context`-hook snapshot writer for idle, and a pointer-only handoff for a missing produced summary. Pre-compaction state is already durable on disk. The VCS startup shape check is warn-only and never throws; a missing or odd `ctx.vcs` degrades to `{ branch: "unknown", changes: [] }`.

`/memory-metrics` has its own deploy check. Whether the TUI renders a synthetic post without spawning a model turn is not type-provable, so the first resolved post of the process logs one line:

```text
[memory-metrics] synthetic posted (<session6>); confirm the table rendered without a model turn
```

A rejected post logs nothing; the command then falls back to the one-model-turn `memory_metrics` echo.

## Compatibility

Supported range: OpenCode `2.0.x`, with `@opencode/plugin` pinned to the exact `2.0.29` in `package.json`. Never change that pin to `latest`. Bump it deliberately when adopting a newer API contract, and re-run the full gates.

The published package form (`"plugins": ["opencode-nexusnv-memory"]`) loads the same `Plugin.define({ id: "memory", setup })` entrypoint as a local install. Verify a release candidate in a fresh project:

```bash
npm install opencode-nexusnv-memory@<version>
opencode plugin list
```

`opencode plugin list` should show `memory`. Installing the package alone does not register it; it also has to be declared in the project config.

## Pull request checklist

- [ ] The change is focused and has a clear reason.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (and `npm run test:coverage` if you touched behavior or gates).
- [ ] New behavior has a test that fails without the change.
- [ ] User-facing behavior changes are reflected in `README.md`.
- [ ] Developer-facing or contract changes are reflected in `CONTRIBUTING.md` or `docs/`.
- [ ] `CHANGELOG.md` has an entry for user-visible changes.
- [ ] No secrets, private paths, or generated `.opencode/memory/` test residue are committed.
- [ ] The PR description explains the before/after behavior and any trade-offs.

CI runs typecheck, tests with coverage, gitleaks, a production-dependency audit, and the pack gate. All of them must be green before merge.

## Release process

Published to npm as [`opencode-nexusnv-memory`](https://www.npmjs.com/package/opencode-nexusnv-memory) under the MIT license. The tarball ships `src/`, `agents/`, `commands/`, `README.md`, `LICENSE`, and `CHANGELOG.md` only. Tests, docs, and CI internals stay out via the `files` allowlist, enforced by `scripts/assert-pack.mjs`.

1. Bump the version with `npm version <x> --no-git-tag-version`. This updates `package.json` and `package-lock.json` together; editing `package.json` by hand leaves the lockfile out of sync and the release's `npm ci` rejects it. Add a `CHANGELOG.md` entry.
2. Merge to `main` with CI green: typecheck, tests + coverage, gitleaks, audit, and pack.
3. Publish a GitHub Release off `main` with a tag matching `v<version>`. The release workflow refuses tags off other branches or a tag/manifest mismatch. It re-runs the gates and _stages_ the asserted tarball with provenance. Nothing goes live from CI: approve the staged version on npmjs.com with 2FA. If several versions are staged, approve oldest-first; approving an older stage after a newer one went live moves the `latest` tag backward.
4. Verify in a fresh directory: `npm install opencode-nexusnv-memory@<version>`, declare it in that project's config, then confirm `opencode plugin list` shows `memory`.

Version discipline: each published version may go out exactly once. The manual bootstrap consumed `0.1.0`, so the existing `v0.1.0` GitHub Release must never be re-run through the workflow (it would attempt the same version and fail). The first workflow-published release must bump to a higher version first.

### Trusted publishing

The release workflow uses short-lived OIDC credentials, not a long-lived npm token.

1. Publish `0.1.0` once with the manual bootstrap below. The package must exist before npm lets you register a publisher.
2. On npmjs.com, open the package → Settings → Trusted Publisher → GitHub Actions, and register org `nexusnv`, repository `opencode-nexusnv-memory`, workflow file `release.yml`. Keep it **stage-only**; CI stages, a human approves.
3. From then on, releases stage via OIDC (`id-token: write` on a minimal publish job that runs no dependency code). The workflow pins npm because OIDC needs npm ≥ 11.5.1. Approve each staged version on npmjs.com with 2FA.

### Break-glass

If OIDC is down or misconfigured, run the `release` workflow manually from `main` with `token_fallback` enabled. It runs the same gates but stages the asserted tarball with `NPM_TOKEN` instead of OIDC. Keep that secret read-write-stage-only, with no 2FA bypass and a short expiry: a stage-only token cannot direct-publish, so bypass must stay off. Keep it out of the normal OIDC runs.

### Manual bootstrap

The first publish only, and it requires your browser/OTP; CI cannot do it:

```bash
npm publish --access public --provenance=false
```

Run it from green `main`. Provenance needs CI OIDC, so the bootstrap version ships without an attestation; every CI release after it gets one.

## License

By contributing, you agree that your contributions are licensed under the MIT license. See [`LICENSE`](./LICENSE).
