# Supplementary Spec B — Data Model (file schemas are the model; no database)

**Status:** proposed. **Sources:** Synthesized Report §§4.1–4.5, 4.8. (Numbered `c4-05` for sequence; not a C4 core level — C4 has four levels; see `c4-06-code.md` note.)

## Files

| File | Fields | Cap |
|---|---|---|
| `INDEX.md` | `topic → file:section` lines, ≤30 | 30 lines |
| `activeContext.md` | goal / pending / next / known-errors (scratchpad: append-until-60, then rotate oldest Known-Errors block to `handoffs/archive/` with notice) | 60 lines |
| `decisions.md` | `id \| date \| status (active/superseded) \| touches[] \| decision \| why \| rejected \| supersedes[]`, append-only (corrections = new entries, never edits) | 60 lines injectable suffix; full log + git retains everything |
| `architecture.md` | contracts, sibling implementations, style-lock pointer (review-gated rewrite; rule text lives in `style.md`) | 60 lines |
| `style.md` | independently quotable rule statements (review-gated rewrite; sole owner of rule text) | 60 lines |
| `issues.md` | one line each: todo/doing/done + issue ref (manual + `/memory-review`-validated) | 60 lines |
| `handoffs/YYYY-MM-DD-HHmm.md` | branch, open changes, completed, pending, next; immutable; content-hash-guarded (same content → no new file); newest wins | per file 60 lines |
| `handoffs/archive/<name>.md` | retired durable lines + rotated scratchpad blocks; recallable on demand via `memory_recall`, never auto-injected | per file 60 lines |
| Ledger (`ctx.storage`) | `seen[]` (capped, e.g. last 500), attempt timestamps, 30s retry window; persisted, never in-memory alone | bounded |

## States and retention matrix

States: scratchpad → durable → archived (git). Retention = reachability: active (retain + injectable suffix) / causal (retain, follow-on-demand) / conditional (INDEX one-liner) / archived (`handoffs/archive/` for retired lines, recallable on demand via `memory_recall`, never auto-injected; session snapshots stay at `handoffs/` root). Reachable decisions are decay-exempt; age-based forgetting touches only unreachable episodic notes.

## Budgets

Auto-inject payload (prompt `INDEX.md` attach + context brief + hint) ≤ ~80 lines (~1.5k tokens, excludes static root `AGENTS.md` directive ~10 lines + tool description ~3 lines). Content overflow → `handoffs/archive/`; session snapshots → `handoffs/` root; never the prompt. Enforcement: write caps (`INDEX/activeContext/architecture/style/issues` on write) + read caps (`decisions` tail, handoffs via `readCapped`) + injection caps (hook payloads via loaders).
