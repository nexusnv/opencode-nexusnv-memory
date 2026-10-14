# ADR-0005 — Reachability retention + append-only lineage + tell-tale retrieval

**Status:** accepted. **Date:** 2026-10-15.

## Context

Long-past "why" (e.g. enum naming from project inception) is invisible in current code. Age-based forgetting (30d TTL, decay curves) would delete causal history; auto-injecting history bloats context (rot); per-turn classifiers add cost.

## Decision

- **Retention = reachability, not age.** `decisions.md` entries carry `status`, `touches[]`, `supersedes[]`. Active entries stay; causal entries (e.g. `c` behind live `d`/`e`) are retained one hop behind the present; unreferenced entries compact to one INDEX line; removed entries leave active files for `handoffs/archive/` but persist in git. Reachable decisions are exempt from decay; age-based forgetting applies only to unreachable episodic notes.
- **Lineage is append-only.** Corrections are new entries with `Supersedes` links, never edits — no reconstructive drift; summaries are disposable handoffs, never memory (§4.8).
- **Retrieval is a tell-tale, not an injection.** Standing directive (~10 lines, always on) + `memory_recall` description as retrieval policy + one deterministic hint line on exact INDEX match only. Full text enters context solely when the model peeks (one capped read, then stop).

## Consequences

- Positive: inception reasoning survives and is findable in two capped reads; constant ~13-line overhead otherwise; no embeddings, no classifier, no bloat.
- Negative: recall depends on INDEX accuracy and symbol naming; accepted — enforced by budgets and the review gate, both cheap and inspectable.
