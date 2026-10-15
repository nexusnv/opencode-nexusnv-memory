# C4 Level 4 (Code) — Implementation Guide

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/`, `/v2/docs/plugins/`. **Normative on V2 contracts:** `design-spec-v2-production.md` §§1–5. (Note: `c4-04`/`c4-05` are supplementary interface/data specs sharing this sequence, not separate C4 levels — C4 core is Context → Container → Component → Code.)

## Module layout (planned)

Production package (`src/`) and local drop-in (`.opencode/plugins/memory/`) share one codebase; the drop-in keeps the same modules with `index.ts` as the single entry.

```
src/ (or .opencode/plugins/memory/)
└── index.ts        # Plugin.define({ id: "memory", setup }) — wiring only
    ├── brief.ts     # loadBrief, loadPriors (capped)
    ├── hints.ts     # matchIndex (exact match only)
    ├── status.ts    # statusLine (rotation notice + review-due nudge)
    ├── capture.ts   # captureFailure, snapshotHandoffIfChanged, ledger helpers
    ├── provenance.ts# classifyProvenance, rememberAsserted (source:user fast path)
    ├── guard.ts     # flagInjection (advisory), untrusted labelling, sanitizeForBrief
    ├── files.ts     # readCapped, writeCapped, budget enforcement, archive routing
    ├── redact.ts    # secrets blocklist + <private> stripping
    ├── config.ts    # ≤5 options, defaults, validation (ctx.options)
    └── templates.ts # six-file scaffolds + AGENTS.md protocol block text
```

## Function contracts

- `readCapped(file)`: resolves the path under the fixed `.opencode/memory`, rejects any escape (`..`, absolute, backslash, percent-encoded separators), then requires allowlist membership (`INDEX/activeContext/decisions/architecture/style/issues`) or the handoff pattern `/^handoffs\/(?:archive\/)?[A-Za-z0-9._-]+\.md$/`; returns the file text with a truncation notice (the `memory_recall` tool wraps it as `{ type: "text", text }`); unknown/invalid → error; always strips secrets/`<private>`. Archive paths are recallable on demand, never auto-injected.
- `writeCapped(file, text)`: allowlisted paths only; enforces `indexLines`/`fileLines` on every write; redacts; throws on violation (never silently truncates a durable file).
- `loadBrief()`: activeContext slice + newest handoff pointer (≤ 48 lines, the fixed slice of `injectBudgetLines`); truncates with notice; redacted. Does **not** contain the INDEX map. **Known Errors contribute summary lines only** — `sanitizeForBrief()` emits one `source:`-tagged line per error and never a captured body. Total auto-inject payload (INDEX attach + brief + status + hint) ≤ `injectBudgetLines` (~80); excludes static root `AGENTS.md` directive (~10) + tool description (~3).
- `loadPriors()`: capped + redacted priors for the compaction hook; truncates with notice.
- `matchIndex(event)`: exact symbol/file match against INDEX; returns a 1-line hint or `undefined` — never content, never fuzzy.
- `statusLine()`: returns ≤1 `[memory]` line or `undefined`, from `ctx.storage` counters only (no filesystem listing, redacted). Emits the rotation notice once (from the `curation.rotated` marker, then clears it) and the review-due nudge while `curation.pending ≥ 5`; both facts share one line if they co-occur; dropped before the hint under budget pressure. Thresholds are fixed, not options.
- `captureFailure(event, ledger)`: failures only (`event.status === "error"`), 20-line truncation, redacted, ledger-guarded (`ctx.storage`, content-ID check-before-write, ~30s retry); writes `source:tool` summary line + recall-only detail block; increments `curation.pending` and sets `curation.rotated` on rotation.
- `classifyProvenance(turn, text)`: returns `user | tool | model | snapshot`. `user` only for an explicit directive in the user's own turn in the documented form, outside code fences/quotes/pasted blocks; ambiguous → the non-user class. Pure, testable, no LLM.
- `rememberAsserted(text, ledger)`: `source:user` fast path — redact, ledger-dedup, append to append-only `decisions.md` tagged `(user-asserted)`. Never targets `architecture.md`/`style.md`/`issues.md`.
- `sanitizeForBrief(entry)`: collapses the entry to one summary line (newlines collapsed, ≤120 chars) with its `source:` tag; the body is dropped, not truncated into the brief.
- `flagInjection(text)`: returns advisory flags (imperative/instruction-shaped text, agent-directed directives, URL/`fetch` payloads, encoded blobs). Never blocks, never rejects, never labelled "detected".
- `snapshotHandoffIfChanged(event, ledger)`: `branch` via `ctx.vcs.status()` (fallback `ctx.vcs.get()`); open changes via `ctx.vcs.diff({mode:"working"})` (fallback `ctx.vcs.status()`); hash(branch+status+pending); same hash as this session's last snapshot → no-op, else new immutable `handoffs/YYYY-MM-DD-HHmm.md`; newest wins. All VCS calls sit behind one adapter.
- `ledger`: `ctx.storage` only — `seen/<id>` + `attempt/<id>` + `curation.pending` + `curation.rotated`, pruned via `scan({prefix})` to ≤500; persisted, never in-memory alone.
- Lifecycle: capture each `Registration` returned by `hook`/`transform`; the `setup` cleanup aborts the event `AbortController` and disposes them. Unloading also disposes registrations.

## Setup / dev

- Config location matters. If config is `.opencode/opencode.jsonc`: `"plugins": ["./plugins/memory"]`. If config is repo-root `opencode.jsonc`: `"plugins": ["./.opencode/plugins/memory"]`. Drop-in alternative: `.opencode/plugins/memory/` auto-discovery; `opencode plugin list` verifies load; touch the entry file or restart the runtime per its reload guidance if a stale load is suspected.
- First run scaffolds templates + `handoffs/` and emits the commented ≤5-option snippet; it never edits `opencode.jsonc` or `AGENTS.md` (ADR-0006).
- Pin an exact tested `@opencode/plugin` release (2.0.x; tested `2.0.29`); never `latest`.

## Test list (pre-merge acceptance)

Budget enforcement on every write path (and over-cap INDEX is not attached); ledger idempotency across restart/replay (persisted `ctx.storage`, not in-memory); injection ≤ `injectBudgetLines` with prompt-hook dedup and no INDEX duplication in the brief; status line — rotation notice emitted once then cleared, review-due nudge at ≥5 uncurated captures and gone after `/memory-review`, dropped before the hint under budget pressure; **injection containment — a fixture whose captured error text carries an agent-directed instruction lands on disk but the brief carries only the summary line; `classifyProvenance` rejects instructions inside code fences/quotes/pasted blocks; `flagInjection` never blocks or alters a write; untrusted candidates are excluded from bulk approval**; **provenance gate — documented user directive appends to `decisions.md` immediately and tagged, ambiguous/tool-origin `remember` does not**; compaction injects priors and **never sets `event.result`** and uses no custom trigger; nested-`AGENTS.md` caveat covered (memory outside nested files); redaction blocks secrets fixtures and `<private>` (incl. unclosed tags); `memory_recall` rejects unknown/traversal paths and returns `{type:"text",text}`; `handoffs/` root vs `handoffs/archive/` routing covered; `vcs`/`storage` adapters tolerate shape drift; `memory-manager` has no `edit` and no `shell`. **P1 runtime gates (design-spec §1.3):** log real `event.type`s and confirm/replace `session.idle` and `session.compaction.*`; reconcile the tool return shape; confirm `setup` cleanup; confirm the failure payload carries enough output; confirm the review sandbox dispatch (G5) or wire its delegation fallback.
