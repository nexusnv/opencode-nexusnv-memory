# ADR-0004 — Idempotent capture (ledger) + human-approved promotion; no silent durable writes

**Status:** accepted. **Date:** 2026-10-15.

## Context

Supermemory #106: a timed-out capture batch (guarded only by an in-memory set) was re-POSTed on every later event and at session end — one fact stored 55×. The surveyed alternative is per-turn LLM extraction with ADD/UPDATE/DELETE/NOOP resolution, which adds cost, latency, and drift surface.

## Decision

- Capture is zero-LLM and failure-/boundary-only (failed shell/build/test truncated to 20 lines and redacted; content-hash-guarded idle snapshots; explicit `remember`). Every write passes a persisted ledger (`ctx.storage`, never in-memory alone): check-before-write on content ID, persisted attempts, retry only inside ~30s. Restarts and replays are no-ops.
- Scratchpad (`activeContext.md`) is append-until-60 during work, then rotates the oldest Known-Errors block to `handoffs/archive/` with the rotation announced on a real channel (one `[memory]` status line from the `context` hook — see design-spec §5.7). The path to the capped durable files (`architecture.md`, `style.md`, `issues.md`) is `/memory-review`: propose, human approves, then write. The `memory-manager` subagent participates **read-only** — it proposes and never writes (ADR-0007). `decisions.md` is the append-only exception: a `source:user` directive writes it directly (see *Revision* below). `issues.md` accepts direct manual edits (one line per issue) and is validated — not overwritten — by `/memory-review` (format/cap/redaction check). Because forgetting to review would otherwise degrade memory silently, the same status line nudges at ≥5 uncurated captures; it never promotes content itself.

## Consequences

- Positive: no duplicates across timeouts/restarts; no per-turn LLM cost; durable files stay trustworthy because a human gated every line.
- Negative: durable memory lags real time until review; accepted — scratchpad + handoffs cover the gap, and staleness beats corruption.

## Revision (2026-10-15) — provenance gate

**Problem.** The original rule — *everything* reaches durable memory only via `/memory-review` — gated content by *what it is*, not by *who asserted it*. So when the user explicitly said "remember that the minimum supported PHP version is 8.2", the plugin wrote it to the scratchpad and then asked the user to approve their own instruction in a second cycle. That is redundant friction, and it is the friction that leads people to stop reviewing at all.

**Revision.** The gate now keys on **provenance**:

- **`source:user`** — an explicit directive in the user's own turn, in the documented form (and *not* inside a code fence, quotation, or pasted block) — **is** the human approval. It appends immediately to the append-only `decisions.md`, tagged `(user-asserted)`, redacted and ledger-deduped. No second cycle.
- **`source:tool` / `model` / `snapshot`** — captured output, model notes, idle snapshots — keep the original path: scratchpad → `/memory-review`, never auto-promoted.
- **Any origin → `architecture.md` / `style.md` / `issues.md`** — always review-gated. These are the capped, always-quotable rule files; the fast path never touches them.

**Why the fast path is bounded this way.** `decisions.md` is append-only and unbounded, so a misclassification cannot corrupt a curated file, displace a rule, or trip a cap — it is also retractable, and it resurfaces at the next review. A wrong-but-append-only decision line is a cheap, visible error; a wrong style rule injected every session is not.

**Still not gated away:** "no silent durable writes" remains true. A `source:user` write is not silent — the user asked for it, in writing, in the current turn.

See ADR-0007 for the containment half (untrusted content, sandboxed review) and design-spec §5.11.
