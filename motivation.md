# No-Fuss Memory Plugin for OpenCode V2 — Synthesized Report

**Status:** validated against the live OpenCode V2 docs on 2026-10-15 (plugins, build/plugins, instructions, config). Research claims below are self-contained (prior source papers since removed; their content is folded into this report). V1 plugin claims cite repo READMEs and issue numbers fetched same day.

**Goal:** a memory plugin for *all* developers that is local-first, zero-subscription, zero-daemon, zero-embeddings by default — and remembers exactly the basics: project background, agent context, architectural decisions, last refactors, planned GitHub issues, and personal style (no tech-debt compounding, architecture-style lock across model swaps, contract-first implementation).

**Non-goals:** remember-everything transcript capture, vector/semantic search, cloud sync/team server, knowledge graphs, background LLM dreaming. All deferred or rejected with reasons.

## 1. Evidence base

- Prior research inputs (source papers since removed; key content folded into this report): (a) harness algebra, Memory-Bank comparison, context-rot/SNR analysis, minimalist markdown recipe, access-weighted decay, blueprint config; (b) storage comparison (file/SQLite/vector/hybrid), RAG retrieval, ADD/UPDATE/DELETE/NOOP consolidation, 28–30d TTL, privacy/governance, per-project scoping, MVP roadmap.
- V1 field evidence: `tickernelz/opencode-mem` (1.7k stars, local Turso vectors), `supermemoryai/opencode-supermemory` (1.6k stars, cloud), `@mem0/opencode-plugin` (cloud), `@vectorize-io/opencode-hindsight` (server, now superseded), plus issue trackers and the `AGENTS.md`-as-memory community practice.
- V2 ground truth: `https://opencode.ai/v2/docs/plugins/`, `https://opencode.ai/v2/docs/build/plugins/`, `https://opencode.ai/v2/docs/instructions/`, `https://opencode.ai/v2/docs/config/`.

## 2. Claim validation (research vs. V2 reality)

| # | Claim | Verdict | V2-correct form |
|---|-------|---------|-----------------|
| 1 | Proposed hooks (`onSessionStart`, `onToolPostExecute`, `onSessionEnd`) | **Wrong names.** No such exports exist. | V2 uses `Plugin.define({ id, setup(ctx) })` with `ctx.session.hook("prompt" \| "context" \| "compaction" \| "generate" \| "title")`, `ctx.event.subscribe()` for the public event stream, `ctx.tool.transform`, `ctx.command.transform`. Passive capture = event stream + `prompt` hook; injection = `context` hook (`event.system.push`); compaction survival = `compaction` hook (can set `event.result` to record the summary yourself). |
| 2 | Early blueprint injects memory via `"instructions": ["…/INDEX.md", "…/activeContext.md"]` | **Silently does nothing on V2.** | V2 instructions doc: "The V2 config schema accepts an `instructions` array, but V2 does not currently resolve its files… This configuration does not add instructions to the model yet. Use `AGENTS.md` for active V2 instructions." Memory must ride `AGENTS.md`, not `instructions`. |
| 3 | Claim: AGENTS.md edits live-reload into the active prompt | **Half-true.** | True for global/upward files: V2 detects the change and adds an instruction update before the next model request. False for already-loaded *nested* (below-workspace, lazily discovered) files: "Edits to a nested file are not detected automatically after it loads. Start a new session." Design must keep auto-written memory out of nested files the session already loaded, or accept new-session pickup. |
| 4 | Blueprint config (`agents` plural, `system`, `permissions: [{action, resource, effect}]`, `default_agent`, `references`) | **Correct on V2** (an earlier v1-based objection was wrong). | V2 config docs confirm `agents`, `system`, ordered `permissions` array, `default_agent`, `references` with `path`/`repository`/`description`. Keep this shape; fix only the `instructions` entry (drop it) and add `plugins` registration. |
| 5 | Proposed plugin key `plugin: [...]` / package declarations | **V1 spelling.** | V2 key is **`plugins`** (plural). Supports packages with versions/tags/ranges, Git specs, local dirs/files, and `{package, options}` objects. `.opencode/plugins/` auto-discovers direct `.ts`/`.js` files and immediate package dirs. Arrays merge across global → project → `.opencode` configs instead of replacing. |
| 6 | Surveyed example plugin (`session.created`, `session.idle`, `tool:` key) | **V1 API; needs migration.** | Rewrite as `Plugin.define` + `ctx.event.subscribe` (capture) + `ctx.tool.transform(editor.add(…))` (tools) + `ctx.session.hook("compaction")`. Do not copy the snippet as-is. |
| 7 | Surveyed default: SQLite + FTS + embeddings, RAG top-k + RRF, LLM ADD/UPDATE/DELETE/NOOP | **Valid engineering, rejected for MVP.** | V1 evidence (below) shows embeddings bring model downloads (100MB–2GB), RAM, re-embed migrations, lock files, single-session-on-Windows, no-Intel-Mac, plus per-token API cost. The adopted vector-failure analysis (exact binding vs. semantic closeness, chunking breaks scope, index drift; see §4.8) agrees. No-fuss default = markdown only, INDEX-first lazy read, no embeddings. |
| 8 | TTL 30d + budgets vs. access-weighted decay $W_m(t) = W_0 e^{-\lambda(t-t_{\text{last}})}(1+\alpha C_{\text{access}})$, threshold $W_{\min}$ | **Both recorded; budgets win for MVP.** | Deterministic line/token caps + explicit `/memory-review` promotion beat time-decay for inspectability. The decay formula is preserved above as the phase-2 option, not the default. |
| 9 | OpenCode has no native cross-session LTM; SQLite is session-scoped | **Confirmed.** | This is the gap the plugin fills. `ctx.storage` (durable JSON scoped to the plugin) exists, but memory itself stays in git-backed markdown so humans can read, edit, and revert it. |

## 3. V1 lessons that shape this design

- **Cloud fatigue is real.** Supermemory/Mem0/Hindsight all need API keys, servers, containers, SDK versions. Your stance (simple > robust-with-subscription) is the design constraint: no accounts, no keys, no daemon, no server in the default path.
- **Vectors create support load.** `opencode-mem` documents embedding-model choice, dimension/pooling/prefix alignment, re-embed swaps with `.bak` files and locks, `multiprocess_wal` limits, platform exclusions. Users counter-propose exactly your ask: Obsidian/markdown-vault backend with the vault as source of truth (`tickernelz/opencode-mem#330`).
- **Auto-capture must be idempotent.** `supermemoryai/opencode-supermemory#106` (same `customId` re-POSTed after a timeout → one fact stored 55×) mandates a capture ledger + check-before-write + short retry window. This report adopts all three.
- **Never reimplement compaction.** `#69` (custom trigger overflows the smaller compaction model, session stuck on compaction model, `threshold: 0` can't disable, races native `compaction.auto`) plus `#85`/`#88` (premature compaction from model-limit fallback) → use V2's `compaction` hook only to inject priors and save the summary. No custom trigger, no synthetic Continue.
- **Config sprawl kills adoption.** `#91`/`#97`/`#104` (ignored config file, stale README, per-location tool conflicts) → this plugin has ≤5 options, one config file, commented template generated on first run.
- **Opaque stores get abandoned.** Hash-keyed shards/containers orphan on repo moves (`migrate`/`list-shards`/`export`/`import` ceremony) → markdown files at stable paths, directory-driven identity, no hashes.

## 4. Synthesis: the no-fuss architecture

**One sentence:** git-backed markdown as the source of truth, passive zero-LLM hooks with hard budgets, injection via `prompt` hook (`INDEX.md` content) + `context` hook (brief + hint) with protocol + links in root `AGENTS.md`, survival through the `compaction` hook, curation by an explicit command — no embeddings, no server, no keys.

```
AGENTS.md (repo root)         # hand-owned, tiny, durable (protocol + links; never auto-written, never content)
.opencode/
├── opencode.jsonc             # location: .opencode/opencode.jsonc → plugins: ["./plugins/memory"]; if repo-root opencode.jsonc → ["./.opencode/plugins/memory"]; plus agents: { memory-manager }, references: { memory } (shape per c4-04)
├── agents/
│   └── memory-manager.md      # background subagent (on-demand only)
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

- `INDEX.md` ≤ 30 lines on disk; `activeContext/architecture/style/issues` ≤ 60 lines on disk; `decisions.md` unbounded on disk with ≤60-line injectable tail (full log + git retains everything); handoffs per-file ≤60 lines; auto-inject payload (prompt `INDEX.md` attach + context brief + hint) ≤ ~80 lines (~1.5k tokens, excludes static `AGENTS.md` directive ~10 lines + tool description ~3 lines).
- Capture: failures only (truncated to 20 lines), session boundaries, explicit `remember` keyword. No per-turn LLM extraction.
- Scratchpad (`activeContext.md`) is append-until-60 during work, then rotates: oldest Known-Errors block moves to `handoffs/archive/` with a notice, never into the prompt. Promotion to durable files happens only via `/memory-review` (human-approved) or the `memory-manager` subagent on demand.
- Root `AGENTS.md` stays tiny: it states the protocol and *links* memory; it never contains memory content itself. The `prompt` hook is the sole injector of `INDEX.md` content (deduped — skip if already attached; see §4.3-1/4). This directly answers the bloat fear: injection surface is bounded even as history grows.

### 4.3 File lifecycle: scratchpad → durable → archived

Three states. Only scratchpad is written automatically; durable requires human approval; archived is git history, never deleted.

- **0. Init (once).** Plugin creates the directory + templates + commented config. Root `AGENTS.md` (hand-owned, never auto-written) carries protocol + links only, never file content. Nothing injects beyond `INDEX.md` until content exists.
- **1. Capture (automatic, zero-LLM).** `prompt` hook is the sole injector of `INDEX.md` content: attach (capped) to the current prompt only, retry-safe per V2 contract, and skip if an `INDEX.md` attachment is already present (dedup guard — root `AGENTS.md` never carries content, so no double injection). Event stream (`ctx.event.subscribe`; verify exact catalog names at P1 — see `c4-03-components.md` event-note) appends *failed* shell/build/test output (truncated to 20 lines, redacted) to `activeContext.md` under Known Errors. Keyword ("remember X") and explicit `remember` calls take the same scratchpad path, flagged for review — never auto-promoted.
- **2. Deduplication.** Every capture passes a persisted ledger (`ctx.storage` — never an in-memory `Set` alone): check-before-write on content ID, persist attempt state, retry only inside a ~30s window. Restarts and session-end replays are no-ops. Direct fix for supermemory #106 (same batch re-POSTed → one fact stored 55×).
- **3. Idle snapshots vs session end.** `session.idle` may fire N times per session; it is not session end. Handler is content-hash-guarded: compute hash of (branch + `ctx.vcs.status()` + pending); if unchanged since this session's last snapshot (hash stored in ledger), no-op; else write immutable `handoffs/YYYY-MM-DD-HHmm.md`: branch (via `ctx.vcs.status()`), open changes, completed vs. pending, next steps. Newest timestamped snapshot is the single source for "where did we leave off". "Idempotent per session" means same content → no new file.
- **4. Next session start.** `prompt` hook attaches `INDEX.md` (capped, deduped) at the top; `context` hook pushes the active brief at the bottom (`event.system.push`). Root `AGENTS.md` contributes only the standing directive + links, never content. Anything deeper is lazy via `memory_recall` (one capped file per question).
- **5. Promotion (only path to durable).** `/memory-review` command or `memory-manager` subagent (edit scoped to `.opencode/memory/**`, shell denied) proposes scratchpad → `decisions.md` / `architecture.md` / `style.md` / `issues.md` (scope-limited). Human approves before write. `issues.md` also accepts direct manual edits (one line per issue) but `/memory-review` validates format/caps/redaction. No per-turn LLM extraction, no silent durable rewrites.
- **6. Compaction survival.** `compaction` hook injects priors into the summary context and saves the produced summary as a handoff. Shape-guard: if `event.system` exists, `push` priors (capped); always handle `event.result` (set it to record the summary yourself when supported, else save the produced summary as a handoff file). No custom threshold, no synthetic Continue, no model override (the #69/#85/#88 failure set). Pre-compaction state is already on disk, so a bad summary loses nothing durable.
- **7. Aging.** Budgets enforced per enforcement point (§4.2, `c4-05-data-model.md`): `INDEX.md` ≤30 lines on disk; `activeContext/architecture/style/issues` ≤60 lines on disk; `decisions.md` unbounded on disk with ≤60-line injectable tail; handoffs per-file ≤60 lines; auto-inject payload ≤~80 lines; content overflow (retired durable lines, rotated scratchpad blocks) goes to `handoffs/archive/`, never into the prompt. Session snapshots go to `handoffs/` root. Phase-2 only: 30d TTL sweep or the recorded access-weighted decay ($W_m(t)$, $W_{\min}$) as an explicit command — off by default; applies only to unreachable episodic notes, never to reachable decisions (ADR-0005). `forget`/purge removes from active files; git retains history (restore = checkout).
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
| Hint line | 1 line | only on exact INDEX match |
| Full decision text | capped file | only after the model peeks |

### 4.6 Minimal V2 skeleton (conforms to build/plugins)

```ts
// .opencode/plugins/memory/index.ts
// Normative skeleton: allowlisted recall (incl. handoffs/archive, never auto-injected) + persisted ledger + deduped INDEX + shape-guarded compaction.
// Event names ("tool.execute.after", "session.idle") MUST be verified against the live
// /v2/docs/build/plugins/ event catalog at P1; gate merge on `opencode plugin list` + runtime log proving
// failure-capture and idle-snapshot fire. Fallback if absent: capture on prompt-hook file diff.
import { Plugin } from "@opencode/plugin"

const ALLOWED_RECALL = new Set([
  "INDEX.md", "activeContext.md", "decisions.md",
  "architecture.md", "style.md", "issues.md",
])

function isHandoffPath(file: string): boolean {
  return file.startsWith("handoffs/") && file.endsWith(".md") && !file.includes("..") && !file.includes("//")
  // Covers handoffs/<name>.md + handoffs/archive/<name>.md; recallable on demand, never auto-injected.
}

export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    // Persisted ledger (ctx.storage) — never an in-memory Set alone (ADR-0004, supermemory #106).
    const ledger = {
      async has(id: string): Promise<boolean> {
        const seen = ((await ctx.storage.get("ledger.seen")) as string[] | undefined) ?? []
        return seen.includes(id)
      },
      async mark(id: string): Promise<void> {
        const seen = ((await ctx.storage.get("ledger.seen")) as string[] | undefined) ?? []
        if (!seen.includes(id)) await ctx.storage.set("ledger.seen", [...seen.slice(-500), id])
        await ctx.storage.set(`ledger.attempt.${id}`, Date.now())
      },
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "memory-review",
        description: "Promote scratchpad notes into durable memory (human-approved)",
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.prompt({ sessionID, delivery,
            text: `${prompt.text}\n\nRead .opencode/memory/INDEX.md and activeContext.md, propose promotions into decisions/architecture/style/issues (capped, redacted), and ask for approval before writing. Never write durable files without approval.` })
        },
      })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_recall",
        description: "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone.",
        input: { type: "object", properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false },
        // Normative values per c4-04: INDEX.md | activeContext.md | decisions.md | architecture.md | style.md | issues.md | handoffs/<name>.md | handoffs/archive/<name>.md; enforced by ALLOWED_RECALL + isHandoffPath.
        execute: async (input) => {
          const file = (input as { file: string }).file
          if (!ALLOWED_RECALL.has(file) && !isHandoffPath(file)) throw new Error(`unknown memory file: ${file}`)
          return readCapped(`.opencode/memory/${file}`) // readCapped enforces cap + truncation notice + secrets/<private> strip
        },
      })
    })

    await ctx.session.hook("prompt", (event) => {
      // Sole INDEX-content injector (root AGENTS.md carries protocol+links only). Dedup guard prevents double injection.
      event.prompt.files ??= []
      const absIndex = `${ctx.project.root}/.opencode/memory/INDEX.md`
      const already = event.prompt.files.some((f: { uri: string }) => f.uri.endsWith(".opencode/memory/INDEX.md"))
      if (!already) event.prompt.files.push({ uri: `file://${absIndex}` })
    })

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: loadBrief() }) // bottom position, capped
      const hint = matchIndex(event) // exact INDEX symbol match only; undefined when absent
      if (hint) event.system.push({ type: "text", text: hint }) // 1-line tell-tale, never content
    })

    await ctx.session.hook("compaction", async (event: { system?: { push: (m: unknown) => void }; result?: unknown }) => {
      // Shape-guard: compaction payload differs across V2 versions — handle both.
      const priors = loadPriors() // capped + redacted
      if (event.system) event.system.push({ type: "text", text: priors })
      if ("result" in event) {
        if (event.result !== undefined) {
          await saveHandoffFromResult(event.result) // read path: record produced summary as handoff
        } else {
          (event as { result?: unknown }).result = priors // write path: record summary yourself when runtime supports set
        }
      } else {
        await saveHandoffFromText(priors) // fallback: priors already on disk; post-compaction path saves produced summary
      }
      // Never change model/threshold/trigger here.
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // P1 gate: confirm these strings in the live catalog; see c4-03 event-note.
        if (event.type === "tool.execute.after" && isFailure(event)) await captureFailure(event, ledger)
        if (event.type === "session.idle") await snapshotHandoff(event, ledger) // content-hash-guarded; same content → no-op
      }
    })()
    return () => controller.abort()
  },
})
```

Permissions: `memory-manager` subagent gets `edit` scoped to `.opencode/memory/**`, `shell` denied; primary agents keep normal perms. Memory files are untrusted input: size-cap before inject, never execute from them.

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
- **P1 — local plugin (2–4 days):** skeleton above, ledger-backed idempotent capture, budgets enforced, `/memory-review`, handoffs. Acceptance: zero LLM calls in default path; injection ≤ budget; no duplicates across restart; compaction preserves priors; event names verified against live V2 catalog (runtime log); redaction blocks secrets fixtures.
- **P2 — hardening (1–2 weeks):** `<private>` redaction + secrets blocklist, multi-project isolation check, permission UX, evals (recall success vs. tokens injected), docs. Optional only: SQLite FTS mirror, 30d TTL sweep, recorded access-weighted decay as an explicit command — never automatic.

Cost: $0 default (no API, no server, no embeddings). Latency: file reads only.

## 6. Sources

- Prior research (harness/Memory-Bank/context-rot analysis with minimalist markdown recipe and blueprint; storage/RAG/TTL survey with SQLite+embeddings roadmap) — source papers removed; content folded into §§2–4 above, including the recorded decay formula in §2 row 8.
- V2 docs (2026-10-15): `/v2/docs/plugins/` (plural key, discovery, precedence), `/v2/docs/build/plugins/` (`Plugin.define`, transforms, `session.hook("prompt"|"context"|"compaction"|…)`, `event.subscribe`, `storage`, `tool`/`command` transforms), `/v2/docs/instructions/` (AGENTS.md hierarchy, nested lazy discovery, nested-edit caveat, `instructions` array not resolved), `/v2/docs/config/` (`agents`/`system`/`permissions`/`default_agent`/`references`/`compaction`).
- V1 evidence: `tickernelz/opencode-mem` README + `#330` (vault request) + `#359` (Windows multiprocess); `supermemoryai/opencode-supermemory` README + `#106` (duplicate capture), `#69` (compaction races), `#85`/`#88` (premature compaction), `#91`/`#97`/`#104` (config/tool drift); `docs.mem0.ai/integrations/opencode`; `hindsight.vectorize.io/sdks/integrations/opencode` (superseded notice).
- Design principle (§4.8): Gemini discovery supplied in-session (anti-biological-memory: determinism over fuzzy recall, immutable entries over reconstructive drift, explicit pruning over organic forgetting, git/ADR lineage over episodic timelines) — adopted as the governing constraint behind the no-embeddings, append-only, git-backed choices above.
