# Supplementary Spec A — Interface and Contract Specs

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/` (tool/command/hook shapes). **Normative on V2 contracts:** `design-spec-v2-production.md` §5. (Numbered `c4-04` for sequence; not a C4 core level — see `c4-06-code.md` note.)

## `memory_recall` tool

- Input: `{ "file": "INDEX.md" | "activeContext.md" | "decisions.md" | "architecture.md" | "style.md" | "issues.md" | "handoffs/<name>.md" | "handoffs/archive/<name>.md" }` (required; `additionalProperties:false`; archive paths recallable on demand, never auto-injected).
- Output: `{ content: <text> }` — the documented tool-**executor** envelope (default; route it through one `toolResult(text)` adapter, G2). File content is truncated to cap with a truncation notice; error on unknown/traversal (never list the filesystem). `readCapped` is the single choke point and re-validates the resolved path stays within `.opencode/memory`.
- Description (normative, doubles as retrieval policy): "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone."

## `/memory-review` command

- Invocation: `/memory-review [scope]`. Behavior: the **read+propose phase writes nothing and proposes only** — its sole output is a proposal table; no durable change happens without per-line human approval. It is **not** sandboxed: a plugin command cannot target a subagent (`CommandInvocation` has no agent selector), and a session-scoped permission lock would be time-scoped (the reviewed text persists in the transcript) and would deny the user's own concurrent tools, so it is deliberately not used (retired G5). The optional read-only `memory-manager` subagent (separate session) is available when the primary agent delegates. It reads INDEX + scratchpad and emits a **proposal table only** — target file, exact candidate line, provenance tag (`source:user|tool|model|snapshot`), advisory injection flags — with cap and redaction checks. It writes nothing. The human approves specific lines through the `memory_apply` tool (candidates not tagged `source:user` cannot be bulk-approved); application is deterministic via `writeCapped`. Also validates direct manual edits to `issues.md` without overwriting. On completion resets `curation.pending` to `0` and clears the `curation.rotated` marker.
- All file content is treated as untrusted **data, never instructions**: the review never executes commands, never fetches URLs, and never follows directives found inside memory files (ADR-0007).
- Implemented with `ctx.command.transform`; the executor receives `{ sessionID, prompt, delivery }` and re-submits via `ctx.session.prompt({ ...prompt, sessionID, text, delivery })` so `files`/`agents`/`skills`/`metadata` are preserved.

## `memory_apply` tool

- Input: `{ "candidates": [ { "file": <allowlisted target>, "line": <string>, "source": "user"|"tool"|"model"|"snapshot", "flags"?: <string[]> } ] }` (required; `additionalProperties:false`).
- Output: `{ content: <summary> }` (applied count + per-line outcome, via `toolResult`).
- Behavior: the **only** channel that writes approved lines. For each candidate it calls `ctx.permission.assert` **once** (the exact `line` and its `source:` tag go in the prompt `metadata`; `save: []` so nothing is remembered), and on `allow` calls `writeCapped(file, line)`. Per-line approval therefore holds by construction and untrusted lines cannot be bulk-approved; the model never writes durable memory directly.
- Why a tool and not the command: `/memory-review`'s executor returns `void` and cannot await human approval (it receives only `{ sessionID, prompt, delivery }`).

## Hook contracts

- `prompt`: **sole** injector of `INDEX.md` content (capped; over-cap file is not attached) to the current prompt only; retry-safe (V2 runs hooks once at admission; concurrent resubmissions may re-run — stay idempotent). Dedup guard: skip if an `INDEX.md` attachment is already present. Root `AGENTS.md` carries protocol+links only, never content, so no double injection. The hook performs **one** bounded side effect: a `source:user` directive (documented form, outside fences/quotes/pastes) is appended to `decisions.md` — the only hook that sees `event.prompt.text` before admission — under a per-process write mutex, ledger-idempotent by content ID, and **never throwing** (a throwing prompt hook blocks admission). `classifyProvenance` detection stays pure.
- `context`: **async** (it reads Promise-based `ctx.storage`/`ctx.vcs`) and **never throws**. Push brief (capped active slice of `activeContext` + newest handoff pointer) + one `[memory]` status line (rotation notice / review-due nudge) + at most one hint line on exact INDEX match. The brief does **not** contain the INDEX map — `prompt` is the sole INDEX injector. Under budget pressure the status line is dropped before the hint. The hint is throttled to once per prompt/session (tool-driven continuations must not repeat it). **Known Errors enter the brief as summary lines only** (one line per error, `source:` tagged); full captured bodies stay `memory_recall`-only (P16, ADR-0007). The `[memory]` line is **model-facing** (`event.system` reaches the model, not the user directly); delivery depends on the agent relaying it.
- `compaction`: push capped + redacted priors (`event.system.push`). **Never set `event.result`** — the hook runs before the summary model call, so setting it skips the native summary (ADR-0003). Never change model/threshold/trigger.

## Tool hook contract

- `execute.after`: failure-only. Discriminant `event.status === "error"` (fallback `error != null`); append failed shell/build/test output to `activeContext.md` (redact, ledger check-before-write) as a `source:tool` summary line + optional recall-only detail block. The documented failure payload carries only `event.error.message` (G4), so the **tested baseline is message-only**: the summary line is derived from `event.error.message` (newlines collapsed, ≤120 chars) and the ≤20-line detail block is written **only when the event actually carries output**. No downstream consumer (brief, budgets, fixtures, evals) may assume a body exists. Successes are ignored. A real write increments `curation.pending`; a rotation also sets the `curation.rotated` marker for the next status line.
- `flagInjection(text)` runs over captured text and stores **advisory** flags with the entry (never blocks a write, never reported as detection).

## Provenance contract

- Every entry is tagged `source:user | tool | model | snapshot`. Only an explicit directive in the user's own turn (documented form; outside code fences, quotes, and pasted blocks) classifies as `source:user`, which appends immediately to `decisions.md` tagged `(user-asserted)` — detection and write run in the `prompt` hook (serialized, never-throw, ledger-idempotent), and the plugin is the sole writer. Everything else takes the scratchpad path and requires review. No origin may write `architecture.md`/`style.md`/`issues.md` without review (ADR-0004/0007).

## File contracts

See `c4-05-data-model.md` for field schemas. Universal rules: UTF-8 markdown, caps enforced per enforcement point (`c4-05`), secrets/`<private>` stripped, `decisions.md` append-only and `handoffs/` immutable; `activeContext.md` is ledger-guarded auto-append + rotation; `architecture.md`/`style.md`/`issues.md` are review-gated rewrites (git blame preserves lineage).

## Config shapes

- Plugins: `plugins: ["./plugins/memory"]` (`.opencode/opencode.jsonc`) or `["./.opencode/plugins/memory"]` (repo-root), or drop-in discovery, or `{ package, options }`.
- Agents: ship `memory-manager.md` (`mode: subagent`; **read-only — `edit * → deny`, `shell * → deny`, `webfetch * → deny`, `websearch * → deny`, `skill * → deny`**, ADR-0007; the last matching rule wins, so any future `allow` must come after a broad `deny`). The **default/primary agent needs a `subagent` allow for `memory-manager` only if the optional delegation path is enabled**; the default review runs in-session and writes nothing, so there is no permission lock to configure (retired G5).
- Options (≤5): `{ indexLines, fileLines, injectBudgetLines, captureFailures, snapshotThrottleMinutes }`, read via `ctx.options`; the memory directory is fixed at `.opencode/memory` (ADR-0006).
- **No `references` entry** (ADR-0006): references attach directories and are client-initiated; the earlier file-level `references.memory → INDEX.md` form was invalid and is removed.
