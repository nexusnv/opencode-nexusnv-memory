# C4 Level 4 (Code) — Implementation Guide

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/`, `/v2/docs/plugins/`. **Normative on V2 contracts:** `design-spec-v2-production.md` §§1–5. (Note: `c4-04`/`c4-05` are supplementary interface/data specs sharing this sequence, not separate C4 levels — C4 core is Context → Container → Component → Code.)

## Module layout (planned)

Production package (`src/`) and local drop-in (`.opencode/plugins/memory/`) share one codebase; the drop-in keeps the same modules with `index.ts` as the single entry.

```
src/ (or .opencode/plugins/memory/)
└── index.ts        # Plugin.define({ id: "memory", setup }) — wiring only
    ├── brief.ts     # loadBrief, loadPriors (capped)
    ├── hints.ts     # matchIndex (exact match + once-per-prompt throttle)
    ├── status.ts    # statusLine (rotation notice + review-due nudge)
    ├── capture.ts   # captureFailure, snapshotHandoffIfChanged, ledger helpers
    ├── provenance.ts# classifyProvenance, rememberAsserted (source:user fast path)
    ├── guard.ts     # flagInjection (advisory), untrusted labelling, sanitizeForBrief
    ├── tools.ts     # ctx.tool.transform: memory_recall, memory_apply
    ├── files.ts     # readCapped, writeCapped, budget enforcement, archive routing, write mutex
    ├── redact.ts    # secrets blocklist + <private> stripping
    ├── config.ts    # ≤5 options, defaults, validation (ctx.options)
    └── templates.ts # six-file scaffolds + AGENTS.md protocol block text
```

## Function contracts

- `readCapped(file)`: resolves the path under the fixed `.opencode/memory`, rejects any escape (`..`, absolute, backslash, percent-encoded separators), then requires allowlist membership (`INDEX/activeContext/decisions/architecture/style/issues`) or the handoff pattern `/^handoffs\/(?:archive\/)?[A-Za-z0-9._-]+\.md$/`; returns the file text with a truncation notice (the `memory_recall` tool wraps it via `toolResult(text)`, default `{ content }`); unknown/invalid → error; always strips secrets/`<private>`. Archive paths are recallable on demand, never auto-injected.
- `writeCapped(file, text)`: allowlisted paths only; enforces `indexLines`/`fileLines` on every write; redacts; serialized through one per-process mutex (single-flight per content ID + append lock); throws on violation for a capped rule file (never silently truncates a durable file), while `activeContext.md` rotates the oldest Known-Errors block to `handoffs/archive/` at the cap instead.
- `toolResult(text)`: the single adapter for the tool-executor return envelope (`{ content: text }` by default; G2); every tool return goes through it.
- `memory_apply(candidates)`: the only write channel for approved lines — one `ctx.permission.assert` per candidate (line + `source:` tag in the prompt `metadata`), then `writeCapped` on `allow`; untrusted lines cannot be bulk-approved.
- `loadBrief()`: activeContext slice + newest handoff pointer (≤ 48 lines, the fixed slice of `injectBudgetLines`); truncates with notice; redacted. Does **not** contain the INDEX map. **Known Errors contribute summary lines only** — `sanitizeForBrief()` emits one `source:`-tagged line per error and never a captured body. Total auto-inject payload (INDEX attach + brief + status + hint) ≤ `injectBudgetLines` (~80); excludes static root `AGENTS.md` directive (~10) + tool description (~3).
- `loadPriors()`: capped + redacted priors for the compaction hook; truncates with notice.
- `matchIndex(event)`: exact symbol/file match against the **latest user message text in `event.messages`** (the `context` event carries no `prompt.text`) against INDEX; returns a 1-line hint or `undefined` — never content, never fuzzy; **throttled to once per prompt/session** via a ledger key so tool-driven continuations do not re-inject it.
- `statusLine(event)`: **async**; resolves to ≤1 `[memory]` line or `undefined`, from `ctx.storage` counters only (no filesystem listing, redacted). Emits the rotation notice once (from the `curation.rotated` marker, then clears it) and the review-due nudge while `curation.pending ≥ 5`; both facts share one line if they co-occur; dropped before the hint under budget pressure. Thresholds are fixed, not options. The line is model-facing (`event.system`); delivery to the user depends on the agent relaying it.
- `captureFailure(event, ledger)`: failures only (`event.status === "error"`), redacted, ledger-guarded (`ctx.storage`, content-ID check-before-write, ~30s retry); writes a `source:tool` summary line derived from `event.error.message` (the documented payload is message-only — G4) plus an **optional** recall-only detail block written only when the event carries output; increments `curation.pending` and sets `curation.rotated` on rotation.
- `classifyProvenance(turn, text)`: returns `user | tool | model | snapshot`. `user` only for an explicit directive in the user's own turn in the documented form, outside code fences/quotes/pasted blocks; ambiguous → the non-user class. Pure, testable, no LLM — **detection only**; the write site is the `prompt` hook.
- `rememberAsserted(text, ledger)`: `source:user` fast path — redact, ledger-dedup, append to append-only `decisions.md` tagged `(user-asserted)`. Called from the `prompt` hook (the only hook that sees the user's turn before admission); serialized (write mutex) and never-throw (a throwing prompt hook blocks admission). The plugin is the sole writer. Never targets `architecture.md`/`style.md`/`issues.md`.
- `sanitizeForBrief(entry)`: collapses the entry to one summary line (newlines collapsed, ≤120 chars) with its `source:` tag; the body is dropped, not truncated into the brief.
- `flagInjection(text)`: returns advisory flags (imperative/instruction-shaped text, agent-directed directives, URL/`fetch` payloads, encoded blobs). Never blocks, never rejects, never labelled "detected".
- `snapshotHandoffIfChanged(event, ledger)`: resolves the memory root for the **event's** session/location (fallback `ctx.location`), never a root captured at load, and runs only for events in this location; `branch` via `ctx.vcs.status()` (fallback `ctx.vcs.get()`); open changes via `ctx.vcs.diff({mode:"working"})` (fallback `ctx.vcs.status()`); hash(branch+status+pending); same hash as this session's last snapshot → no-op, else new immutable `handoffs/YYYY-MM-DD-HHmm.md`; newest wins. Async, fire-and-forget, serialized. All VCS calls sit behind one adapter.
- `ledger`: `ctx.storage` only — `seen/<id>` + `attempt/<id>` + `curation.pending` + `curation.rotated`, keys namespaced per project (`<projectID>/…`; `ctx.storage` is plugin-scoped, not project-scoped), pruned via `scan({prefix})` to ≤500; persisted, never in-memory alone. The API has no compare-and-set, so a single-flight map keyed by content ID serializes concurrent `execute.after` checks; a duplicate that still slips through is benign.
- Lifecycle: capture each `Registration` returned by `hook`/`transform`; a **single shared** event `AbortController` (not one per subscriber) is aborted and every registration is disposed in the `setup` cleanup, which awaits `dispose()`. Unloading also disposes registrations.

## Setup / dev

- Config location matters. If config is `.opencode/opencode.jsonc`: `"plugins": ["./plugins/memory"]`. If config is repo-root `opencode.jsonc`: `"plugins": ["./.opencode/plugins/memory"]`. Drop-in alternative: `.opencode/plugins/memory/` auto-discovery; `opencode plugin list` verifies load; touch the entry file or restart the runtime per its reload guidance if a stale load is suspected.
- First run scaffolds templates + `handoffs/` and emits the commented ≤5-option snippet; it never edits `opencode.jsonc` or `AGENTS.md` (ADR-0006).
- Pin an exact tested `@opencode/plugin` release (2.0.x; tested `2.0.29`); never `latest`.

## Test list (pre-merge acceptance)

Budget enforcement on every write path (and over-cap INDEX is not attached); ledger idempotency across restart/replay (persisted `ctx.storage`, not in-memory); injection ≤ `injectBudgetLines` with prompt-hook dedup and no INDEX duplication in the brief; status line — rotation notice emitted once then cleared, review-due nudge at ≥5 uncurated captures and gone after `/memory-review`, dropped before the hint under budget pressure; **injection containment — a fixture whose captured error text carries an agent-directed instruction lands on disk but the brief carries only the summary line; `classifyProvenance` rejects instructions inside code fences/quotes/pasted blocks; `flagInjection` never blocks or alters a write; untrusted candidates are excluded from bulk approval**; **provenance gate — documented user directive appends to `decisions.md` immediately and tagged, ambiguous/tool-origin `remember` does not**; compaction injects priors and **never sets `event.result`** and uses no custom trigger; nested-`AGENTS.md` caveat covered (memory outside nested files); redaction blocks secrets fixtures and `<private>` (incl. unclosed tags); `memory_recall` rejects unknown/traversal paths and returns the executor envelope via `toolResult` (default `{ content }`, asserted against the installed package — G2), and `memory_apply` approves one candidate line per `ctx.permission.assert`; `handoffs/` root vs `handoffs/archive/` routing covered; `vcs`/`storage` adapters tolerate shape drift; `memory-manager` has no `edit`, `shell`, `webfetch`, `websearch`, or `skill`, and the `subagent` allow for it is present when the optional delegation path is enabled; there is no session permission lock (retired G5); every hook is async where it touches storage/vcs and never throws; foreign-location events are dropped before any write; the single event `AbortController` is reused and cleanup awaits `Registration.dispose()`. **P1 runtime gates (design-spec §1.3):** log real `event.type`s and confirm `session.idle` (the `session.compaction.*` family is doc-confirmed), wiring the fallback if absent; prove the executor tool-return envelope (G2); confirm `setup` cleanup; confirm the failure payload is message-only (G4 baseline). G5 is retired (proposal-only review; no lock).
