# Supplementary Spec B — Data Model (file schemas are the model; no database)

**Status:** proposed. **Sources:** Synthesized Report §§4.1–4.5, 4.8. **Normative on V2 contracts:** `design-spec-v2-production.md` §6. (Numbered `c4-05` for sequence; not a C4 core level — C4 has four levels; see `c4-06-code.md` note.)

## Files

| File | Fields | Cap |
|---|---|---|
| `INDEX.md` | `topic → file:section` lines, ≤30 | 30 lines |
| `activeContext.md` | goal / pending / next / known-errors (scratchpad: append-until-60, then rotate oldest Known-Errors block to `handoffs/archive/`; the rotation is announced once via the `[memory]` status line). Known Errors are `summary line (source:<origin>)` + indented **recall-only** detail block (≤20 raw lines); only summary lines are injectable | 60 lines |
| `decisions.md` | `id \| date \| status (active/superseded) \| source \| touches[] \| decision \| why \| rejected \| supersedes[]`, append-only (corrections = new entries, never edits); `source:user` rows are tagged `(user-asserted)` | 60 lines injectable suffix; full log + git retains everything |
| `architecture.md` | contracts, sibling implementations, style-lock pointer (review-gated rewrite; rule text lives in `style.md`) | 60 lines |
| `style.md` | independently quotable rule statements (review-gated rewrite; sole owner of rule text) | 60 lines |
| `issues.md` | one line each: todo/doing/done + issue ref (manual + `/memory-review`-validated) | 60 lines |
| `handoffs/YYYY-MM-DD-HHmm.md` | branch, open changes, completed, pending, next; immutable; content-hash-guarded (same content → no new file); newest wins | per file 60 lines |
| `handoffs/archive/<name>.md` | retired durable lines + rotated scratchpad blocks; recallable on demand via `memory_recall`, never auto-injected | per file 60 lines |
| Ledger (`ctx.storage`) | `seen/<contentID>` (presence = seen) + `attempt/<contentID>` (timestamp), plus `curation.pending` (uncurated count) and `curation.rotated` (transient marker); 30s retry window; persisted, never in-memory alone; keys namespaced per project (`<projectID>/…`, `ctx.storage` is plugin-scoped); single-flight per content ID (the API has no CAS), pruned via `scan({prefix})` to ≤500 entries | bounded |

## States and retention matrix

States: scratchpad → durable → archived (git). Retention = reachability: active (retain + injectable suffix) / causal (retain, follow-on-demand) / conditional (INDEX one-liner) / archived (`handoffs/archive/` for retired lines, recallable on demand via `memory_recall`, never auto-injected; session snapshots stay at `handoffs/` root). Reachable decisions are decay-exempt; age-based forgetting touches only unreachable episodic notes.

## Budgets

Auto-inject payload (prompt `INDEX.md` attach + context brief + status line + hint): `INDEX ≤30 + brief ≤48 + status ≤1 + hint ≤1` (~1.5k tokens per model call, excludes static root `AGENTS.md` directive ~10 lines + tool description ~3 lines). `INDEX` attaches once per prompt; the brief/hint/status are re-emitted per model call, so session-total = per-prompt × model steps (the hint is throttled to once per prompt/session). Content overflow → `handoffs/archive/`; session snapshots → `handoffs/` root; never the prompt. The status line carries the rotation notice and the review-due nudge (≥5 uncurated captures) so uncurated memory is surfaced — but it is **model-facing** (`event.system`), so the agent relays it rather than the user seeing it directly. **Captured command output never enters the payload as a body** — only the summary line (P16). Enforcement: write caps (`INDEX/activeContext/architecture/style/issues` on write) + read caps (`decisions` tail, handoffs via `readCapped`) + injection caps (hook payloads via loaders).

## Trust model

Every entry carries a provenance tag (`source:user | tool | model | snapshot`). Content from `tool`/`model`/`snapshot` is untrusted: it may be auto-injected (summary line only) but never promoted to a durable file without explicit per-line human approval, and untrusted candidates are excluded from bulk approval. The review's read+propose phase writes nothing and only produces a proposal table; every write is per-line approved through `memory_apply`. It is not sandboxed (a session permission lock is time-scoped and would deny the user's own tools — retired G5); the optional read-only `memory-manager` subagent confines poisoned text to a child session when used. Memory files are data, never instructions (ADR-0007).
