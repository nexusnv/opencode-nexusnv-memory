# ADR-0009: Explicit forget and opt-in handoff GC

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** project maintainers
- **Related:** ADR-0005 (reachability), ADR-0006 (fixed root/five options), ADR-0007 (untrusted memory), ADR-0010 (cross-process safety)
- **Research:** `docs/2026-10-20-tier3-context-lifecycle-concurrency-research.md` §§5.1–5.7

## Context

US-22 asks for explicit forget/purge; the implementation had only Known-Errors rotation and no way to remove an active line. US-23 (TTL/decay) remains deferred. The memory files are human-owned git-backed markdown, so deletion must preserve lineage and must not become a model-callable destructive primitive. A local `git rm` is always available; the plugin should not pretend to offer secure erasure.

## Decision

1. **User-invoked commands only.** Add `/memory-forget` and `/memory-gc` as plugin commands. Do not add a `memory_forget`, `memory_delete`, or `memory_gc` tool. Do not add a sixth config option; all knobs are command flags.
2. **Dry-run by default.** Both commands render a deterministic preview and require `--confirm` for writes/deletes. A single typo cannot delete memory.
3. **Forget semantics by file.**
   - `INDEX.md`, `activeContext.md`, `architecture.md`, `style.md`, `issues.md`: dry-run, per-unit `memory_write` permission assert, archive removed text, then rewrite the active file through the capped writer. `--line`, literal case-insensitive `--match`, and `--all` selectors are supported. A selection inside `## Known errors` expands to the whole block so a captured detail cannot be half-removed; selecting the heading itself is rejected because removing only the heading would leave raw detail without the marker `loadBrief` uses to summarise it. The brief also treats `source:tool` blocks as errors when the heading is already missing.
   - `decisions.md`: rejected. It is append-only; add a superseding entry through `/memory-review`.
   - `handoffs/`: immutable; rejected. Root snapshots are eligible only through `/memory-gc`.
   - `handoffs/archive/`: never rewritten or purged by these commands. Archive purge is explicitly out of scope.
4. **Archive before remove.** Removed text is copied to `handoffs/archive/forgotten-<UTC stamp>-<random>.md` with a header containing file, time, reason, selector, and a fixed warning. Archive content is redacted and is data-only, never instructions. Archive files are recall-only and never auto-injected.
5. **INDEX is not inferred.** Removing a line from `architecture.md` does not prove which INDEX row is stale. The command warns and the user removes pointers explicitly with `/memory-forget INDEX.md --line N --confirm`. This is deliberately conservative; silently deleting INDEX rows would corrupt the map.
6. **Per-unit approval.** Every forget unit (single line, Known-Errors block, or whole-file purge) gets one `ctx.permission.assert({ action: "memory_write", ... })` with the file, line range, source, reason, and redacted text. The first deny aborts the whole operation before any archive/active write. A `source:user` line is still approved; the command does not infer trust.
7. **Two-phase application.** Plan under a short lock, release, ask the human, then re-lock, re-plan, and compare. If the file changed while approvals were pending, abort and ask for a fresh dry-run. The write lock is never held across a human prompt.
8. **Handoff GC.** `/memory-gc` targets root `handoffs/*.md` only. Policy is `--older-than DAYS` and/or `--keep N`; both set means intersection (older than the age cutoff AND outside the newest N). A single batch approval covers the candidate list. After approval the set is re-planned under the write lock and the batch aborts if it changed. Approval is by path name; handoffs are immutable, so a same-name content replacement is outside the supported contract. `handoffs/archive/` is never touched. The command always warns that deletion is irreversible on this machine and that untracked snapshots are not recoverable from git. No automatic sweep, no TTL, no background job.
9. **Status notice.** A successful forget increments the transient `<projectID>/notice.forgotten` storage notice (not a metric). The next prompt status line reports that the operation happened, that content is archived, and that git history may retain it. GC does not add a notice.
10. **Honest naming.** This is logical forgetting, not physical secure erasure. Git history, backups, clones, and editor caches may retain content. Users must rotate exposed secrets. The command previews/results and README state this substance explicitly; the prompt-tail status notice says that the operation was applied, that the removed lines are recallable, that git history may retain them, and that `INDEX.md` pointers should be reviewed (wording varies by surface).

## Consequences

- The user gains a safe, auditable removal path without giving the model a delete tool.
- Removal is two-step and per-unit; bulk purge is possible only with `--all --confirm` and remains archive-before-remove.
- Archive and git history still require the user's own retention policy; the plugin cannot guarantee erasure.
- `INDEX.md` cleanup is manual by design; the status/preview text names the exact follow-up command.
- No new metric name, no new config option, and no change to the fixed `.opencode/memory` root.
