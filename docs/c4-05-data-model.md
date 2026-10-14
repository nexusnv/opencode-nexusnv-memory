# C4 Level 5 — Data Model (file schemas are the model; no database)

**Status:** proposed. **Sources:** Synthesized Report §§4.1–4.5, 4.8.

## Files

| File | Fields | Cap |
|---|---|---|
| `INDEX.md` | `topic → file:section` lines, ≤30 | 30 lines |
| `activeContext.md` | goal / pending / next / known-errors (scratchpad, rotating) | 60 lines |
| `decisions.md` | `id \| date \| status (active/superseded) \| touches[] \| decision \| why \| rejected \| supersedes[]`, append-only | 60 lines active |
| `architecture.md` | contracts, sibling implementations, style lock | 60 lines |
| `style.md` | independently quotable rule statements | 60 lines |
| `issues.md` | one line each: todo/doing/done + issue ref | 60 lines |
| `handoffs/YYYY-MM-DD-HHmm.md` | branch, open changes, completed, pending, next; immutable | per file 60 lines |
| Ledger (`ctx.storage`) | `seen[]`, attempt timestamps, 30s retry window | bounded |

## States and retention matrix

States: scratchpad → durable → archived (git). Retention = reachability: active (retain + injectable) / causal (retain, follow-on-demand) / conditional (INDEX one-liner) / archived (`handoffs/archive/`, greppable, never injected). Reachable decisions are decay-exempt; age-based forgetting touches only unreachable episodic notes.

## Budgets

Total auto-injected ≤ ~80 lines (~1.5k tokens). Overflow → `handoffs/`, never the prompt. Enforcement point: every write path (`readCapped`, loaders, hook payloads).
