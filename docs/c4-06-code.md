# C4 Level 4 (Code) — Implementation Guide

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/`, `/v2/docs/plugins/`. (Note: `c4-04`/`c4-05` are supplementary interface/data specs sharing this sequence, not separate C4 levels — C4 core is Context → Container → Component → Code.)

## Module layout (planned)

```
.opencode/plugins/memory/
└── index.ts        # Plugin.define({ id: "memory", setup }) — all wiring
    ├── brief.ts    # loadBrief, loadPriors (capped)
    ├── hints.ts    # matchIndex (exact match only)
    ├── capture.ts  # captureFailure, snapshotHandoff, ledger helpers
    ├── files.ts    # readCapped, budget enforcement
    └── redact.ts   # secrets blocklist + <private> stripping
```

## Function contracts

- `readCapped(path, cap)`: allowlisted paths only (`INDEX/activeContext/decisions/architecture/style/issues` + `handoffs/**/*.md`); returns `{ text, truncated: boolean }`; unknown path → error; always strips secrets/`<private>`; appends truncation notice when capped.
- `loadBrief()`: INDEX (≤30) + active slice; total ≤ ~80 lines or it truncates with notice; redacted.
- `matchIndex(event)`: exact symbol/file match against INDEX; returns 1-line hint or `undefined` — never content, never fuzzy.
- `captureFailure(event, ledger)`: failures only, 20-line truncation, redacted, ledger-guarded (`ctx.storage`, content-ID check-before-write).
- `snapshotHandoff(event, ledger)`: branch + `ctx.vcs.status()` + pending; content-hash-guarded (same hash as last snapshot for this session → no-op, else new immutable `handoffs/YYYY-MM-DD-HHmm.md`); newest wins.

## Setup / dev

- Config location matters. If config is `.opencode/opencode.jsonc`: `"plugins": ["./plugins/memory"]`. If config is repo-root `opencode.jsonc`: `"plugins": ["./.opencode/plugins/memory"]`. Drop-in alternative: `.opencode/plugins/memory/` auto-discovery; `opencode plugin list` to verify; `touch` + `opencode service restart` on reload issues.
- First run generates templates + commented config (≤5 options).

## Test list (pre-code acceptance)

Budget enforcement on every write path; ledger idempotency across restart/replay (persisted `ctx.storage`, not in-memory); injection ≤ cap with prompt-hook dedup (no double INDEX); compaction preserves priors without custom trigger (shape-guarded `system`/`result`); nested-AGENTS.md caveat covered (memory outside nested files); redaction blocks secrets fixtures; event catalog verified (`tool.execute.after`/`session.idle` proven in runtime log or fallback wired); `memory_recall` rejects unknown/traversal paths; `handoffs/` root vs `handoffs/archive/` routing covered.
