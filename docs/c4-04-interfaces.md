# Supplementary Spec A — Interface and Contract Specs

**Status:** proposed. **Sources:** Synthesized Report §4.6; V2 docs `/v2/docs/build/plugins/` (tool/command/hook shapes). (Numbered `c4-04` for sequence; not a C4 core level — see `c4-06-code.md` note.)

## `memory_recall` tool

- Input: `{ "file": "INDEX.md" | "activeContext.md" | "decisions.md" | "architecture.md" | "style.md" | "issues.md" | "handoffs/<name>.md" }` (required).
- Output: file content truncated to cap with a truncation notice; error on unknown file (never list the filesystem).
- Description (normative, doubles as retrieval policy): "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone."

## `/memory-review` command

- Invocation: `/memory-review [scope]`. Behavior: read INDEX + scratchpad, propose promotions into `decisions.md` / `architecture.md` / `style.md` / `issues.md` (target file, exact lines, cap check, redaction check), ask approval, write only approved lines. Never writes durable files without approval. Also validates direct manual edits to `issues.md`.

## Hook contracts

- `prompt`: sole injector of `INDEX.md` content (capped) to the current prompt only; pure transform, no side effects (V2 runs hooks once at admission; concurrent resubmissions may re-run — stay idempotent). Dedup guard: skip if an `INDEX.md` attachment is already present. `AGENTS.md` carries protocol+links only, never content, so no double injection.
- `context`: push brief (capped) + at most one hint line on exact INDEX match; no content injection.
- `compaction`: shape-guarded — if `event.system` exists, push priors (capped + redacted); always handle `event.result` (set it to record the summary when supported, else save the produced summary as a `handoffs/` file); never change model/threshold/trigger.

## File contracts

See `c4-05-data-model.md` for field schemas. Universal rules: UTF-8 markdown, caps enforced on write, secrets/`<private>` stripped, `decisions.md` append-only and `handoffs/` immutable; `architecture.md`/`style.md`/`issues.md`/`activeContext.md` are review-gated rewrites or rotation (git blame preserves lineage).
