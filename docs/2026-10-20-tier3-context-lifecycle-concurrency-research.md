# Tier 3 research — context re-emission, forgetting, and cross-process writes

**Date:** 2026-10-20  
**Status:** research only. No source code changed. Repository state at research
time: `HEAD 1afbf4f`; this report is the only added file.  
**Scope:** E8 (per-model-call context re-emission), E13 (memory deletion/GC), E14
(cross-process write safety). FTS, TTL/decay, and the TUI remain out of scope
(D-C/D-D/D-G).

## 1. Executive summary

| Area    | What the evidence says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Recommended direction                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E8**  | Re-emission is **required** by OpenCode: the `context` hook receives a per-call request draft, and hook changes affect only that outgoing call. All four harnesses rely on stateless provider APIs and prefix caching; the stable part of memory is persisted once (or assembled at session start), and volatile context is kept at the tail. This plugin currently puts brief **and volatile status/hint** in `event.system`, before the entire message history, so a per-prompt hint or status change can invalidate the message-prefix cache. | Do **not** suppress the brief. Keep the stable brief in `event.system`; move per-prompt status/hint (and ideally the newest-handoff pointer) to the persisted `prompt` hook or a trailing request message. Measure provider cache reads/writes, not line counts. This is a spec/eval change before it is a code change.                                                                                    |
| **E13** | The harnesses split into four postures: user-managed plain files (Claude Code), generated state with provenance-aware consolidation and retention (Codex), feature removal (Cursor), and no built-in memory (DeepSeek). The Anthropic memory tool is app-mediated: the model requests operations, the application executes them. Only Codex has a mature automated lifecycle, and it is the most complex.                                                                                                                                        | Add a **user-invoked** forget/purge flow: dry-run, per-line approval, archive/tombstone with reason, update INDEX, and a git-history warning. Keep `memory_apply` append-only; the model may propose, not delete. Add **opt-in handoff GC** only for disposable `handoffs/` snapshots. Do not add automatic TTL for durable memory. This needs an ADR revision (US-22 is currently unimplemented).         |
| **E14** | DeepSeek uses a kernel write lease for session logs and a PID-record + claim-file lock plus atomic rename for file stores. Codex uses SQLite transactions, ownership tokens, leases, and heartbeats. Claude Code shares plain memory files across worktrees with no documented cross-process lock; Cursor removed shared memory entirely.                                                                                                                                                                                                        | Do not describe the current per-process mutex as cross-process safe. Choose either **(A)** an explicit single-writer contract with fail-fast detection, or **(B)** a zero-dependency PID lock with claim-file takeover plus atomic temp-file publish. **B** is recommended if two OpenCode host processes against one project are supported; **A** is the honest fallback. Either way, make writes atomic. |

The three decisions are coupled: memory changes invalidate cached prefixes (E8);
deletion must be a locked, atomic write (E13 + E14); and adding a lock must not
delay the interactive path (E14 + E8). The plugin's differentiator remains plain,
inspectable, git-backed files with explicit user control. Do not copy Codex's
opaque automatic-memory machinery to solve lifecycle problems.

## 2. Method and evidence quality

Primary sources:

- OpenCode V2 plugin documentation and the installed `@opencode/plugin@2.0.29`
  and `@opencode/ai` type definitions.
- Claude Code memory documentation (`code.claude.com/docs/en/memory`).
- OpenAI Codex memories documentation and the `openai/codex` repository
  (prompts, templates, state-store implementation).
- Cursor Rules documentation and a Cursor staff reply on the Cursor forum.
- DeepSeek Harness repository documentation and source notes.
- Anthropic memory-tool documentation.
- Provider prompt-caching documentation from OpenAI, Anthropic, and DeepSeek.

Inferences are labelled as such. The main inference that needs measurement is
the **actual cache impact** of the current `event.system` placement; the provider
semantics make the direction clear, but only a request-level measurement can
quantify it.

## 3. What each harness actually does

### 3.1 OpenAI Codex

**Injection.** Codex reads `AGENTS.md` before doing work and builds an instruction
chain **once per run** (in the TUI, once per launched session). It does not
rebuild it per model call. The memory read path is added to **developer
instructions**: a `memory_summary.md` capped at 2,500 tokens plus instructions to
query `MEMORY.md`, `rollout_summaries/`, and skills on demand. This is a stable
prefix, not a per-call re-injection.

**Storage and lifecycle.** Local memories are off by default. When enabled,
Codex generates them in the background from eligible prior chats and stores
them under `~/.codex/memories/` as **generated state**, not hand-edited source.
The pipeline has two phases:

- Phase 1 extracts per-thread raw memory and a rollout summary.
- Phase 2 consolidates them into `memory_summary.md`, `MEMORY.md`, skills, and
  rollout summaries.

The selection and retention constants are unusually concrete:

- stage-1 lease: 3,600 s; retry delay: 3,600 s; concurrency limit: 8;
- phase-2 lease: 3,600 s; heartbeat: 90 s; global cooldown: 6 h;
- `max_unused_days` default 30 (phase-2 eligibility and stale stage-1 pruning);
- `max_rollout_age_days` default 10;
- `min_rollout_idle_hours` default 6;
- extension resource retention: 14 days;
- selected phase-2 baseline rows are preserved when stale stage-1 rows are
  pruned.

**Forgetting.** Codex does not give the model a direct destructive memory tool.
When the user explicitly asks to remember, forget, or correct something, the
model appends a small **ad-hoc note** under `extensions/ad_hoc/notes/`.
Consolidation treats notes as authoritative _data_, never instructions, and
never deletes the note itself. Deletion of an input (for example, deleting a
thread) triggers consolidation only when that input was selected into the
phase-2 baseline. The consolidation prompt then removes only memory supported
by deleted inputs, preserving shared evidence. Global reset and per-thread
deletion are user controls, not model tools.

**Concurrency.** Codex avoids shared read-modify-write on files as the
correctness boundary: SQLite is authoritative, with `begin_immediate`
transactions, busy retry, per-job ownership tokens, leases, and heartbeats.
Generated files are a projection reconciled through a git baseline diff. This
is the strongest lifecycle/concurrency design in the set, and also the heaviest.

### 3.2 Anthropic Claude Code

**Injection.** `CLAUDE.md` is loaded at session start and delivered as a **user
message after the system prompt**, not as part of the system prompt. The docs are
explicit that this is why compliance is not guaranteed. Project-root
`CLAUDE.md` is re-read and re-injected after `/compact`; nested files and
path-scoped rules load on demand.

**Auto memory.** Auto memory is plain markdown under
`~/.claude/projects/<project>/memory/`, shared by all worktrees and
subdirectories of the same git repository. `MEMORY.md` is the index; its first
200 lines or 25 KB (whichever comes first) load at session start. Topic files
load on demand. Claude reads and writes the files during the session; a
frontmatter `modified` timestamp is recorded when applicable.

**Deletion/GC.** The supported control surface is `/memory`: the user can browse,
edit, or delete files at any time. Claude Code deletes old session transcripts
after `cleanupPeriodDays`, but **excludes memory files from that retention
sweep**. There is no documented automatic TTL for auto memory. The user or
Claude must edit/delete it.

**Concurrency.** The docs document sharing across worktrees but **do not
document a cross-process lock**. The files are ordinary markdown edited by the
agent. Inference: two live sessions can race on the same file, with
last-writer-wins or interleaved edits. A third-party issue report describes
corruption/anchoring after bad writes, but that is not proof of a concurrency
bug and is not treated as one here.

**E8 lean.** Stable context persists in the transcript as a user message; it is
not re-pushed as a system block on every model call. The re-injection after
compaction is the exception that proves the rule: persistent context must be
restored when compaction removes it.

### 3.3 Cursor

**Memories were removed.** A Cursor staff reply on the forum states: “The
Memories feature was intentionally removed starting from version 2.1.x.” The
same reply gives the migration: export memories to an `.mdc` file and add the
content to User or Project Rules. Current Rules documentation describes Rules,
not Memories, and says: “Large language models don't retain memory between
completions. Rules provide persistent, reusable context at the prompt level.”
Rules are included at the start of the model context; project rules live in
`.cursor/rules` and are version-controlled.

**What this means.** Cursor did not solve automatic-memory lifecycle; it removed
the feature and kept an explicit, editable, version-controlled instruction
layer. That is a legitimate design signal: if the product cannot make memory
lifecycle and control legible, a narrower explicit mechanism is better than an
opaque one.

**Concurrency.** There is no model-written shared memory to race on. Rules are
user-authored files read by the host. This avoids E14 rather than solving it.

### 3.4 DeepSeek Harness

**No built-in memory.** DSH is plugin-based and ships no memory server. Its
official guide offers three **default-off** reference MCP memory configurations.
DSH starts the configured MCP child and exposes its tools, but does not install,
initialize, choose a model, or supervise the server. The reference memory
server explicitly has no embeddings, automatic summarization, conflict
resolution, or forgetting policy. Lifecycle is delegated to a third party.

**Session model.** A session is an append-only log of typed events; the
model-visible message history is derived from the log, never stored separately.
The rendered system prompt is a **surface node** (node 0), part of derived
history, not part of the request header. When the prompt changes, the loop
either replaces the latest system node or appends a new in-history system node,
depending on the route's `systemPromptUpdate` mode. Every request is a pure
function of the log.

**Compaction and forgetting.** Compaction logs `compaction/start`,
`compaction/summary`, and `compaction/end`; the summary is a `user/message` with
a `replace` surface operation over the selected span. The original events stay
in the append-only log. This is **logical forgetting**: the model-visible
surface is reduced, but the record is retained and replayable. The compaction
lock is itself a log record, and an unmatched start is detected as an orphan.

**Concurrency.** The JSONL backend’s `SessionWriteLease` holds a kernel lock on
`session.lock` for the life of a write handle: POSIX `flock(2)` through a
prebuilt native binding, Windows a named kernel semaphore. The kernel releases
it on process death, so there is no TTL or stale-lock bookkeeping. A POSIX lock
names an inode, so acquisition verifies the inode at the lock path and retries
if it changed. Contention produces `SessionAlreadyOwnedError`. The design note
explicitly rejects TTL-record locks and `proper-lockfile` because takeover is a
“distributed algorithm in miniature” with residual dual-writer overlap.

For ordinary file-backed stores, DSH uses a zero-dependency `withFileLock`:
`<file>.lock` created with `wx`, containing `<pid>\n`; a contender that proves
the PID is gone creates a claim file, re-reads and re-probes, then removes the
stale lock and retries. Writes use a fresh-inode temp file and atomic rename.
The package deliberately does **not** call `fsync`; it guarantees atomic
visibility, not crash durability. Multi-host/NFS/container deployments are
documented as unsupported for the lock.

### 3.5 Anthropic memory tool (supporting reference)

The Claude API memory tool is **client-side**. Claude requests file operations
in a dedicated `/memories` directory (create, view, str_replace, insert,
delete, rename); the application executes them against storage it controls.
There is no built-in approval step. Official guidance tells the application to
restrict paths, cap file sizes and view output, and “periodically delete memory
files that haven't been accessed in a long time.” This is an app-owned lifecycle,
not a model-owned one, even though the model can request deletes.

## 4. E8 — per-model-call context re-emission

### 4.1 The OpenCode contract makes re-emission mandatory

The V2 plugin docs describe the `context` hook as modifying the **assembled
request** immediately before model dispatch:

> `context` runs for the agent loop, including tool-driven continuations.

and:

> Changes affect only the outgoing model call, not persisted history or
> configuration. A hook that should apply to every request must register for each
> kind.

The `prompt` hook is the only admission-time channel that becomes canonical
persisted user input:

> Edits become the canonical persisted user input.

The type definitions agree: `SessionContext` contains mutable `system:
Array<SystemPart>` and `messages: Array<Message>` for the request being built.
There is no “retained across calls” system overlay. If this plugin does not push
the brief on a tool continuation, the continuation has no brief.

**Conclusion:** suppression is not a viable optimization. Re-emission is the
contract. The real question is **where** the re-emitted content sits in the
request and whether it is stable enough to cache.

### 4.2 Provider caching is prefix-based, and system comes before messages

All three providers are stateless at the API boundary: each request re-sends the
full prompt. Caching reuses an unchanged prefix.

| Provider  | Cached unit                                                     | Ordering / invalidation                                                                                                                                                                                                      | Usage signal                                                    |
| --------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| OpenAI    | Exact rendered prefix, minimum 1,024 tokens for GPT-5.6+        | Tools, then developer/system, then messages. A change before a breakpoint prevents reuse after it. Docs: put stable instructions and shared reference material first; place dynamic content at the end or in later messages. | Cached-token fields in usage; cache reads ~0.1×, writes ~1.25×. |
| Anthropic | Prefix up to `cache_control`; automatic or explicit breakpoints | `tools` → `system` → `messages`. “Changes at each level invalidate that level and all subsequent levels.” 5-minute default TTL; 1-hour optional.                                                                             | `cache_creation_input_tokens` / `cache_read_input_tokens`.      |
| DeepSeek  | Persisted cache prefix unit; full-unit match required           | Prefix must fully match a persisted unit; a changed system prefix prevents a hit even if later text is identical. Best effort.                                                                                               | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.         |

The shared rule: **a change in system invalidates the message history that
follows it.** A change in a trailing message invalidates only from that message
onward.

### 4.3 What this plugin currently does

`src/index.ts` pushes, in order:

1. the brief (`briefLines`) from `loadBrief`;
2. the status line from `statusLine`;
3. the once-per-prompt hint from `matchIndex`;
4. (on compaction) priors.

The hint is throttled to once per prompt/session: it is present on the first
model call for a prompt and absent on tool-driven continuations. The status line
can change when counters/notices change. The brief includes a newest-handoff
pointer; a fire-and-forget snapshot in the same hook can create a new handoff,
so the next call’s brief can differ. Every one of those changes is in
`event.system`, before the messages.

**Inference (needs measurement):** on a tool-using turn, the first call may have
a hint and later calls do not; when that happens it is a guaranteed
system-prefix change, so the message-history cache cannot be reused for the
later calls on a prefix-caching provider. Status changes have the same effect.
The current 384-line session-total budget counts injected lines, not billed
tokens, and does not reveal this cost.

**Second issue: trust channel.** ADR-0007 treats memory as untrusted data.
Placing it in `event.system` gives it system-level authority, even with a
`[memory]` label. Claude Code deliberately delivers `CLAUDE.md` as a user
message after the system prompt; Codex uses developer instructions; Cursor rules
are user-authored and trusted. The plugin's label is a mitigation, not a
boundary. This is a reason to prefer a persisted user message or a trailing
request message for the volatile, untrusted notices.

### 4.4 What the harnesses lean toward

| Harness     | Stable context                                                           | Volatile context         | Re-emitted per call?                                        |
| ----------- | ------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------------------- |
| Claude Code | `CLAUDE.md` as a user message; auto-memory index at session start        | Tool results, user turns | No; persists in history, restored after compaction.         |
| Codex       | Instruction chain once per run; memory summary in developer instructions | Current turn/tool output | No; stable prefix.                                          |
| DeepSeek    | System prompt as a surface node; request pure function of log            | Tool results, new events | No plugin re-injection; surface updates only on change.     |
| Cursor      | Rules at the start of the model context                                  | Current completion input | Rules are assembled per completion, but as a stable prefix. |

The common pattern is **persist or assemble the stable part once; keep changing
content at the tail**. None of the harnesses re-push volatile system context on
every model call.

### 4.5 Better options

**Option E8-A (recommended): move volatile notices to prompt admission.**
Keep the brief in the `context` hook (it must survive tool continuations and
compaction). Move the status line, hint, and newest-handoff pointer to the
`prompt` hook, where they become part of the canonical persisted user input
(for example, a small `[memory]` data block, or an attached file). Then:

- the system prefix contains only the stable brief; it changes only when memory
  changes;
- per-prompt notices are at the tail, so prior history cache is preserved;
- the hint is visible in the transcript and does not need re-injection on every
  continuation;
- untrusted notices live in user data rather than system instructions;
- the spec's split (INDEX once per prompt, brief/status/hint per call) becomes
  coherent.

If a status notice must be delivered mid-turn (for example, a rotation or
capture-failure notice), a trailing `event.messages` block is the alternative;
validate provider role/alternation rules before choosing it. The handoff pointer
and hint are prompt-specific and fit the prompt hook better.

Costs/risks: the prompt hook runs once at admission; a mid-turn status change
will not be seen until the next prompt. The hint/status block becomes visible in
the transcript and may be summarized away by compaction, which is acceptable for
transient notices. The prompt hook must be validated to persist the block
without breaking user-visible text or attachment semantics. Implementation
note: `loadBrief` would stop owning the newest-handoff pointer; the prompt block
owns it instead.

**Option E8-B (fallback): freeze the bundle per prompt and repeat it
identically.** If moving channels is too risky, compute the brief/status/hint
once per prompt, store it in `ctx.storage` keyed by session/prompt, and push the
identical bundle on every call. This fixes within-turn cache churn (the hint no
longer disappears) but does not fix cross-prompt churn: a new status/hint still
changes system at the next prompt and invalidates history. It is a smaller
change but a smaller win.

**Option E8-C: do not suppress.** Suppressing the brief on continuations would
make memory disappear exactly when the model is doing tool work. It is a
regression, not an optimization.

**Measurement.** Run a two-prompt, multi-tool-turn eval against OpenAI,
Anthropic, and DeepSeek. Compare current placement vs E8-A. Record:

- input tokens, output tokens;
- cache read / cache write tokens (or hit/miss tokens);
- cache hit rate;
- injected line counts (the existing budget metric);
- recall success on a fixed question set.

Do not add production counters casually: ADR-0008 freezes a 45-name vocabulary
and requires an ADR revision to add names. A test-harness measurement is the
right first step.

### 4.6 E8 recommendation

1. **Do not implement suppression.** Re-emission is required.
2. **Approve a spike for E8-A** (status/hint/handoff pointer at prompt
   admission; stable brief in `context`). If the spike fails, fall back to E8-B.
3. **Measure cache reads/writes before changing the budget claims.** The
   README/spec line totals remain useful as injection guardrails, not as a
   proxy for billed cost.
4. **Revise spec §5.2/§9 and the acceptance test** if E8-A is adopted. If the
   trust channel changes, record the ADR-0007 rationale explicitly.

## 5. E13 — deletion, forgetting, and GC

### 5.1 Current state

- The only removal path is Known-Errors rotation from `activeContext.md` to
  `handoffs/archive/` (`src/files.ts`). Rotation is a write path, not a user
  forget flow.
- `memory_apply` is append-only (`src/tools.ts`). It cannot remove or replace a
  line.
- `decisions.md` is append-only; corrections are new entries.
- Handoffs accumulate without a GC. There is no count/age cap and no delete
  command. `handoffs/archive/` also grows.
- US-22 (forget/purge) has no implementation. The Tier 1 notes already flag
  that it needs an ADR revision.

### 5.2 What the harnesses lean toward

| Harness                   | Deletion/forget model                                                                                                                | Retention/GC                                                                                                                                                         | Control surface                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Codex**                 | Model appends an ad-hoc forget/correction **note**; consolidation applies it; notes are never deleted; deletion by input provenance. | Automated: 30-day unused eligibility, 14-day extension resources, 10-day rollout age, 6-hour idle gate; selected baseline preserved; per-thread delete/global reset. | User settings, `/memories`, delete/reset; model has no direct destructive memory tool.     |
| **Claude Code**           | Plain files; user edits/deletes via `/memory`; Claude reads and writes them during a session.                                        | No automatic memory TTL; memory files excluded from transcript cleanup.                                                                                              | `/memory`, direct file editing; deletion is documented as a user action, not a model tool. |
| **Cursor**                | Memories removed; Rules are explicit, version-controlled files.                                                                      | No memory GC problem; rules are user-maintained.                                                                                                                     | Editor/VCS.                                                                                |
| **DeepSeek**              | No built-in memory; third-party MCP server owns policy. Session compaction is logical surface replacement; the log retains history.  | Delegated; reference server has no forgetting policy.                                                                                                                | MCP server.                                                                                |
| **Anthropic memory tool** | Model requests create/delete/rename; the application executes.                                                                       | App-owned; official guidance recommends expiring unused files.                                                                                                       | Application handler; no built-in approval.                                                 |

The spectrum runs from **no feature** (Cursor) through **user-managed files**
(Claude Code), **app-mediated operations** (Anthropic tool), **generated state
with consolidation/retention** (Codex), to **delegation** (DeepSeek). The plugin
is closest to Claude Code plus ADR-0005 lineage. It should not jump to Codex's
level of automation without the matching state machinery.

### 5.3 Logical forgetting vs physical erasure

This distinction should be explicit in any ADR:

- **Logical forgetting:** remove content from active files and from every
  auto-injected surface; archive or tombstone it with provenance and reason; keep
  it recallable/auditable. Git retains history.
- **Physical erasure:** rewrite git history, remove backups/forks/CI caches, and
  possibly rotate secrets. The plugin cannot guarantee this and must not imply
  it can.

ADR-0005 already says removed entries leave active files for
`handoffs/archive/` but persist in git. US-22's “purge” should therefore be
defined as logical forgetting unless a separate, explicit erasure procedure is
documented. If a secret was written, the warning must say: deleting the working
tree copy is not enough; use `git filter-repo`/BFG and rotate the secret.

### 5.4 Recommended E13 design

**1. A user-invoked forget command, not a model delete tool.**

`/memory-forget` (name illustrative) should:

- accept a file/line/id/pattern selector, or a reviewed proposal list;
- run a **dry run** by default, showing every line, its `source:` provenance,
  and where it will go;
- require per-line approval for untrusted provenance (same posture as
  `memory_apply`, ADR-0007);
- archive removed lines with a reason, timestamp, and originating selector
  before removing them from the active file;
- update `INDEX.md` and emit one status notice;
- never rewrite a handoff or `decisions.md` in place;
- support `confirm` as a second step (like `/memory-metrics reset confirm`) so a
  single typo cannot delete memory.

**2. Per-file semantics.**

| File                                       | Forget behavior                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `activeContext.md`                         | Remove/rotate targeted lines or Known-Errors blocks to `handoffs/archive/` with a `forgotten` reason.                                 |
| `architecture.md`, `style.md`, `issues.md` | Review-gated rewrite; archive the removed diff/line set; update INDEX.                                                                |
| `decisions.md`                             | **Do not delete.** Append a superseding/retired entry with `supersedes[]`; exclude it from the injectable tail. The full log remains. |
| `INDEX.md`                                 | Remove pointers to forgotten content; respect the 30-line cap.                                                                        |
| `handoffs/`                                | Immutable; only the handoff GC may delete whole snapshots.                                                                            |
| `handoffs/archive/`                        | Retained lineage; purge only through a separate explicit erasure flow with a git warning.                                             |

**3. Model-initiated forgetting: defer or make it a proposal queue.**

Codex's ad-hoc notes are the best model for a model that “wants” to forget, but
they depend on a consolidation pipeline the plugin does not have. The
lower-cost version is: the model may append a `forget:` **intent note** through
the existing review/apply path; `/memory-forget` surfaces pending intents and
applies them only after human approval. Do not expose a `memory_delete` tool.
If this is not needed now, start user-only; it is the simpler and safer MVP.

**4. Handoff GC: opt-in and separate from forget.**

Handoffs are disposable episodic snapshots; they are not durable decisions.
Add `/memory-gc` (name illustrative) with:

- `--dry-run` by default;
- age and/or count policy (`older than N days`, `keep newest K`);
- scope limited to `handoffs/` root, never `handoffs/archive/`, `decisions.md`,
  or the six root files;
- a printed list and explicit confirmation;
- a warning when a handoff is untracked in git (deletion is then irreversible);
- default off; no automatic timer.

This solves unbounded snapshot growth without turning into age-based forgetting
of durable memory. It also preserves ADR-0005's “snapshots stay at root;
archive is retired durable lines” distinction.

**5. No automatic TTL/decay for durable memory.**

Age-based forgetting remains a US-23 opt-in phase-2 feature for unreachable
episodic notes only. Do not let the handoff GC become a backdoor TTL for
decisions or active context.

### 5.5 E13 recommendation and implications

- **Recommended:** user-invoked `/memory-forget` with dry-run, archive/tombstone,
  per-line approval, and git warning; **opt-in `/memory-gc`** for root handoffs;
  keep `memory_apply` append-only; defer model-initiated intent notes unless
  real demand appears.
- **ADR:** new ADR “Forget/purge and handoff GC” (or a formal revision of
  ADR-0005) defining logical vs physical erasure, per-file semantics, archive
  format, and the git caveat. US-22 then becomes implementable.
- **Spec:** add the forget/GC command surfaces; do not add a sixth config option
  (ADR-0006). Policies are command flags or fixed constants.
- **Security:** treat forget intents as untrusted data; no bulk approval of
  untrusted lines; no model tool that can delete without a human.

## 6. E14 — cross-process write safety

### 6.1 Current write paths and failure modes

- `withWriteLock` is a **module-level promise chain**. It serializes callers in
  one process only. Two OpenCode host processes can enter the same file body
  concurrently.
- `updateCapped` is a read-modify-write: both processes can read the same
  content and each write its own append, silently losing one. The comment
  “concurrent same-file batches cannot drop each other” is true only within one
  process; it should not be read as a cross-process guarantee.
- `writeRedactedCapped` writes directly with `writeFile`. A reader in another
  process can observe a truncated/partial file; a crash during the write can
  leave one. `writeNewCapped` uses `wx` to prevent same-name overwrite, but the
  content is still written in place, so a reader can see a partial handoff.
- Rotation writes the archive file and then the active file. A crash between the
  two can leave a duplicate or a lost block; there is no transaction.
- Metrics writes are best-effort by ADR-0008; the correctness ledger lives in
  `ctx.storage`, whose cross-process semantics are the host's, not this plugin's.
  This report scopes E14 to the markdown memory files.

### 6.2 What the harnesses lean toward

| Harness          | Shared mutable state                | Mechanism                                                                                                                                                          | Lesson                                                                                                             |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **DeepSeek**     | Session JSONL; per-file stores      | Kernel `flock`/named semaphore per write handle; PID lock + claim-file takeover + atomic rename for files; no TTL for the kernel lock; NFS/containers unsupported. | Real exclusion is possible without a daemon, but it costs native bindings or a carefully implemented PID protocol. |
| **Codex**        | SQLite + generated files            | `begin_immediate`, busy retry, ownership tokens, 1-hour leases, 90-second heartbeats, global singleton, transactional deletes.                                     | If shared state is complex, use a transactional store; files are a projection.                                     |
| **Claude Code**  | Plain memory files across worktrees | No documented cross-process lock.                                                                                                                                  | The cautionary case: shared files plus no lock means races are a product risk.                                     |
| **Cursor**       | Rules, not model-written memory     | Removed the shared mutable memory feature.                                                                                                                         | Avoiding shared writes is a valid architecture.                                                                    |
| **DeepSeek MCP** | Third-party server                  | The server owns concurrency.                                                                                                                                       | Delegation moves the problem, not solves it for the plugin.                                                        |

### 6.3 Options

| Option                                                 | What it buys                                                                                               | Cost / residual risk                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **A. Single-writer contract + fail-fast detection**    | Honest, simple; no silent lost updates if the second process is rejected.                                  | Users running two sessions get errors; needs a PID/heartbeat check and documentation.                     |
| **B. PID lock + claim-file takeover + atomic publish** | Cross-process exclusion for same-host cooperative processes; zero dependency; crash recovery by PID probe. | ~100 lines + tests; PID reuse, paused holders, NFS/containers unsupported; lock timeout.                  |
| **C. Kernel `flock`/native binding**                   | Strongest, kernel-released, no TTL.                                                                        | Native dependency/platform builds; conflicts with the zero-dependency/no-daemon posture; hard on Windows. |
| **D. Per-session partition + derived index**           | Removes shared RMW by design; excellent for ledger/metrics.                                                | Large redesign; memory files are inherently shared, so it does not map cleanly.                           |
| **E. SQLite/transactional store**                      | Strong transactions and leases.                                                                            | Contradicts ADR-0001 (markdown-only, no SQLite/daemon).                                                   |

### 6.4 Recommended E14 design

If two OpenCode host processes against the same project are supported, choose
**B**:

- One root-level lock (for example `.opencode/memory/.write.lock`) around all
  memory-file write bodies. A global lock avoids deadlocks in the
  archive+active rotation; writes are short. The lock file is not a memory file
  and must be ignored by the allowlist/readers.
- Acquire with `wx`, record `<pid>\n`, and use a bounded wait (2–5 s). On
  timeout, fail with a clear “another OpenCode process is writing memory”
  error; do not silently drop the write.
- If the record’s PID is gone (`process.kill(pid, 0)` → `ESRCH`), create a
  claim file with `wx`, re-read the lock, re-probe, remove only the same record,
  remove the claim, and retry. This mirrors DeepSeek’s `withFileLock` protocol.
- Release in `finally`; a crashed holder is recovered by the next writer.
- Publish with a same-directory temp file + atomic rename. For
  `writeNewCapped`, use temp + `link` (or an equivalent no-overwrite publish) so
  a reader never sees a partial handoff. Do not claim `fsync` durability unless
  you add it; atomic visibility is the target.
- Keep the in-process mutex; acquire it outside/inside the cross-process lock
  consistently to avoid inversion. All writes (`writeCapped`,
  `writeNewCapped`, `updateCapped`, rotation) must go through the same wrapper.
- Document the supported contract: same host, same PID namespace, local
  filesystem. NFS, containers sharing a volume, and multi-host use are
  unsupported, exactly as DeepSeek documents for its PID lock.

If the product instead declares **one OpenCode process per project**, choose
**A**:

- Keep the per-process mutex, add a startup/write-time detection of a second
  live writer, and fail fast with a clear message.
- Still make writes atomic (temp + rename), because crash/read partials are
  independent of concurrency.
- Document the limitation prominently; do not let the current comment imply
  cross-process safety.

Do **not** choose a TTL lock and call it safe. DeepSeek’s design note is
explicit that TTL + renewal + claim-by-rename is a distributed algorithm with
residual dual-writer overlap. If the plugin cannot take a native kernel lock,
the PID + claim protocol is the honest zero-dependency ceiling, and its limits
must be stated.

### 6.5 Test plan for E14

- Two child processes append to `decisions.md` / `activeContext.md`; assert no
  lost lines and a consistent final file.
- SIGKILL a lock holder; assert the next writer takes over after the PID probe.
- Two contenders race to take over the same stale lock; assert one wins and the
  other waits/retries without deleting the winner’s lock.
- Lock timeout produces a clear error, not a silent no-op.
- A reader polling during a write never sees a partial file.
- Rotation crash between archive and active write is either recovered or
  detected; add a test seam for the intermediate state.
- Windows: `wx`/EPERM behavior, `process.kill(pid, 0)`, rename replacement.
- Symlink/traversal: the lock/temp files must not widen the allowlist or follow
  a symlink outside the root.

## 7. Cross-cutting conclusions

1. **Re-emission is not the problem; placement is.** The brief must be
   re-emitted. Volatile status/hint should not sit in the system prefix before
   the entire conversation. The harnesses consistently persist stable context
   and keep changing content at the tail.
2. **Plain files buy inspectability at the cost of lifecycle and concurrency.**
   Codex pays for generated-state safety with SQLite/leases; Cursor avoided the
   cost by removing the feature; Claude Code accepts user-managed files. This
   plugin should stay in the Claude Code camp but add explicit, user-invoked
   lifecycle operations and (if multi-process is supported) a real writer lock.
3. **Deletion must be logical first.** Git-backed markdown cannot guarantee
   physical erasure. Define “forget” as removal from active/injected surfaces
   with archive lineage, and treat physical purge as a separate, warned
   operation.
4. **Do not let the model delete memory directly.** Codex’s note queue and
   Anthropic’s app-mediated tool both keep a human/application boundary. The
   plugin’s `memory_apply` per-line approval is the right pattern; extend it to
   a user-invoked forget flow, not a `memory_delete` tool.
5. **No new config options.** ADR-0006’s five-option cap stands. Forget/GC
   policies are command flags or fixed constants; lock timeouts are constants.
6. **Measure before claiming savings.** Line-count budgets are guardrails;
   provider cache read/write tokens are the cost signal.

## 8. Proposed next steps (decision menu)

**E8**

- [ ] Approve a cache-placement spike (E8-A: status/hint/handoff pointer at
      prompt admission; stable brief in `context`), or choose E8-B (freeze per
      prompt).
- [ ] Run the multi-provider cache measurement; record input/output and cache
      read/write tokens.
- [ ] If E8-A is adopted, revise spec §5.2/§9, the P9/INDEX injection split, and
      the acceptance budget; record the trust-channel rationale.
- [ ] Do not implement suppression.

**E13**

- [ ] Decide whether model-initiated forget proposals are in scope now, or
      user-only forget is enough.
- [ ] Draft the forget/purge ADR: logical vs physical erasure, per-file
      semantics, archive format, git warning, handoff GC scope.
- [ ] Specify `/memory-forget` and `/memory-gc` dry-run/confirm behavior; no
      sixth config option.
- [ ] Keep `memory_apply` append-only.

**E14**

- [ ] Choose the supported-concurrency contract: **B** (same-host multi-process
      PID lock) or **A** (single-writer, fail-fast).
- [ ] Draft the cross-process write-safety ADR, including NFS/container limits
      and lock-file location.
- [ ] Require atomic temp+rename publish regardless of A/B.
- [ ] Add the two-process, SIGKILL, stale-lock, timeout, Windows, and
      partial-read tests.

No implementation should start until the E14 contract and the E13 scope are
chosen; E8 can proceed as a measurement spike in parallel.

## 9. Sources

Primary:

- OpenCode plugin documentation, hooks/model requests:
  <https://opencode.ai/docs/plugins>; installed types
  `@opencode/plugin@2.0.29` (`promise/session.d.ts`, `promise/plugin.d.ts`) and
  `@opencode/ai` (`schema/messages.d.ts`).
- Claude Code memory documentation:
  <https://code.claude.com/docs/en/memory> (CLAUDE.md as a user message after the
  system prompt; auto-memory storage, 200-line/25-KB index, `/memory`,
  transcript-retention exclusion, post-compaction reload).
- OpenAI Codex memories:
  <https://learn.chatgpt.com/docs/customization/memories> (off by default,
  background generation, local store, `/memories`, generated-state guidance,
  reset).
- OpenAI Codex AGENTS.md:
  <https://learn.chatgpt.com/docs/agent-configuration/agents-md> (instruction
  chain built once per run; 32 KiB default).
- OpenAI Codex source:
  <https://github.com/openai/codex> — `codex-rs/memories/README.md`,
  `codex-rs/ext/memories/src/prompts.rs`, `codex-rs/memories/write/src/lib.rs`,
  `codex-rs/memories/write/src/extensions/*`,
  `codex-rs/state/src/runtime/memories.rs`,
  `codex-rs/config/src/types.rs`.
- Cursor Rules: <https://cursor.com/docs/rules>; Cursor 2.1 Memories removal
  staff reply: <https://forum.cursor.com/t/are-my-memories-gone/144057>.
- DeepSeek Harness:
  <https://github.com/deepseek-ai/deepseek-harness> — `docs/subsystems/session.md`,
  `docs/subsystems/persistence.md`, `docs/subsystems/compaction.md`,
  `docs/user/guide/mcp-memory.md`,
  `packages/session/session-persistence-jsonl/src/lease.ts`,
  `packages/util/atomic-write/README.md`, and the cross-process write-lease /
  lock-takeover notes.
- Anthropic memory tool:
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
  (client-side execution, `/memories`, delete/rename, path/size/expiration
  guidance).
- Provider caching:
  <https://developers.openai.com/api/docs/guides/prompt-caching>,
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>,
  <https://api-docs.deepseek.com/guides/kv_cache>.

Secondary / contextual:

- The Cursor removal is also discussed in third-party articles; this report
  relies on the Cursor staff reply and current Rules docs, not those articles.
- The Claude Code concurrency statement is an inference from the documented
  shared directory and ordinary file writes; Anthropic does not document a
  cross-process lock. A third-party issue report about corrupted/anchored
  `MEMORY.md` is not used as proof of a concurrency defect.
- The cache-impact statement about the current `event.system` placement is an
  inference from provider prefix semantics and the hook code; the measurement
  spike is required to quantify it.
