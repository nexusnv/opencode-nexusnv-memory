# ADR-0010: Same-host cross-process write safety

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** project maintainers
- **Related:** ADR-0005 (append-only lineage), ADR-0006 (fixed root), ADR-0009 (forget/GC)
- **Research:** `docs/2026-10-20-tier3-context-lifecycle-concurrency-research.md` §§6.1–6.6

## Context

The pre-E14 `withWriteLock` is a per-process promise chain. Two OpenCode host processes against the same project can interleave `updateCapped` read-modify-write cycles and lose appends. Direct `writeFile` calls can expose a truncated/partial file to a reader. The fixed memory root makes cross-process contention plausible whenever a user runs two hosts, a host plus a script, or two workspace windows against the same checkout.

## Decision

Use one root-level lock plus atomic publish, with a same-host contract.

1. **Lock file.** `<root>/.write.lock` contains `<pid>\n`. It is not a memory file, is not allowlisted, and is never auto-injected. Every memory-file write body acquires it.
2. **Acquire.** Create with `wx`. If it exists, read the PID. A live PID means wait, bounded to 5 s (2–5 s contract) with a 25 ms poll. On timeout, fail with `[memory] another OpenCode process is writing memory (...)`, not a silent dropped write.
3. **Stale takeover.** If the PID is gone (`process.kill(pid, 0)` → `ESRCH`; `EPERM` counts as alive), create `<root>/.write.lock.claim` with `wx`, re-read the lock, re-probe, remove only the same stale record, remove the claim, and retry. A malformed/empty lock is recoverable after a 2 s grace period based on mtime. A crashed holder is recovered by the next writer.
4. **Release.** Remove only a lock whose PID is ours. Release in `finally`; a release failure is best-effort and the next writer recovers.
5. **Atomic publish and containment.** Normal overwrite: same-directory temp file + `rename`. New file / handoff: same-directory temp + `link` to the final name (exclusive, no overwrite). Readers see the old complete file or the new complete file, never a partial write. Temp files are named `.tmp-*`, are not allowlisted, and are removed on success/failure. Before `mkdir`/publish/delete, existing ancestors are `lstat`ed and their real paths must stay under `realpath(root)`; a symlinked parent that resolves outside the root is rejected. Handoff/archive paths require the canonical parent to be exactly `root/handoffs` or `root/handoffs/archive`, so in-root aliases such as `handoffs -> .` are rejected. Deletion uses the same contained-parent check.
6. **Transaction boundary.** Bulk operations (rotation archive + active rewrite, forget archive + active rewrite) run under one lock. Unlocked internals (`writeRedactedCapped`, `publishExclusive`) are private; the public transaction API is `withCappedTransaction`. A human permission prompt must not hold the lock; two-phase plan → approve → re-plan is required.
7. **Scope.** Supported: one host, one PID namespace, a local filesystem. Not supported or not claimed: NFS/SMB, multiple hosts, containers sharing a volume without a shared PID namespace, PID reuse by an unrelated process, or power-loss durability (`fsync` is not performed). These limits are documented in README and the spec.
8. **No option.** The lock path, timeout, poll, and grace period are fixed constants. This preserves ADR-0006's five-option cap and avoids a concurrency knob users can misconfigure.
9. **Ledger/storage is out of scope.** `ctx.storage` is plugin-scoped and host-managed; this ADR covers markdown files only. The in-process storage chain remains.

## Consequences

- Concurrent appends from two host processes no longer lose lines.
- A reader never observes a partial active/handoff file.
- A live writer makes the second writer wait briefly, then fail clearly; retry is safe.
- The implementation uses hard links, which local POSIX filesystems support; unsupported filesystems fail the exclusive publish rather than silently overwriting.
- No fsync means a machine crash can still lose the newest write; the old or new complete file is visible, never a torn one.
