# C4 Level 4 (Code) — Implementation Guide

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/`, `/v2/docs/plugins/`.

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

- `readCapped(path, cap)`: returns `{ text, truncated: boolean }`; unknown path → error; always strips secrets.
- `loadBrief()`: INDEX (≤30) + active slice; total ≤ ~80 lines or it truncates with notice.
- `matchIndex(event)`: exact symbol/file match against INDEX; returns 1-line hint or `undefined` — never content, never fuzzy.
- `captureFailure(event, ledger)`: failures only, 20-line truncation, ledger-guarded.
- `snapshotHandoff(event, ledger)`: branch + `ctx.vcs.status()` + pending; idempotent per session.

## Setup / dev

- Local path: `"plugins": ["./plugins/memory"]` or drop-in `.opencode/plugins/memory/`; `opencode plugin list` to verify; `touch` + `opencode service restart` on reload issues.
- First run generates templates + commented config (≤5 options).

## Test list (pre-code acceptance)

Budget enforcement on every write path; ledger idempotency across restart/replay; injection ≤ cap; compaction preserves priors without custom trigger; nested-AGENTS.md caveat covered (memory outside nested files); redaction blocks secrets fixtures.
