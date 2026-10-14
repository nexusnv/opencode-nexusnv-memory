# C4 Level 4 — Interface and Contract Specs

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/` (tool/command/hook shapes).

## `memory_recall` tool

- Input: `{ "file": "INDEX.md" | "activeContext.md" | "decisions.md" | "architecture.md" | "style.md" | "issues.md" | "handoffs/<name>.md" }` (required).
- Output: file content truncated to cap with a truncation notice; error on unknown file (never list the filesystem).
- Description (normative, doubles as retrieval policy): "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone."

## `/memory-review` command

- Invocation: `/memory-review [scope]`. Behavior: read INDEX + scratchpad, propose promotions (target file, exact lines, cap check), ask approval, write only approved lines. Never writes durable files without approval.

## Hook contracts

- `prompt`: attach `INDEX.md` (capped) to the current prompt only; pure transform, no side effects (V2 runs hooks once at admission; concurrent resubmissions may re-run — stay idempotent).
- `context`: push brief (capped) + at most one hint line on exact INDEX match; no content injection.
- `compaction`: push priors (capped); optionally set `event.result` to record the summary; never change model/threshold/trigger.

## File contracts

See `c4-05-data-model.md` for field schemas. Universal rules: UTF-8 markdown, caps enforced on write, secrets/`<private>` stripped, append-only for `decisions.md` and `handoffs/`.
