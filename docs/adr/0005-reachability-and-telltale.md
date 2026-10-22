# ADR-0005 — Reachability retention + append-only lineage + tell-tale retrieval

**Status:** accepted. **Date:** 2026-10-15.

## Context

Long-past "why" (e.g. enum naming from project inception) is invisible in current code. Age-based forgetting (30d TTL, decay curves) would delete causal history; auto-injecting history bloats context (rot); per-turn classifiers add cost.

## Decision

- **Retention = reachability, not age.** `decisions.md` entries carry `status`, `touches[]`, `supersedes[]`. Active entries stay ("60 lines active" = injectable suffix; full log + git retains everything); causal entries (e.g. `c` behind live `d`/`e`) are retained one hop behind the present; unreferenced entries compact to one INDEX line; removed entries leave active files for `handoffs/archive/` (session snapshots stay at `handoffs/` root) but persist in git. Reachable decisions are exempt from decay; age-based forgetting applies only to unreachable episodic notes.
- **Lineage is append-only where required.** `decisions.md` and `handoffs/` are append-only/immutable: corrections are new entries with `Supersedes` links, never edits — no reconstructive drift; summaries are disposable handoffs, never memory (§4.8). `architecture.md` / `style.md` / `issues.md` are review-gated rewrites with git blame as lineage.
- **Retrieval is a tell-tale, not an injection.** Standing directive (~10 lines, always on) + `memory_recall` description as retrieval policy + one deterministic hint line on exact INDEX match only. Full text enters context solely when the model peeks (one capped read, then stop).

## Consequences

- Positive: inception reasoning survives and is findable in two capped reads; overhead is bounded (static ~13 lines for the directive + tool description, plus a per-model-call payload only when content exists); no embeddings, no classifier, no bloat.
- Negative: recall depends on INDEX accuracy and symbol naming; accepted — enforced by budgets and the review gate, both cheap and inspectable.

## Revision 2026-10-20 — US-22 implementation

ADR-0009 implements explicit, user-invoked logical forget plus opt-in root-handoff GC. Reachability remains the retention model; there is still no automatic TTL/decay. Forgotten lines are copied to `handoffs/archive/` before removal, archive stays recall-only, `decisions.md` stays append-only, and handoffs stay immutable. Handoff GC deletes only root snapshots and never archive. Git history remains the restore path.
