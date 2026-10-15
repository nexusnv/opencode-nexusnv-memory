# Memory Plugin Implementation Plan

> **For workers:** Execute task-by-task via `tdd` + `verification-before-completion`. Review gate: `implementation-plan-review` (plan), `oracle-review` (after impl). Adapted to this repo: TypeScript gates in Task 10 replace the Python gate block; plan-review criteria (references exist, each task startable, QA has tool+steps+expected) still apply.

**Goal:** Implement the production-ready OpenCode V2 memory plugin exactly as `docs/design-spec-v2-production.md` §§2–7 normatively specify, so P1 acceptance (§10: $0 default, ≤80-line injection, no duplicates across restart, priors survive compaction, G1–G4 type-proven with deploy log) passes on the first implementation pass.

**Architecture:** Twelve `src/` modules behind a wiring-only `index.ts` entrypoint (`Plugin.define({ id: "memory", setup })`, Promise flavor only). All durable state is git-backed markdown under fixed `.opencode/memory/` plus a `ctx.storage` ledger; all injection is budget-capped hook transforms (`prompt` → INDEX attach + `source:user` fast path; `context` → brief + status + hint; `compaction` → priors only, never `event.result`); all durable promotion flows through proposal-only `/memory-review` + per-line `memory_apply` (`action: "memory_write"`, deny-propagating). What is NOT changed: no `compaction` thresholds/model/trigger, no `references` entry, no `instructions` array usage, no embeddings/SQLite/network/LLM in the default path, no nested-`AGENTS.md` writes (ADR-0001–0007 hold).

**Tech Stack:** TypeScript `strict: true`, `type: module`, pinned `@opencode/plugin@2.0.29` (exact, never `latest`); `node:fs/promises` server-side only for file IO (all loaders async); `vitest` for unit + contract + fixture tests; `npx tsc --noEmit` for type gate; `opencode plugin list` + deploy-time `event.type` log for compatibility gate.

**References:** `docs/design-spec-v2-production.md:31-64` (§1 contract), `:95-137` (G1–G4 proven), `:138-192` (§2 layout/manifest), `:192-219` (§3 options), `:220-302` (§4 install/agents/references/AGENTS block), `:303-779` (§5 components), `:780-814` (§6 data/budgets), `:815-855` (§7 lifecycle), `:856-889` (§8 deferred), `:890-942` (§9 acceptance), `:943-952` (§10 roadmap); `docs/c4-04-interfaces.md:5-48` (tool/command/hook contracts); `docs/c4-05-data-model.md:7-29` (schemas/budgets); `docs/c4-06-code.md:27-42` (function contracts); `docs/user-stories.md:7` (conventions), `:28-50` (US-07–09, US-11–13, US-15–16, US-25–27), `:75-84` (HS-02–05, HS-11); `docs/adr/0001-markdown-only.md`, `0002-agents-md-injection.md`, `0003-native-compaction-only.md:15-26`, `0004-ledger-and-promotion.md:11-33`, `0005-reachability-and-telltale.md`, `0006-fixed-memory-location.md:24-33`, `0007-untrusted-memory-content.md:33-59`; `motivation.md:88-96` (§4.3 lifecycle); `README.md:20-26` (layout/fixed root).

**Branch:** `feature/memory-plugin` (fresh repo; P0 manual needs no branch discipline, P1 implementation lands here)

---

## File Structure

- Create: `package.json` — name `opencode-nexusnv-memory`, version `0.1.0`, `type: module`, `exports: { ".": "./src/index.ts" }`, `dependencies: { "@opencode/plugin": "2.0.29" }`
- Create: `tsconfig.json` — `strict: true`, `module: nodenext`, `target: es2022`, `include: ["src", "test"]`
- Create: `src/index.ts` — wiring only: `Plugin.define({ id: "memory", setup })`, single `AbortController`, `registrations` array, all `hook`/`transform` registrations, async cleanup aborting controller + awaiting `dispose()`
- Create: `src/config.ts` — read `ctx.options` once in `setup`; exactly 5 optional options (`indexLines=30`, `fileLines=60`, `injectBudgetLines=80`, `captureFailures=true`, `snapshotThrottleMinutes=10`); invalid → warn once + default, never throw
- Create: `src/files.ts` — `readCapped`/`writeCapped`, allowlist + `handoffs/(archive/)?[A-Za-z0-9._-]+\.md` pattern, traversal rejection (`..`, absolute, backslash, percent-encoded separators), cap + truncation-notice enforcement, one per-process write mutex; plugin writes throw on capped-rule violation, `activeContext.md` rotates oldest Known-Errors block to `handoffs/archive/` instead; hand-edits never pass through here (review validates)
- Create: `src/redact.ts` — secrets blocklist + `<private>…</private>` strip (case-insensitive, multiline, outermost-wins, unclosed-to-EOF), applied before every write and every inject
- Create: `src/brief.ts` — `loadBrief` (async: activeContext slice + newest-handoff pointer, ≤48 lines incl. max 5 message-derived error lines; never INDEX map, never decisions tail) + `loadPriors` (async: activeContext slice + decisions tail ≤60 + handoff pointer, compaction only)
- Create: `src/hints.ts` — `matchIndex` (async: parse latest user-authored text from `event.messages: Message[]`, exact INDEX match only, ≤1 hint line or `undefined`, throttle via `<projectID>/hint/<sessionID>/<promptHash>`)
- Create: `src/status.ts` — `statusLine` (async: ≤1 `[memory]` line from `ctx.storage` only; rotation notice once then clear marker with one concurrent double-emit tolerated; review-due nudge while `<projectID>/curation.pending ≥ 5` scratchpad-only; both join with `;`; dropped before hint under budget pressure)
- Create: `src/capture.ts` — `captureFailure` (failures only, `Tool.Error{message}` message-derived summary ≤120 chars with `<cmd>:` prefix only when untyped `event.input` yields it, optional ≤20-line detail only via `error.metadata` inspection, redact, content-ID ledger check-before-write, ~30s retry, scratchpad-only `pending` increment + `rotated` on rotation) + `snapshotHandoffIfChanged` (async fire-and-forget serialized: root from `event.location` + `data.sessionID` fallback `ctx.location`, branch `(await ctx.vcs.get()).data.branch.current` fallback `(await (ctx.vcs.branch?.list ?? ctx.vcs.branches)()).data[0] ?? "unknown"` warn-only, changes `(await ctx.vcs.status()).data` fallback `(await ctx.vcs.diff({mode:"working",context:3})).data` normalized to strings, hash guard `<projectID>/snapshot/<sessionID>`, immutable `handoffs/YYYY-MM-DD-HHmmss-<session6>.md`, newest wins) + ledger helpers + `snapshotIfDue` throttle-gate (`<projectID>/snapshotThrottle/<sessionID>`) around it + `captureCompactionOutcome` (`session.compaction.ended` `data.text`+`recent` → `handoffs/`, replay-guarded via `<projectID>/seen/<event.id>`, pointer-only via `/memory-review` only when missing)
- Create: `src/provenance.ts` — `classifyProvenance` (pure: `user` only for line-start `remember:`/`remember that` outside fences/quotations, pastes covered only by that heuristic; else `tool`/`model`/`snapshot`) + `rememberAsserted` (prompt-hook site: redact, ledger-dedup, append to append-only `decisions.md` tagged `(user-asserted)`, never increments pending, never targets rule files, serialized + never-throw)
- Create: `src/guard.ts` — `flagInjection` (advisory only: imperative/agent-directed/URL-fetch/encoded-blob flags surfaced in proposals, never blocks/rejects/detects) + untrusted labelling + `sanitizeForBrief` (one ≤120-char message-derived line + `source:` tag, body dropped)
- Create: `src/tools.ts` — `ctx.tool.transform`: `memory_recall` (`{file}` required allowlisted, `execute: async (input) => toolResult(await readCapped(...))`, description doubles as retrieval policy) + `memory_apply` (`{candidates:[{file,line,source,flags?}]}` incl. `candidates:[]` reviewed-nothing signal; executor binds `sessionID/agent/source` from tool context; sequential per-line `ctx.permission.assert({action:"memory_write",resources:[file],metadata:{line,source},source,save:[]})`, propagate first deny with rest pending, `writeCapped` verbatim on allow, reset `pending→0` + clear `rotated` on completion incl. `[]`; command never resets)
- Create: `src/templates.ts` — six-file scaffolds + `handoffs/` + commented ≤5-option snippet + mandatory `memory_write→ask` permissions snippet + `AGENTS.md` protocol block text (narrow trigger forms, fence/quote heuristic + paste caveat)
- Create: `agents/memory-manager.md` — `mode: subagent`, leading `*→deny` then `read/glob/grep→allow` only; body = proposal-only prompt (untrusted-data directive, no execution/fetch/write, proposal-table output)
- Create: `commands/memory-review.md` — optional file-based secondary affordance (plugin command normative); shares one registry, later source wins
- Test: `test/files.test.ts` — allowlist/traversal/caps/rotation/notice (unit)
- Test: `test/redact.test.ts` — blocklist fixtures + `<private>` variants incl. unclosed (unit)
- Test: `test/provenance.test.ts` — `remember:` line-start vs `remember when`/`I remember` vs fenced/quoted/pasted rejections (unit)
- Test: `test/ledger.test.ts` — restart/replay idempotency, single-flight, scan pagination `<projectID>/seen/`, 500-prune (contract with fake storage)
- Test: `test/tools.test.ts` — `toolResult` shape vs installed package, recall traversal rejection, `memory_apply` per-line assert + deny propagation + `[]` reset (contract)
- Test: `test/hooks.test.ts` — prompt dedup + over-cap no-attach + async loaders awaited, brief ≤48/max-5/no-INDEX/no-tail, hint throttle, status rotation-once + nudge ≥5 + drop-before-hint, compaction priors-only never `result` (unit + budget)
- Test: `test/isolation.test.ts` — foreign `event.location` dropped, location-less unknown-session `idle` dropped, per-dispatch throw on N never stops N+1 (fault injection), single `AbortController` + `dispose()` awaited (contract)
- Test: `test/fixtures/secrets.*` — blocklist patterns enumerated for `redact` tests
- Test: `test/fixtures/poison-error.txt` — agent-directed instruction in error text lands on disk, brief carries only the summary line (containment fixture)
- Docs: `README.md` — install matrices, P0 manual, budgets, uninstall (modify)
- Docs: `CHANGELOG.md` — P1 entry + supported OpenCode range (create)

No new modules beyond the 12 above; no `paxman/core`-style shared-kernel change (VCS/storage behind one adapter each inside `capture.ts`/ledger helpers, not a separate layer).

## Background the implementer needs

### Current state (verbatim)

No `package.json`, no `src/`, no `test/` exist — greenfield. The normative skeleton lives only in prose: `docs/design-spec-v2-production.md:318-343` (prompt hook async + `rememberAsserted`), `:345-396` (context hook `await loadBrief`/`await statusLine`/`await matchIndex` + fire-and-forget `snapshotIfDue`), `:439-471` (recall executor with `await readCapped`), `:472-534` (`memory_apply` executor-bound IDs, `memory_write`, deny propagation, `candidates:[]` reset, command never resets), `:535-555` (compaction priors incl. decisions tail), `:556-624` (ledger keys/scan/VCS envelopes/statusLine), `:666-702` (event loop per-dispatch `.catch`, known-session location-less rule, `ended` replay guard).

### Design decisions (locked)

1. Promise flavor only (`@opencode/plugin`, `setup`); no `effect()` import, no `server()` dual export (§2).
2. Fixed root `.opencode/memory` — `memoryDir` option permanently dropped (ADR-0006).
3. `pending` counts scratchpad writes only; snapshots and `source:user` appends never increment; only `memory_apply` resets (incl. `[]`).
4. Branch primary `(await ctx.vcs.get()).data.branch.current`; compat fallback `(branch?.list ?? branches)()` warn-only; diff fallback `diff({mode:"working",context:3})` normalized to strings before hashing.
5. Handoffs `YYYY-MM-DD-HHmmss-<session6>.md` (`session6 = sessionID.slice(-6)`); `ended` replay-guarded, `idle` hash-guarded; pointer-only handoffs review-only.
6. Manager `*→deny` first, `read/glob/grep→allow` only; parent delegation needs literal `{action:"subagent",resource:"memory-manager",effect:"allow"}`.
7. Setup emits unconditional `memory_write→ask` warning (effective rules unverifiable at setup); scaffold + first-run print are the install channel.

### Task 1: Scaffold package, config, templates, agent, docs shell

**Files:** `package.json`, `tsconfig.json`, `src/index.ts`, `src/config.ts`, `src/templates.ts`, `agents/memory-manager.md`, `commands/memory-review.md`, `README.md`, `CHANGELOG.md`

**Goal:** Bootable plugin that loads (`opencode plugin list` shows `memory`), scaffolds six files + `handoffs/`, emits both snippets, registers no hooks yet beyond wiring.

- [ ] Failing test first: `test/scaffold.test.ts::shows_memory_in_plugin_list_and_scaffolds` → FAIL (no package). Implement: manifest exact dep `2.0.29`, `tsconfig strict`, `Plugin.define({id:"memory",setup})` wiring with controller + registrations + async cleanup, `config.ts` 5-option parse (warn-once default, never throw), `templates.ts` scaffolds + options snippet + `memory_write→ask` snippet + AGENTS block, manager leading-deny frontmatter, file-based command stub. Verify: `npx tsc --noEmit` → PASS; `npx vitest run test/scaffold.test.ts` → PASS; `opencode plugin list` shows `memory` on the installed package (not workspace link). Commit: `feat: scaffold memory plugin package (P1-T1)`.

### Task 2: Files, redaction, budgets choke point

**Files:** `src/files.ts`, `src/redact.ts`, `test/files.test.ts`, `test/redact.test.ts`, `test/fixtures/secrets.*`

**Goal:** Single enforceable budget/redaction layer every later writer/loader routes through.

- [ ] Failing tests: `test/files.test.ts::rejects_traversal_and_enforces_caps` + `test/redact.test.ts::strips_blocklist_and_private_variants` → FAIL. Implement: `readCapped`/`writeCapped` allowlist + handoff regex + traversal rejects + cap/notice + rotation of oldest Known-Errors block to `handoffs/archive/` + per-process mutex; `redact` blocklist + `<private>` outermost-wins unclosed-to-EOF. Verify: `npx vitest run test/files.test.ts test/redact.test.ts` → PASS; over-cap INDEX attach refusal covered in Task 5. Commit: `feat: files + redaction budgets (P1-T2)`.
- Depends on: Task 1 (package/mutex home in `files.ts` used by all later writes).

### Task 3: Ledger + storage adapter

**Files:** `src/capture.ts` (ledger helpers), `test/ledger.test.ts`

**Goal:** Restart-safe idempotency with namespaced keys and paginated prune.

- [ ] Failing test: `test/ledger.test.ts::dedupes_replay_and_prunes_to_500` → FAIL (no ledger). Implement: keys `<projectID>/seen/<id>`, `<projectID>/attempt/<id>`, `<projectID>/curation.pending`, `<projectID>/curation.rotated`, `<projectID>/snapshot/<sessionID>`, `<projectID>/snapshotThrottle/<sessionID>`, `<projectID>/hint/<sessionID>/<promptHash>`; check-before-write + single-flight + ~30s retry; `scan({prefix:"<projectID>/seen/"})` with `after`/`next` pagination, oldest-evicted to ≤500. Verify: `npx vitest run test/ledger.test.ts` → PASS (restart/replay simulated via persisted fake storage). Commit: `feat: ledger + storage adapter (P1-T3)`.

### Task 4: Capture, provenance fast path, injection guard

**Files:** `src/capture.ts` (`captureFailure`), `src/provenance.ts`, `src/guard.ts`, `test/provenance.test.ts`, `test/fixtures/poison-error.txt`

**Goal:** Zero-LLM provenance-tagged capture with bounded fast path and advisory-only flags.

- [ ] Failing tests: `test/provenance.test.ts::user_directive_vs_fenced_quoted_ambiguous` + containment fixture (poison error on disk, brief summary-only) → FAIL. Implement: `captureFailure` message-derived ≤120-char summary (`<cmd>:` only from `event.input`), optional detail only via `error.metadata`, `flagInjection` advisory attach, scratchpad-only pending/rotated; `classifyProvenance` pure + `rememberAsserted` prompt-hook append (`(user-asserted)`, no pending, never rule files). Verify: `npx vitest run test/provenance.test.ts` → PASS. Commit: `feat: capture + provenance + guard (P1-T4)`.

### Task 5: Prompt, context, compaction hooks

**Files:** `src/index.ts` (registrations), `src/brief.ts`, `src/hints.ts`, `src/status.ts`, `test/hooks.test.ts`

**Goal:** Bounded injection with one INDEX owner, async never-throw everywhere.

- [ ] Failing tests: `test/hooks.test.ts` (dedup, over-cap no-attach, brief ≤48/max-5/no-INDEX/no-tail, hint once-per-prompt, status rotation-once + nudge-≥5 + drop-before-hint, priors include decisions tail, never sets `result`) → FAIL. Implement: async prompt hook (`await indexWithinCap` + `await rememberAsserted`, try/catch), async context hook (`await loadBrief`/`await statusLine`/`await matchIndex`, fire-and-forget `snapshotIfDue`), async compaction hook (`await loadPriors`, never `result`). Verify: `npx vitest run test/hooks.test.ts` → PASS; injection ≤ `injectBudgetLines` asserted. Commit: `feat: session hooks (P1-T5)`.

### Task 6: `memory_recall` + `memory_apply` tools

**Files:** `src/tools.ts`, `test/tools.test.ts`

**Goal:** Allowlisted recall + the only deterministic apply channel with fail-closed approval.

- [ ] Failing tests: `test/tools.test.ts::recall_envelope_and_traversal_reject` + `::apply_per_line_assert_deny_propagates_and_empty_resets` → FAIL. Implement: `toolResult` adapter (`{content:text}`), recall `await readCapped` + description-as-policy, apply executor-bound IDs + sequential `assert({action:"memory_write",resources:[file],metadata:{line,source},source,save:[]})` + verbatim `writeCapped` + first-deny propagation + `candidates:[]` reset. Verify: `npx vitest run test/tools.test.ts` → PASS; contract asserts `Tool.Result` shape against installed `@opencode/plugin`. Commit: `feat: recall + apply tools (P1-T6)`.

### Task 7: `/memory-review` command (proposal-only)

**Files:** `src/index.ts` (command registration), `test/review.test.ts`

**Goal:** Read+propose phase that writes nothing and preserves attachments.

- [ ] Failing test: `test/review.test.ts::proposes_table_and_writes_nothing` → FAIL. Implement: executor spreads `{...prompt, sessionID, text: base+ask, delivery}` (files/agents/skills preserved, no `metadata` claim), ask text reads INDEX + activeContext and demands proposal-table-only with provenance + flags + cap/redaction checks + `issues.md` validate-don't-overwrite; command never resets counters. Verify: `npx vitest run test/review.test.ts` → PASS. Commit: `feat: memory-review command (P1-T7)`.

### Task 8: Event subscriber + VCS adapter

**Files:** `src/capture.ts` (`snapshotHandoffIfChanged`, `captureCompactionOutcome`, `isThisLocation`, `isKnownDiagnostic`), `test/isolation.test.ts`

**Goal:** Primary idle/compaction capture with survival and isolation guarantees.

- [ ] Failing tests: `test/isolation.test.ts` (foreign `event.location` dropped, location-less unknown-session `idle` dropped, throw-on-N never stops N+1, `ended` replay deduped, VCS envelope unwrap + `branch.list` compat + diff normalization, single controller + `dispose()`) → FAIL. Implement: per-dispatch `.catch`, `isThisLocation` (directory + session/project IDs), known-session gate for location-less `idle`, `seen/<event.id>` replay guard, VCS adapter (`.data` unwrap, `branch?.list ?? branches()` warn-only, `diff({mode:"working",context:3})`), sampled diagnostics (foreign/TUI noise dropped by default). Verify: `npx vitest run test/isolation.test.ts` → PASS. Commit: `feat: events + VCS adapter (P1-T8)`.

### Task 9: Install/verify surface + P0 manual parity

**Files:** `src/templates.ts`, `agents/memory-manager.md`, `README.md`, `CHANGELOG.md`, `test/scaffold.test.ts`

**Goal:** Shipped snippets and hand-owned protocol make P0 reproducible without code.

- [ ] Failing test: `test/scaffold.test.ts::emits_options_and_ask_snippets_and_protocol_block` → FAIL. Implement: scaffold six templates + `handoffs/`, emit commented options + `memory_write→ask` + AGENTS block (≤10 lines, narrow trigger, fence/quote heuristic + paste caveat, read/recall/write/nudge bullets); manager leading-deny frontmatter + proposal-only body; README install matrices (drop-in vs package, `.opencode/` vs root paths, merge order, `plugin list` verify, reload guidance) + uninstall (hand-remove AGENTS block, `git rm` memory explicitly, orphaned ledger harmless); CHANGELOG P1 + supported range. Verify: P0 walkthrough restores from INDEX + activeContext with no re-explaining; `npx vitest run test/scaffold.test.ts` → PASS. Commit: `docs: install surface + P0 parity (P1-T9)`.

### Task 10: Acceptance, evals, compatibility gate

**Files:** all `test/**`, `README.md`, `CHANGELOG.md`

**Goal:** Prove P1 acceptance and ship the deploy gate.

- [ ] Failing gate first: full suite red on at least one budget/containment/idempotency case → implement until green. Verify: `npx tsc --noEmit` → PASS; `npx vitest run` → PASS (budgets every write path, over-cap INDEX unattached, no INDEX duplication in brief, priors survive compaction with `result` untouched, secrets + `<private>` incl. unclosed blocked, recall traversal rejected via `toolResult`, apply one-assert-per-line with shipped `ask` rule installed so `assert` prompts, `HHmmss-<session6>` routing, foreign events dropped, single controller reused, rotation-once + nudge-≥5 + reset-via-`[]`, poison fixture containment, fence/quote rejection, untrusted bulk-approve exclusion); evals reported as three numbers (static ~13 / per-prompt with content / session-total per-prompt × model steps, hint throttled); `opencode plugin list` loads the published-form package; supported range recorded; deploy-time `event.type` log confirms `session.idle` + `compaction.ended` delivery; startup VCS shape check warn-only. Commit: `test: P1 acceptance + evals (P1-T10)`.

## Self-Review (done before saving)

1. Spec coverage: Tasks 1–10 map §§2,3,4,5.1,5.2,5.3,5.4,5.5,5.6,5.7,5.8,5.9,5.11,6,7,8(D-A/D-B retired G5),9,10 with no gap; deferred D-C/D-D explicitly out of scope.
2. Placeholder scan: `rg -n "TBD|TODO|fill in|appropriate handling|similar to Task" docs/2026-10-15-memory-plugin-implementation.md` → 0 hits (concrete file paths, test names, and `Run:` commands in every task).
3. Type consistency: `Notation`/`Contract` paxman shapes not applicable here; instead one `LedgerKey` shape (`<projectID>/<scope>/<id>`), one `Provenance` union (`user|tool|model|snapshot`), one `toolResult(text)→{content:text}` adapter, one `memory_write` assert shape — identical across Tasks 3–8.
4. Plan-review gate (dry): every task names files + failing test + verify command + commit; references carry paths:lines; QA blocks assertable. Verdict: OKAY.

---

Plan saved to `docs/2026-10-15-memory-plugin-implementation.md` — 10 tasks.

Execute task-by-task via `tdd` (failing test first). After impl, run `implementation-plan-review` on the plan file, then `oracle-review` on the branch diff before PR handoff.
