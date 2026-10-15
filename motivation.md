# No-Fuss Memory Plugin for OpenCode V2 — Synthesized Report

**Status:** validated against the live OpenCode V2 docs on 2026-10-15 (plugins, build/plugins, instructions, config). Research claims below are self-contained (prior source papers since removed; their content is folded into this report). V1 plugin claims cite repo READMEs and issue numbers fetched same day.

**Precedence:** ADRs are normative on decision intent. `docs/design-spec-v2-production.md` is normative on V2 contracts and implementation and supersedes this report on any V2-contract conflict. The background synthesis here is evidence, not API truth. **§4.6 is a superseded, non-normative sketch** kept only for the record; the authoritative implementation skeleton is `design-spec-v2-production.md` §§2–5.

**Goal:** a memory plugin for *all* developers that is local-first, zero-subscription, zero-daemon, zero-embeddings by default — and remembers exactly the basics: project background, agent context, architectural decisions, last refactors, planned GitHub issues, and personal style (no tech-debt compounding, architecture-style lock across model swaps, contract-first implementation).

**Non-goals:** remember-everything transcript capture, vector/semantic search, cloud sync/team server, knowledge graphs, background LLM dreaming. All deferred or rejected with reasons.

## 1. Evidence base

- Prior research inputs (source papers since removed; key content folded into this report): (a) harness algebra, Memory-Bank comparison, context-rot/SNR analysis, minimalist markdown recipe, access-weighted decay, blueprint config; (b) storage comparison (file/SQLite/vector/hybrid), RAG retrieval, ADD/UPDATE/DELETE/NOOP consolidation, 28–30d TTL, privacy/governance, per-project scoping, MVP roadmap.
- V1 field evidence: `tickernelz/opencode-mem` (1.7k stars, local Turso vectors), `supermemoryai/opencode-supermemory` (1.6k stars, cloud), `@mem0/opencode-plugin` (cloud), `@vectorize-io/opencode-hindsight` (server, now superseded), plus issue trackers and the `AGENTS.md`-as-memory community practice.
- V2 ground truth: `https://opencode.ai/v2/docs/plugins/`, `https://opencode.ai/v2/docs/build/plugins/`, `https://opencode.ai/v2/docs/instructions/`, `https://opencode.ai/v2/docs/config/`.

## 2. Claim validation (research vs. V2 reality)

| # | Claim | Verdict | V2-correct form |
|---|-------|---------|-----------------|
| 1 | Proposed hooks (`onSessionStart`, `onToolPostExecute`, `onSessionEnd`) | **Wrong names.** No such exports exist. | V2 uses `Plugin.define({ id, setup(ctx) })` with `ctx.session.hook("prompt" \| "context" \| "compaction" \| "generate" \| "title")`, `ctx.event.subscribe()` for the public event stream, `ctx.tool.transform`, `ctx.tool.hook`, `ctx.command.transform`. Passive capture = `ctx.tool.hook("execute.after")` for failures + the event stream; injection = `context` hook (`event.system.push`); compaction survival = `compaction` hook pushing priors only (**never set `event.result`** — the hook runs before the summary model call, so setting it skips the native summary). |
| 2 | Early blueprint injects memory via `"instructions": ["…/INDEX.md", "…/activeContext.md"]` | **Superseded — V2 now resolves `instructions`.** | V2 resolves `instructions` (relative/glob paths, `~/`, absolute, `http(s)`), loading it after `AGENTS.md`. This design nonetheless routes memory through `AGENTS.md` + the `prompt`/`context` hooks (one injection owner, budget-capped, no client config edit) — a deliberate choice, not a platform limitation. (An earlier revision quoted a V2 doc line saying instructions were not yet added to the model; that line no longer matches the V2 instructions page.) |
| 3 | Claim: AGENTS.md edits live-reload into the active prompt | **Half-true.** | True for global/upward files: V2 detects the change and adds an instruction update before the next model request. False for already-loaded *nested* (below-workspace, lazily discovered) files: "Edits to a nested file are not detected automatically after it loads. Start a new session." Design must keep auto-written memory out of nested files the session already loaded, or accept new-session pickup. |
| 4 | Blueprint config (`agents` plural, `system`, `permissions: [{action, resource, effect}]`, `default_agent`, `references`) | **Correct on V2** (an earlier v1-based objection was wrong). | V2 config docs confirm `agents`, `system`, ordered `permissions` array, `default_agent`, `references` with `path`/`repository`/`description`/`hidden`. Keep this shape; fix only the `instructions` entry (drop it) and add `plugins` registration. The plugin registers **no** `references` entry: references attach *directories* and are client-initiated, and `.opencode/memory` is in-project (ADR-0006). |
| 5 | Proposed plugin key `plugin: [...]` / package declarations | **V1 spelling.** | V2 key is **`plugins`** (plural). Supports packages with versions/tags/ranges, Git specs, local dirs/files, and `{package, options}` objects. `.opencode/plugins/` auto-discovers direct `.ts`/`.js` files and immediate package dirs. Arrays merge across global → project → `.opencode` configs instead of replacing. |
| 6 | Surveyed example plugin (`session.created`, `session.idle`, `tool:` key) | **V1 API; needs migration.** | Rewrite as `Plugin.define` + `ctx.event.subscribe` (capture) + `ctx.tool.transform(editor.add(…))` (tools) + `ctx.session.hook("compaction")`. Do not copy the snippet as-is. |
| 7 | Surveyed default: SQLite + FTS + embeddings, RAG top-k + RRF, LLM ADD/UPDATE/DELETE/NOOP | **Valid engineering, rejected for MVP.** | V1 evidence (below) shows embeddings bring model downloads (100MB–2GB), RAM, re-embed migrations, lock files, single-session-on-Windows, no-Intel-Mac, plus per-token API cost. The adopted vector-failure analysis (exact binding vs. semantic closeness, chunking breaks scope, index drift; see §4.8) agrees. No-fuss default = markdown only, INDEX-first lazy read, no embeddings. |
| 8 | TTL 30d + budgets vs. access-weighted decay $W_m(t) = W_0 e^{-\lambda(t-t_{\text{last}})}(1+\alpha C_{\text{access}})$, threshold $W_{\min}$ | **Both recorded; budgets win for MVP.** | Deterministic line/token caps + explicit `/memory-review` promotion beat time-decay for inspectability. The decay formula is preserved above as the phase-2 option, not the default. |
| 9 | OpenCode has no native cross-session LTM; SQLite is session-scoped | **Confirmed.** | This is the gap the plugin fills. `ctx.storage` (durable JSON scoped to the plugin; `get`/`set`/`remove`/**`scan`**) exists, but memory itself stays in git-backed markdown so humans can read, edit, and revert it. |

## 3. V1 lessons that shape this design

- **Cloud fatigue is real.** Supermemory/Mem0/Hindsight all need API keys, servers, containers, SDK versions. Your stance (simple > robust-with-subscription) is the design constraint: no accounts, no keys, no daemon, no server in the default path.
- **Vectors create support load.** `opencode-mem` documents embedding-model choice, dimension/pooling/prefix alignment, re-embed swaps with `.bak` files and locks, `multiprocess_wal` limits, platform exclusions. Users counter-propose exactly your ask: Obsidian/markdown-vault backend with the vault as source of truth (`tickernelz/opencode-mem#330`).
- **Auto-capture must be idempotent.** `supermemoryai/opencode-supermemory#106` (same `customId` re-POSTed after a timeout → one fact stored 55×) mandates a capture ledger + check-before-write + short retry window. This report adopts all three.
- **Never reimplement compaction.** `#69` (custom trigger overflows the smaller compaction model, session stuck on compaction model, `threshold: 0` can't disable, races native `compaction.auto`) plus `#85`/`#88` (premature compaction from model-limit fallback) → use V2's `compaction` hook only to inject priors (`event.system.push`), and **never set `event.result`** (that skips the native summary). The produced summary is captured post-compaction from the public `session.compaction.*` events when available. No custom trigger, no synthetic Continue, no model override.
- **Config sprawl kills adoption.** `#91`/`#97`/`#104` (ignored config file, stale README, per-location tool conflicts) → this plugin has ≤5 options, one config file, and emits a commented options snippet on first run (it never edits `opencode.jsonc`).
- **Opaque stores get abandoned.** Hash-keyed shards/containers orphan on repo moves (`migrate`/`list-shards`/`export`/`import` ceremony) → markdown files at stable paths, directory-driven identity, no hashes.

## 4. Synthesis: the no-fuss architecture

**One sentence:** git-backed markdown as the source of truth, passive zero-LLM hooks with hard budgets, injection via `prompt` hook (`INDEX.md` content) + `context` hook (brief + one status line + hint) with protocol + links in root `AGENTS.md`, survival through the `compaction` hook, curation by an explicit command — no embeddings, no server, no keys.

```
AGENTS.md (repo root)         # hand-owned, tiny, durable (protocol + links; never auto-written, never content)
.opencode/
├── opencode.jsonc             # location: .opencode/opencode.jsonc → plugins: ["./plugins/memory"]; if repo-root opencode.jsonc → ["./.opencode/plugins/memory"]; plus agents: { memory-manager }; ≤5 plugin options; no references entry (ADR-0006)
├── agents/
│   └── memory-manager.md      # read-only subagent (on-demand only; no edit, no shell, no webfetch/websearch, no skill — proposes, never writes)
├── plugins/
│   └── memory/
│       └── index.ts           # Plugin.define: prompt/context/compaction hooks, tools, commands
└── memory/                    # six files + handoffs/ (normative list; see c4-05-data-model.md)
    ├── INDEX.md               # ≤30 lines: map to the other five files
    ├── activeContext.md       # current slice: goal, pending, next, known-errors (append-until-60, then rotate; see §4.3-7)
    ├── decisions.md           # date | decision | why | rejected alternative (append-only; §4.4, ADR-0005)
    ├── architecture.md        # contracts + sibling implementations + style-lock pointer (review-gated rewrite, never auto-written; rule text lives in style.md)
    ├── style.md               # enforceable behavior rules, sole owner of rule text (review-gated rewrite, never auto-written)
    ├── issues.md              # one line each: todo/doing/done + issue ref (manual + /memory-review-validated; see c4-04)
    └── handoffs/              # session snapshots: handoffs/YYYY-MM-DD-HHmm.md (immutable, newest wins); handoffs/archive/ for retired durable lines (see §4.3-7, §4.4)
```

The memory directory is fixed at `.opencode/memory` (ADR-0006): the `readCapped`/`writeCapped` choke point and the recall allowlist depend on a stable root, and a static agent-permission glob cannot track a configurable path, so it is intentionally not configurable. Since ADR-0007 the `memory-manager` is read-only (no `edit`, no `shell`), so the fixed root is no longer an `edit`-scoping argument — it is a read-path and allowlist guarantee.

### 4.1 What is remembered (and what is not)

| Remember (small, durable) | Never store by default |
|---|---|
| Project background (10 lines) | Full transcripts, tool outputs, diffs |
| Decisions + why + rejected options | Every command/build log (failures only, truncated) |
| Architecture: contracts, siblings to study, style-lock pointer (rule text in `style.md`) | Embeddings, vectors, derived indexes |
| Last refactor: what moved, what remains | Secrets/`.env`/keys (blocklist + `<private>` redaction) |
| Planned GitHub issues: one line each (todo/doing/done) | Cross-project facts (strict per-project scope) |
| Style: tech-debt stance, contract-first rule, ripple checklist | Anything requiring a network call |

### 4.2 Budgets (anti-bloat, anti-context-rot)

- `INDEX.md` ≤ 30 lines on disk; `activeContext/architecture/style/issues` ≤ 60 lines on disk; `decisions.md` unbounded on disk with ≤60-line injectable tail (full log + git retains everything); handoffs per-file ≤60 lines; auto-inject payload = `INDEX ≤30 + brief ≤48 + status ≤1 + hint ≤1` where `INDEX` attaches **once per prompt** and the brief/hint/status re-emit **per model call** (the `context` hook runs on every model call), so session-total = per-prompt × model steps; the hint is throttled to once per prompt/session. Static overhead (excluded above) is the root `AGENTS.md` directive ~10 lines + tool description ~3 lines.
- Capture: failures only (built from the documented failure payload — message-only baseline, optional recall-only body), session boundaries, explicit `remember` keyword. No per-turn LLM extraction.
- Scratchpad (`activeContext.md`) is append-until-60 during work, then rotates: oldest Known-Errors block moves to `handoffs/archive/` and the rotation is announced once via the `[memory]` status line (model-facing — the agent relays it). Promotion into the capped rule files (`architecture.md`/`style.md`/`issues.md`) happens only via `/memory-review`, human-approved; the `memory-manager` subagent only *proposes* (it is read-only). The one exception is a `source:user` directive, which the plugin appends to the append-only `decisions.md` from the `prompt` hook (§4.3-1, ADR-0004). A second status line nudges review when uncurated captures reach ≥5, so uncurated memory is surfaced rather than degrading quietly.
- Root `AGENTS.md` stays tiny: it states the protocol and *links* memory; it never contains memory content itself. The `prompt` hook is the sole injector of `INDEX.md` content (deduped — skip if already attached; see §4.3-1/4). This directly answers the bloat fear: injection surface is bounded even as history grows.
- The write caps are enforced on write (`writeCapped`). A file attachment cannot be truncated, so an over-cap `INDEX.md` (e.g. hand-edited) is simply **not attached**; `/memory-review` reports the violation instead.

### 4.3 File lifecycle: scratchpad → durable → archived

Three states. Scratchpad is written automatically; `source:user` directives write `decisions.md` directly; all other durable writes require human approval; archived is git history, never deleted.

- **0. Init (once).** Plugin creates the directory + templates and emits a commented options snippet. Root `AGENTS.md` (hand-owned, never auto-written) carries protocol + links only, never file content. Nothing injects beyond `INDEX.md` until content exists.
- **1. Capture (automatic, zero-LLM, provenance-tagged).** `prompt` hook is the sole injector of `INDEX.md` content: attach (capped) to the current prompt only, retry-safe per V2 contract, and skip if an `INDEX.md` attachment is already present (dedup guard — root `AGENTS.md` never carries content, so no double injection). `ctx.tool.hook("execute.after")` (`event.status === "error"`) appends *failed* shell/build/test output to `activeContext.md` under Known Errors as a `source:tool` **summary line + optional recall-only detail block**; the documented failure payload is message-only (G4), so the summary line is derived from `event.error.message` and no body is assumed. Successes are ignored, and only the summary line is ever injected. Each real write increments `curation.pending`, and a rotation sets the `curation.rotated` marker for the status line. An explicit `remember` in the user's own message (documented form, outside code fences/quotes/pasted blocks) is classified `source:user` and appended straight to `decisions.md` by the plugin in the `prompt` hook (serialized, never-throw); anything ambiguous or of tool/model origin takes the scratchpad path, flagged for review.
- **2. Deduplication.** Every capture passes a persisted ledger (`ctx.storage` — never an in-memory `Set` alone): check-before-write on content ID, persist attempt state, retry only inside a ~30s window. Restarts and session-end replays are no-ops. Direct fix for supermemory #106 (same batch re-POSTed → one fact stored 55×). A real write increments `curation.pending`; a rotation sets `curation.rotated`; `/memory-review` resets both.
- **3. Idle snapshots vs session end.** `session.idle` may fire N times per session; it is not session end. Handler is content-hash-guarded: compute hash of (branch + `ctx.vcs.status()` + pending); if unchanged since this session's last snapshot (hash stored in ledger), no-op; else write immutable `handoffs/YYYY-MM-DD-HHmm.md`: branch (via `ctx.vcs.status()`), open changes, completed vs. pending, next steps. Newest timestamped snapshot is the single source for "where did we leave off". "Idempotent per session" means same content → no new file. **P1 gate:** the exact event name is not enumerable from the docs (the V2 compaction docs do confirm `session.compaction.*`); confirm `session.idle` via a runtime `event.type` log. Fallback if absent: an async, fire-and-forget, serialized, hash-guarded writer in the `context` hook (≤ once per `snapshotThrottleMinutes` per session; writes serialized against concurrent `context` invocations; events filtered to this location).
- **4. Next session start.** `prompt` hook attaches `INDEX.md` (capped, deduped) at the top; `context` hook pushes the active brief at the bottom (`event.system.push`), plus one `[memory]` status line (rotation notice / review-due nudge) and, on an exact INDEX match, the hint line. Root `AGENTS.md` contributes only the standing directive + links, never content. Anything deeper is lazy via `memory_recall` (one capped file per question). The brief does **not** repeat the INDEX map, and Known Errors appear as summary lines only.
- **5. Promotion (only path to durable, provenance-gated).** `/memory-review` **writes nothing** — it returns a proposal table: target file, exact candidate line, `source:`, advisory injection flags, cap/redaction checks. The human approves specific lines through the `memory_apply` tool (one `ctx.permission.assert` per candidate; candidates not tagged `source:user` cannot be bulk-approved); application is deterministic via `writeCapped`. The review is **not** sandboxed: a plugin command cannot target a subagent, and a session permission lock is time-scoped (the reviewed text persists in the transcript, so it would defer the threat, not contain it) — containment is that the review only proposes and every write is per-line approved. The optional read-only `memory-manager` subagent confines the pass to a child session when used. On completion it resets `curation.pending` to 0 and clears the rotation marker, so the status line stops nudging. `issues.md` also accepts direct manual edits (one line per issue) but `/memory-review` validates format/caps/redaction. No per-turn LLM extraction, no silent durable rewrites.
- **6. Compaction survival.** `compaction` hook injects capped + redacted priors via `event.system.push`. It **never sets `event.result`**: the hook runs *before* the summary model call, so setting `event.result` skips the native summary entirely. The produced summary is captured post-compaction from the public `session.compaction.*` event family when the payload carries it; otherwise a pointer-only handoff (timestamp + branch + "compaction occurred") is written, since the pre-compaction state is already on disk. No custom threshold, no synthetic Continue, no model override (the #69/#85/#88 failure set).
- **7. Aging.** Budgets enforced per enforcement point (§4.2, `c4-05-data-model.md`): `INDEX.md` ≤30 lines on disk; `activeContext/architecture/style/issues` ≤60 lines on disk; `decisions.md` unbounded on disk with ≤60-line injectable tail; handoffs per-file ≤60 lines; auto-inject payload `INDEX ≤30 + brief ≤48 + status ≤1 + hint ≤1` (INDEX once per prompt; brief/status/hint per model call, hint throttled); content overflow (retired durable lines, rotated scratchpad blocks) goes to `handoffs/archive/`, never into the prompt, and the rotation is announced once via the `[memory]` status line (model-facing — the agent relays it). Session snapshots go to `handoffs/` root. Phase-2 only: 30d TTL sweep or the recorded access-weighted decay ($W_m(t)$, $W_{\min}$) as an explicit command — off by default; applies only to unreachable episodic notes, never to reachable decisions (ADR-0005). `forget`/purge removes from active files; git retains history (restore = checkout).
- **8. Invalidation.** Edited global/upward `AGENTS.md` applies before the next model request (V2 guarantee). Edited *already-loaded nested* files do not — which is why auto-written memory lives in `.opencode/memory/`, never in nested `AGENTS.md` files.

### 4.4 Long-past memory: the causal chain (why `d`/`e`, not the old names)

Code shows the present (`d`, `e`). It cannot show *why not the old name*, or that `a → b → c → split into d,e` happened. That lives in **`decisions.md` as an append-only causal chain with supersede links** — never rewritten, only appended:

```md
**2024-03-02 — Enum `Status` uses `Active/Suspended`, not `On/Off`**
- Status: superseded by 2025-06-11
- Touches: `src/billing/status.ts` (now `src/billing/state.ts`)
- Decision: name values after lifecycle states, not booleans.
- Why: `On/Off` broke when trial-grace appeared; support confused "off" with "deleted".
- Rejected: `On/Off/Hold` — "hold" overlapped "suspended" in refunds.
- Supersedes: 2024-01-18 (initial `On/Off` naming)
```

Retention = **reachability from today**, not age. `d`/`e` entries are active (always retainable; "60 lines active" in `c4-05-data-model.md` means the injectable suffix — the last ≤60 lines — while the full append-only log plus git retains everything). `c` is retained as *causal* (one hop behind `d`/`e` via the supersede link — not injected by default, but followed on demand). `b` is retained only if still referenced, else compacted to one INDEX line. `a` leaves active files for `handoffs/archive/` (retired durable lines; still in git, still greppable, never injected). Session snapshots live at `handoffs/` root (`handoffs/YYYY-MM-DD-HHmm.md`, immutable, newest wins) — distinct from `handoffs/archive/`. Reachable decisions are structurally exempt from decay; age-based forgetting applies only to unreachable episodic notes. Lookup is exact-match grep on the symbol + link-walk (`d/e → c → b`), two capped reads then stop — no embeddings needed.

### 4.5 The tell-tale: how the agent knows to peek (without bloat)

Long-past content is never auto-injected. What is always injected is a pointer system — "could be there", resolved per turn by the main model pass (the Codex-like behavior):

- **Standing directive (~10 lines, via root `AGENTS.md`, constant cost):** before why/history/naming questions, or before touching a contract file, scan `INDEX.md`; on a symbol/file/area match, call `memory_recall`; otherwise proceed. Never inject whole history files.
- **Tool description as retrieval policy** (`memory_recall`): "Past decisions, renames, rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone." The pull decision rides the main inference pass — no per-turn classifier, no extra latency.
- **Deterministic hint line (zero-LLM, exact INDEX match only):** when the prompt or touched files mention a symbol listed in `INDEX.md`, the `context` hook appends one line: `[memory-hint] Past decisions mention \`BillingState\` (renamed twice, split 2026-02-09). Call memory_recall("decisions.md") for the why.` No match → no line.

| Signal | Size | Present |
|---|---|---|
| Directive | ~10 lines | every session |
| Tool description | ~3 lines | every turn (tool list) |
| Status line | 1 line | only on rotation or review-due (≥5 uncurated) |
| Hint line | 1 line | only on exact INDEX match |
| Full decision text | capped file | only after the model peeks |
| INDEX attach | ≤30 lines | once per prompt (deduped) |
| Brief (`context` hook) | ≤48 lines | every session with content |
| Captured failure bodies | optional, ≤20 lines on disk | **never** auto-injected (recall-only; the documented failure payload is message-only — G4) |

**Nothing raw is auto-injected.** Captured command output is untrusted data: the brief carries a one-line summary per known error and any captured body is `memory_recall`-only. Memory content is treated as data, never instructions — no component executes, fetches, or obeys text read from memory, the review writes nothing, and every durable write is approved per line (ADR-0007).

### 4.6 Minimal V2 skeleton (SUPERSEDED — non-normative)

> **Do not copy this sketch.** It is retained only to show the shape the design started from. The
> authoritative, V2-verified implementation is `design-spec-v2-production.md` §§2–5; the corrected
> behaviour in this section's prose (§§4.2–4.3) supersedes the code below on any conflict. Notable
> deltas from this sketch: location comes from `ctx.location` (not `ctx.project`), the ledger uses
> `scan` and content-ID keys, failures are captured by the tool hook (not the event stream), the
> `compaction` hook only pushes priors and never touches `event.result`, `memory_recall` returns the
> documented tool-**executor** envelope (`{ content }`, via one `toolResult` adapter — `Tool.TextContent`
> is the persisted message shape, not the executor shape), the prompt hook checks the write cap before
> attaching, and every `Registration` is disposed on unload. Security deltas (ADR-0007): the
> `memory-manager` subagent is **fully read-only** (the sketch below still shows a scoped `edit`), the
> review is **proposal-only and deliberately not sandboxed** — a command cannot target a subagent, and a
> session permission lock is time-scoped (it would defer, not contain, the threat) and would deny the
> user's own tools; containment is that the review writes nothing and every durable write is per-line
> approved. Captured failure **bodies are never auto-injected** (summary
> line only, message-only baseline), entries carry a `source:` provenance tag, approved lines are
> written only through `memory_apply` (one permission check per line), and a `source:user` directive is
> appended to `decisions.md` by the plugin in the `prompt` hook without a review cycle.

```ts
import { Plugin } from "@opencode/plugin"

// Authoritative version: design-spec-v2-production.md §5. Sketch only.
export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    const registrations: { dispose(): unknown }[] = []
    const controller = new AbortController()
    const root = (ctx.location.project?.canonical ?? ctx.location.directory).replace(/\/+$/, "")

    registrations.push(await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_recall",
        description: "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone.",
        input: { type: "object", properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false },
        execute: async (input) => ({ type: "text", text: readCapped((input as { file: string }).file) }),
      })
    }))

    registrations.push(await ctx.session.hook("prompt", (event) => {
      event.prompt.files ??= []
      const abs = `${root}/.opencode/memory/INDEX.md`
      const already = event.prompt.files.some((f) => typeof f.uri === "string" && f.uri.endsWith(".opencode/memory/INDEX.md"))
      if (!already && indexWithinCap(abs)) event.prompt.files.push({ uri: `file://${abs}` })
    }))

    registrations.push(await ctx.session.hook("context", (event) => {
      const brief = loadBrief()
      if (brief) event.system.push({ type: "text", text: brief })
      const status = statusLine() // rotation notice / review-due nudge (≤1 line)
      if (status) event.system.push({ type: "text", text: status })
      const hint = matchIndex(event)
      if (hint) event.system.push({ type: "text", text: hint })
    }))

    registrations.push(await ctx.session.hook("compaction", (event) => {
      event.system.push({ type: "text", text: loadPriors() }) // priors only — NEVER set event.result
    }))

    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "error") return
      await captureFailure(event, ledger)
    }))

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.idle") await snapshotHandoffIfChanged(event, ledger)      // P1 gate
        else if (event.type.startsWith("session.compaction.")) await captureCompaction(event)  // P1 gate
      }
    })()

    return () => {
      controller.abort()
      for (const r of registrations) void r.dispose()
    }
  },
})
```

Permissions: the `memory-manager` subagent is **fully read-only** — `edit`, `shell`, `webfetch`, `websearch`, and `skill` all denied (ADR-0007). The primary agent's `subagent` permissions must allow launching it **if** the optional delegation path is enabled; the default review runs in-session. There is **no** session permission lock (retired): the review only proposes, and every write is per-line approved. Memory files are untrusted input: size-cap before inject, never execute from them.

### 4.7 Your style, encoded (the core ask)

Durable `style.md` entries, quoted by the agent every session via the AGENTS.md chain:

- "Do not propose deferring simple fixes to shrink blast radius. Cosmetic patches are a defect."
- "'Develop concrete implementation for X' means: implement the existing interface/contract; survey sibling implementations first; no core-engine disruption unless the contract itself must change; list ripple effects explicitly."
- "Across model swaps, keep the recorded architecture style. A different pattern needs explicit justification referencing `decisions.md`."

`memory-manager.md` system prompt: read traces, update `activeContext.md`, record patterns in `architecture.md`/`style.md` only via `/memory-review`, create handoffs. This makes "knows what I did, judges relevance for today" a file-read discipline, not a vector query.

### 4.8 Design principle: no human-like memory (Gemini discovery)

Mimicking biological memory — vector-based semantic recall, lossy associative summaries, organic forgetting — is the wrong paradigm for a coding harness. Human memory optimizes for survival and pattern-matching in ambiguity; software demands determinism, structural precision, and verifiable lineage. This plugin therefore bans all four biological failure modes by construction:

- **Fuzzy semantics → exact symbols.** Compilers don't grade on "semantic closeness": one renamed flag or dropped import breaks the build. Retrieval here is exact-match grep on symbols/files plus `Supersedes` link-walking (§4.4) and `ctx.vcs` diffs — relationship pointers ("what calls this?", "what superseded this?"), never vibe similarity. This is why there are no embeddings: the adopted vector-failure analysis and the v1 re-embed/support burden already ruled them out; the determinism argument closes the case.
- **Reconstructive drift → immutable lineage where required.** Recalled-and-retold narratives hallucinate APIs and blend modules (context rot). `decisions.md` and `handoffs/` are append-only and verbatim: corrections are new entries with `Supersedes` links, never edits. `architecture.md` / `style.md` / `issues.md` are review-gated rewrites (human-approved via `/memory-review`, git blame preserves lineage). Summaries exist only as disposable handoffs, never as memory.
- **Organic forgetting → explicit pruning.** A dropped migration quirk or edge-case rule is a production bug, not cognitive hygiene. Nothing durable fades by age; removal is an explicit human-approved promotion/compaction into `INDEX.md` one-liners or `handoffs/archive/`, with git retaining everything.
- **Episodic timelines → engineering lineage.** Decisions cite verifiable artifacts: file paths, commit SHAs, issue numbers, contract names. Every entry carries `Touches` + `Supersedes`, so "why" is always traceable to a diff, not a recollected vibe.

Concretely: AST/symbol/dependency navigation where the harness offers it (`ctx.vcs`, LSP-backed reads), deterministic artifacts (`.md` specs with fixed schemas, never freeform evolving narratives), and **git as the ultimate backbone** — history, undo/redo, blame, and restore all come from version control, not from a memory store.

## 5. Roadmap (MVP-first)

- **P0 — no code (1 day):** root `AGENTS.md` protocol + six memory files + manual `memory-manager` subagent. Acceptance: new session restores context from `INDEX.md` + `activeContext.md` without re-explaining.
- **P1 — local plugin (2–4 days):** corrected skeleton (`design-spec-v2-production.md` §§2–5), ledger-backed idempotent capture, budgets enforced, `/memory-review` (proposal table + `memory_apply` per-line approval), handoffs. Acceptance: zero LLM calls in default path; injection ≤ budget; no duplicates across restart; compaction preserves priors and never sets `event.result`; P1 runtime gates (G1–G4) resolved or fallbacks wired; redaction blocks secrets fixtures; captured bodies never auto-injected.
- **P2 — hardening (1–2 weeks):** `<private>` redaction + secrets blocklist, multi-project isolation check, per-line approval UX, evals (recall success vs. tokens injected), docs. Optional only: SQLite FTS mirror, 30d TTL sweep, recorded access-weighted decay as an explicit command — never automatic.

Cost: $0 default (no API, no server, no embeddings). Latency: file reads only.

## 6. Sources

- Prior research (harness/Memory-Bank/context-rot analysis with minimalist markdown recipe and blueprint; storage/RAG/TTL survey with SQLite+embeddings roadmap) — source papers removed; content folded into §§2–4 above, including the recorded decay formula in §2 row 8.
- V2 docs (2026-10-15): `/v2/docs/plugins/` (plural key, discovery, precedence), `/v2/docs/build/plugins/` (`Plugin.define`, transforms, `session.hook("prompt"|"context"|"compaction"|…)`, `event.subscribe`, `storage` incl. `scan`, `tool`/`command` transforms, `permission.hook("evaluate")` — documented but **not used** by this design), `/v2/docs/instructions/` (AGENTS.md hierarchy, nested lazy discovery, nested-edit caveat; the `instructions` array **is** resolved — files/globs/`~/`/absolute/http(s), loaded after AGENTS.md), `/v2/docs/config/` (`agents`/`system`/`permissions`/`default_agent`/`references`/`compaction`), `/v2/docs/agents/` (permission evaluation order: last matching rule wins), `/v2/docs/compaction/` (`session.compaction.*` events; hooks run before the summary model call).
- V1 evidence: `tickernelz/opencode-mem` README + `#330` (vault request) + `#359` (Windows multiprocess); `supermemoryai/opencode-supermemory` README + `#106` (duplicate capture), `#69` (compaction races), `#85`/`#88` (premature compaction), `#91`/`#97`/`#104` (config/tool drift); `docs.mem0.ai/integrations/opencode`; `hindsight.vectorize.io/sdks/integrations/opencode` (superseded notice).
- Design principle (§4.8): Gemini discovery supplied in-session (anti-biological-memory: determinism over fuzzy recall, immutable entries over reconstructive drift, explicit pruning over organic forgetting, git/ADR lineage over episodic timelines) — adopted as the governing constraint behind the no-embeddings, append-only, git-backed choices above.
