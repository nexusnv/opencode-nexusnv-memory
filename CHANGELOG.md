# Changelog

## 0.1.0 (P1-T1, 2026-10-15)

- Scaffold the `opencode-nexusnv-memory` plugin package: manifest (`@opencode/plugin` pinned exact `2.0.29`), strict `tsconfig`, wiring-only `Plugin.define({ id: "memory", setup })` entrypoint with a single `AbortController`, a `registrations` array, and async cleanup (abort + `dispose()`).
- Add `src/config.ts`: exactly 5 optional options (`indexLines=30`, `fileLines=60`, `injectBudgetLines=80`, `captureFailures=true`, `snapshotThrottleMinutes=10`); invalid values warn once and fall back to defaults, never throw.
- Add `src/templates.ts`: six-file scaffolds + `handoffs/` (+ archive dir), commented ≤5-option snippet, mandatory `memory_write → ask` permissions snippet, and the `AGENTS.md` protocol block text.
- Ship `agents/memory-manager.md` (read-only: leading `* → deny`, then `read`/`glob`/`grep → allow` only; proposal-only body) and the optional file-based `commands/memory-review.md` stub (plugin command is normative).
- Docs: README install matrices (drop-in vs package, `.opencode/` vs root paths, merge order, `plugin list` verify, reload guidance), budgets, and uninstall; supported OpenCode range `2.0.x` (`@opencode/plugin 2.0.29`).

Supported OpenCode range: `2.0.x` (built and type-checked against `@opencode/plugin 2.0.29`).
