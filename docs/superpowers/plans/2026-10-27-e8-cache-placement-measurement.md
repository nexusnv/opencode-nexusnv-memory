# E8 Cache-Placement Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether the E8-A prompt-tail notice placement preserves prefix-cache reuse better than the pre-E8 system placement on a prompt-caching provider, record the raw usage and the user-visible transcript verdict, and apply an explicit keep / attachment / E8-B / not-measurable decision with matching tests and docs.

**Architecture:** A dev-only Node harness creates two isolated OpenCode projects from the current `src/` and the pre-E8 source at `7629611^`, disables the handoff snapshot writer, denies skills/MCP so the model cannot wander, runs a two-prompt multi-tool session with `opencode run --standalone`, exports per-message token usage from `opencode session export`, and computes paired raw and baseline-adjusted cache metrics. The results go to a dated measurement doc; a pre-registered gate selects keep, attachment, or E8-B, and only the selected branch changes code/docs.

**Tech Stack:** Node.js 20+, OpenCode CLI 2.1.4, `opencode session export` JSON, Google Gemini 3.5 Flash Lite via `GEMINI_API_KEY` (Google AI Studio **free tier**, observed 15 requests/minute), Vitest 5, TypeScript 5.9, Prettier. No new runtime dependency.

**Branch:** `issue-22-e8-cache-placement` (already created from `origin/main` at `8a1f2bb`). `src/` is clean; no code or docs have been changed yet.

**Normative sources:**

- Issue #22: `E8: measure cache placement and decide the prompt-tail notice surface`.
- `docs/2026-10-20-e8-cache-placement-spike.md` — protocol and non-claims.
- `docs/2026-10-20-tier3-context-lifecycle-concurrency-research.md` §4 — E8 rationale, provider caching, E8-A/E8-B.
- `docs/design-spec-v2-production.md` §5.2 (placement), §9 (budget/eval language).
- `docs/adr/0002-agents-md-injection.md`, `0004-ledger-and-promotion.md`, `0007-untrusted-memory-content.md` — E8-A revisions.
- `src/prompt-notices.ts`, `src/index.ts`, `test/prompt-notices.test.ts`, `test/hooks.test.ts`.

**Non-goals:** production cache metrics (ADR-0008 freezes the 45-name vocabulary), changing line budgets without evidence, general context-budget redesign, or a billed-token savings claim. A free-tier account cannot produce a billed-cost claim; this plan measures token counts and cache fields only.

AGENTS.md instruction: prefer typed, framework-agnostic PHP, but this repository is TypeScript; follow the repository's existing TypeScript/Vitest conventions, `strict` typing, and the existing script style in `scripts/assert-pack.mjs`.

---

## 1. Why this plan exists

E8-A moved the volatile `[memory]` notices (newest-handoff pointer, status line, INDEX hint) from the per-model-call `context` system prefix to the canonical user prompt. The structural goal — a stable system prefix — is implemented, but no provider cache measurement was run. The spike doc explicitly says so and makes no billed-token claim.

The measurement must answer two different questions:

1. **Cache:** does the stable system prefix let the provider reuse the message-history prefix on later tool calls and on the next prompt, compared with pre-E8?
2. **Visibility:** what does the user actually see in the persisted prompt, and is up to three labelled lines acceptable?

A cache loss means the placement is not a win, and the issue's fallback (E8-B) or the attachment option wins. A cache-neutral result means the decision turns on trust/visibility: the stable prefix and user-data channel may still be worth keeping, but no savings claim is allowed. A cache win does not by itself justify the visibility; the user-text review is a separate, explicit gate.

### Tested starting point (historical context, not measurement evidence)

A draft harness was built and smoke-tested during plan preparation, but it lived only in `/tmp/opencode/e8-harness-draft.mjs` and is no longer present in this environment. Task 1 therefore specifies the harness from scratch. The draft's behavior and the plan-preparation findings below remain valid:

- it extracted two prompts and per-message assistant token rows from `opencode session export` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`);
- it prepared pre-E8 and E8-A projects from `git archive 7629611^ src` and the working-tree `src/`;
- it patched `capture.ts` in both copies to disable `snapshotIfDue` so the brief could not change mid-run;
- it ran two prompts, validated the tool calls, and rendered paired deltas;
- it passed a self-test, a dry run, and a complete pre-E8 end-to-end run.

Plan-preparation experiments added the following findings:

- `google/gemini-3.5-flash-lite` works through the OpenCode CLI and reports `cache.read` (for example, `cache.read: 12203` on a repeated 14k-token session).
- The Gemini key is **free tier**: a 429 error names `generate_content_free_tier_requests`, limit `15` requests per minute. Pacing and retry are mandatory.
- `opencode run --standalone` loads the project-local plugin on the first prompt (no warm-up needed) and, with an isolated `OPENCODE_CONFIG_DIR`/`XDG_CONFIG_HOME`, avoids the long-lived background server's stale project/plugin state.
- A project `policies` entry `{ "action": "integration.use", "resource": "skill:*", "effect": "deny" }` removes skills; the model then uses the `read` tool as instructed. Without it, Gemini sometimes invokes `using-superpowers`, which adds a call and confounds the comparison.
- A measurement-only load marker written at the start of the `prompt` hook (a directory named `.e8-plugin-loaded` under the project root) gives a deterministic "plugin is live" signal without changing the model request.
- A unique salt in `AGENTS.md`/`activeContext.md` and the unique project path reduce cross-session cache hits, but the provider still reports a large shared base-system-prefix hit on the first call. The analysis therefore reports **baseline-adjusted** cache reads as well as raw hit rates.

The plan's Task 1 is the authoritative harness specification; do not rely on a `/tmp` artifact.

---

## 2. Pre-registered measurement protocol

This section is fixed **before** the full run. Do not change the metrics, scenarios, or gate after seeing the results. If the harness has to change for a correctness reason, record the change and re-run all reps; do not cherry-pick runs.

### 2.1 Provider, model, and account tier

| Field              | Value                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider           | Google AI Studio / Gemini API (`google`)                                                                                                                      |
| Model              | `google/gemini-3.5-flash-lite`                                                                                                                                |
| Account tier       | **Free Tier** (evidence: 429 `generate_content_free_tier_requests`, limit 15 requests/minute)                                                                 |
| OpenCode           | 2.1.4                                                                                                                                                         |
| Credential         | `GEMINI_API_KEY` in the environment; never write it to the repo or the measurement doc                                                                        |
| Secondary provider | `opencode/deepseek-v4.1-flash-free` is rate-limited until roughly 2026-10-28; do not block the primary run on it. Record it as a follow-up, not a substitute. |

One provider is enough for the issue. Do not generalize the result to OpenAI/Anthropic/DeepSeek; record them as unmeasured.

**Run date:** the plan was authored 2026-10-27. Use the actual date of the full run. If it differs, name the measurement doc `docs/<YYYY-MM-DD>-e8-measurement.md` and substitute that path throughout this plan; record the actual date in the doc, the spike update, and the PR.

### 2.2 Variants and scenarios

| Variant  | Source                                        | Placement under test                                                                                                                |
| -------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pre-e8` | `git archive 7629611^ src`                    | Brief + status + hint + newest-handoff pointer in `event.system` on every model call; hint throttled to the first call of a prompt. |
| `e8-a`   | Working-tree `src/` at the measurement commit | Stable brief in `event.system`; pointer/status/hint appended once to the canonical prompt as ≤3 marker-guarded data lines.          |

| Scenario             | Fixture                                                          | What it exercises                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hint`               | `INDEX.md` 3 lines, one handoff, prompt mentions `auth-service`  | Within-turn churn: pre-E8's hint disappears on the continuation; E8-A keeps the prompt prefix append-only.                                           |
| `status`             | `INDEX.md` 31 lines (over the 30-line cap), one handoff, no hint | Status-line churn: pre-E8 consumes `indexOverCap` on the first call and the line disappears on later calls; E8-A puts the status in the prompt once. |
| `control` (optional) | Under-cap INDEX, no handoff                                      | Sanity check that the harness itself does not create notices. Not required for the decision; run only if the smoke run is ambiguous.                 |

Two prompts per session:

1. `prompt 1`: "Context: auth-service login. Use the read tool to read `<project>/alpha.txt`, then use the read tool to read `<project>/beta.txt`. Then answer in one sentence."
   - `hint` adds the auth-service phrase; `status` uses the same prompt without the phrase.
   - The prompt explicitly asks for `read`; the skill policy prevents the model from substituting a skill.
2. `prompt 2` (same session): "Reply with exactly: SECOND-DONE".

The measured session is new for each variant/rep. Do not reuse a session across variants.

### 2.3 Harness controls (must all hold)

- [ ] Each run uses a **unique project directory** containing the scenario fixture, a unique salt in `AGENTS.md` and `activeContext.md`, and a copy of exactly one variant's `src/*.ts`.
- [ ] The snapshot writer is disabled in **both** copies by inserting `if (true) return false; // E8 measurement: disable handoff writer` at the start of `snapshotIfDue` in `capture.ts`. This is a measurement control; disclose it in the doc. It does not change the notice placement under test.
- [ ] The measurement-only load marker (`.e8-plugin-loaded`) is created by the prompt hook in both copies. It is outside the model request and does not affect the prefix.
- [ ] `activeContext.md`, `INDEX.md`, and the handoff fixture are hashed before prompt 1 and after prompt 2. The hashes must match; if they do not, the run is invalid. (The status/hint ledger lives in `ctx.storage`, not in these files.)
- [ ] The project config denies skills and MCP: `policies: [{action:"integration.use",resource:"skill:*",effect:"deny"}, {action:"integration.use",resource:"mcp:*",effect:"deny"}]`. The model must use `read`.
- [ ] The project config denies `shell` and `edit`/`write` so the model cannot read files another way or mutate the fixture. Keep `read` allowed. The memory plugin's own write paths are not model tools.
- [ ] Every CLI call uses `opencode run --standalone`, `-m google/gemini-3.5-flash-lite`, `--format json`, `--auto`. The harness sets `OPENCODE_CONFIG_DIR=<out>/config/opencode` and `XDG_CONFIG_HOME=<out>/xdg` for the whole process, and creates both empty directories before the first call.
- [ ] Model calls are paced at least 6 seconds apart (global pacer across runs) to stay under the 15 RPM free-tier limit. On a 429/quota error, discard the attempt and retry the whole run with a fresh project and session (5 s/10 s/20 s/30 s backoff, max 4 retries), logging the retry; a discarded attempt is not a measurement.
- [ ] The harness rejects a run when the E8-A prompt has no notice marker (hint/status), the pre-E8 prompt has a marker, fewer than 2 assistant calls or fewer than 2 `read` tool parts occur, `alpha.txt`/`beta.txt` were not both read, a `skill`/`shell` tool part appears, the marker file is absent, or the brief hashes differ.
- [ ] The harness records the exact user prompt text for both prompts, the notice line count, the brief line count, and the raw per-call token rows.

### 2.4 Metrics

For each assistant call:

```
promptTokens = input + cache.read + cache.write
cacheHitRate = cache.read / promptTokens
uncachedTokens = input + cache.write
```

Per valid run:

- `prompt1First`: first assistant call of prompt 1.
- `prompt1Later`: all later assistant calls of prompt 1 (the tool continuations and final answer).
  - `laterCacheRead` = sum of `cache.read`.
  - `laterPromptTokens` = sum of `promptTokens`.
  - `laterCacheHitRate` = `laterCacheRead / laterPromptTokens`.
- `prompt2First`: first assistant call of prompt 2.
- `prompt1Total` / `prompt2Total`: sum of `promptTokens` for all calls in that prompt.
- `sessionTotal`: sum across all calls.
- **Baseline-adjusted** (removes the shared base-system-prefix hit that is constant across variants):
  - `p1LaterIncrementalRead = laterCacheRead − prompt1First.cacheRead × laterCallCount` (floored at 0 per call; report the raw subtraction too).
  - `p2FirstIncrementalRead = prompt2First.cacheRead − prompt1First.cacheRead` (floored at 0).
- `noticeLines`: number of `[memory]`/`[memory-hint]` lines in prompt 1's user text.
- `briefHashBefore` / `briefHashAfter`: SHA-256 of `activeContext.md` + `INDEX.md` + handoff files, in order.

Paired delta for each scenario/rep: `e8-a` minus `pre-e8`. Report medians and the count of positive/negative pairs; do not report a single best run.

Raw usage fields to keep in `summary.json` and the doc:

- `input`, `output`, `reasoning`, `cache.read`, `cache.write` per assistant call;
- `promptTokens`, `cacheHitRate`, `uncachedTokens`;
- the `model`, `providerID`, `variant`, and `tokens` fields from the export's `info` and each message;
- the OpenCode version, repo HEAD, pre-E8 ref, date/time, and account tier.

### 2.5 Validity gates

A pair is valid only when both runs are valid. A run is invalid if any control in §2.3 fails. The full run must produce at least **5 valid pairs** out of 6 (3 reps × 2 scenarios). If fewer, run 2 more reps (5 total) or record **not measurable**.

The smoke run (1 rep) is a harness check, not evidence. Never put smoke numbers in the decision table.

### 2.6 Pre-registered decision rule

Let `N` be the number of valid pairs in the run used for the decision. The primary 3-rep run expects `N = 6` (3 reps × 2 scenarios); the 5-rep rerun expects `N = 10`. The sign-count threshold is `T = ceil(2N/3)` — 4/6 for the primary run, 4/5 if one pair is invalid, and 7/10 for the 5-rep rerun. Report the actual `N` and `T`; never keep a `/6` denominator after a 5-rep rerun.

Pool the valid pairs across both scenarios for the medians and sign counts, and also report each scenario separately for the disagreement check. Define:

- `Δlater` = median over valid pairs of `(e8-a.laterCacheHitRate − pre-e8.laterCacheHitRate)`.
- `Δp2` = median over valid pairs of `(e8-a.prompt2First.cacheHitRate − pre-e8.prompt2First.cacheHitRate)`.
- `ΔlaterRead` = median over valid pairs of the baseline-adjusted later cache-read delta.
- `Δp2Read` = median over valid pairs of the baseline-adjusted prompt-2 cache-read delta.
- `positiveLater` / `negativeLater` = pooled pair counts by sign on `Δlater`; same for `positiveP2` / `negativeP2` on `Δp2`.

**Step 1 — validity.** If `N < 5`, the exports have no cache fields, or the `hint` and `status` scenarios still disagree in sign on the primary metric after the 5-rep rerun, record **not measurable** (issue #22 stays open/blocked). Do not pick a branch.

**Step 2 — cache verdict.** Apply the first matching row:

| Condition                                                | Cache verdict                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `Δlater ≥ +0.05`, `positiveLater ≥ T`, and `Δp2 ≥ −0.03` | **win** (within-turn cache supported)                                |
| `Δp2 ≥ +0.05`, `positiveP2 ≥ T`, and `Δlater ≥ −0.03`    | **win** (cross-prompt cache supported)                               |
| `abs(Δlater) ≤ 0.03` and `abs(Δp2) ≤ 0.03`               | **neutral** (no savings claim)                                       |
| `Δlater ≤ −0.05` and `negativeLater ≥ T`                 | **loss** (within-turn)                                               |
| `Δp2 ≤ −0.05` and `negativeP2 ≥ T`                       | **loss** (cross-prompt)                                              |
| anything else                                            | **ambiguous**: run the 5-rep protocol once; if still ambiguous, stop |

**Step 3 — UX gate.** Classify the prompt-tail block as accept, accept with a wording fix, or reject using the checklist below. The UX gate is a **veto**, not a tie-breaker.

**Step 4 — branch.** Apply exactly one row:

| Cache verdict  | UX verdict           | Decision                                                 |
| -------------- | -------------------- | -------------------------------------------------------- |
| win or neutral | accept / wording fix | **Keep E8-A** (Task 6)                                   |
| win or neutral | reject               | **Change to attachment** (Task 7), then re-measure       |
| loss           | accept / wording fix | **Change to E8-B** (Task 8), then re-measure             |
| loss           | reject               | **Change to attachment** (Task 7), then re-measure       |
| ambiguous      | —                    | **Not measurable** (Task 5 Step 7; issue #22 stays open) |

For a change branch, re-measure the candidate against **both** E8-A and pre-E8, then apply the adoption rule for the case that selected the branch:

- **Cache win/neutral + UX reject → attachment.** Adopt the attachment only if `Δlater(attach − e8-a) ≥ −0.05` and `Δp2(attach − e8-a) ≥ −0.05` (it must not materially regress either metric relative to E8-A).
- **Cache loss + any UX → E8-B or attachment.** Adopt the candidate only if it recovers the lost metric against pre-E8 by at least `+0.05` with at least `T` pairs positive on that comparison, and does not regress the other metric against E8-A by more than `0.05`:
  - within-turn loss: `Δlater(candidate − pre-e8) ≥ +0.05` with at least `T` positive pairs, and `Δp2(candidate − e8-a) ≥ −0.05`;
  - cross-prompt loss: `Δp2(candidate − pre-e8) ≥ +0.05` with at least `T` positive pairs, and `Δlater(candidate − e8-a) ≥ −0.05`.

If the candidate fails any bound, record the regression and leave issue #22 open with the evidence. Do not silently revert to pre-E8: revert is not one of issue #22's three options.

The UX checklist:

- **Accept** if the user's own text stays first and unmodified, the block is separated by a blank line, every line is visibly labelled (`[memory]` / `[memory-hint]`), the data-only suffix is present, the block is ≤3 lines, and a first-time user would not mistake it for their own instruction.
- **Accept with a wording fix** if the only objection is the visible HTML marker or a long handoff line. A wording fix is still a keep: update `PROMPT_NOTICES_MARKER`/labels and the tests, then re-run the smoke (not the full measurement unless the block length changes).
- **Reject** if the block reads as noise, an instruction, or a security prompt in the user's own message. Rejection forces a change even if the cache is better.

If the decision is **keep** but the UX gate says "accept with a wording fix", apply the wording fix in Task 6 and record it; the full measurement's placement is unchanged (only the marker/label bytes change).

### 2.7 "Not measurable" is a valid outcome

If the free-tier quota, provider outage, cache-field absence, or an ambiguous cache verdict after the 5-rep rerun prevents a decision, write "not measurable" in the doc, list what was attempted, and leave issue #22 open/blocked. Do not close on "CI has no credentials" or on a partial run. Do not claim a billed-token savings in any case; the account is free tier.

---

## 3. File structure

**Create**

- `scripts/e8-cache-measure.mjs` — dev-only measurement harness (Node, no deps). Not included in the npm package (`files` excludes `scripts/`; it stays a repo tool).
- `docs/2026-10-27-e8-measurement.md` — dated protocol, raw usage tables, paired deltas, limitations, UX verdict, decision, follow-ups.

**Modify (keep branch)**

- `docs/2026-10-20-e8-cache-placement-spike.md` — status update + link to the measurement; no new claim.
- `docs/design-spec-v2-production.md` §5.2 and §9 — explicit transcript-visibility acceptance and measurement note.
- `README.md` — budget/visibility note.
- `CHANGELOG.md` — Unreleased docs entry.
- `docs/adr/0002-agents-md-injection.md`, `0004-ledger-and-promotion.md`, `0007-untrusted-memory-content.md` — one measurement/decision note in each E8 revision.

**Modify (change branch only; one of)**

- Attachment branch: `src/prompt-notices.ts`, `src/index.ts`, `src/files.ts` (dedicated scratch writer), `test/prompt-notices.test.ts`, `test/hooks.test.ts`, `test/files.test.ts`.
- E8-B branch: `src/prompt-notices.ts`, `src/index.ts`, `test/prompt-notices.test.ts`, `test/hooks.test.ts`.
- The same spec/README/ADR/CHANGELOG files with the changed-placement wording.

**Not modified:** `package.json` (no new dependency), `src/config.ts` (no new option), `src/metrics.ts` (no new metric name), line budgets (no evidence to change them).

---

## 4. Tasks

### Task 1: Promote the tested draft into `scripts/e8-cache-measure.mjs`

**Files:**

- Create: `scripts/e8-cache-measure.mjs`

**Purpose:** Make the measurement reproducible and robust enough that a failed run is a provider/plugin failure, not a harness race.

- [ ] **Step 1: Create the harness skeleton from scratch**

The plan-preparation draft at `/tmp/opencode/e8-harness-draft.mjs` is **not** part of the repository and may not exist on the execution host (it is already absent in this environment). Do not depend on it. Create `scripts/e8-cache-measure.mjs` as a dev-only Node ESM script with no runtime dependency. The script is not a package entrypoint and is excluded from the npm package.

Use this structure; the steps below fill in the details:

```text
scripts/e8-cache-measure.mjs
  header comment (Step 13)
  imports: node:child_process (execFileSync, spawnSync), node:crypto (createHash),
           node:fs (existsSync), node:fs/promises (cp, mkdir, readFile, readdir, rm, writeFile),
           node:path (dirname, join, resolve), node:url (fileURLToPath)
  constants: REPO_ROOT, PRE_E8_REF = "7629611^", E8_A_REF = "8a1f2bb",
             DEFAULT_MODEL, DEFAULT_REPS, DEFAULT_SCENARIOS, ALL_SCENARIOS,
             VARIANTS, LOAD_MARKER, DEFAULT_PACE_MS
  CLI parsing: --self-test, --dry-run, --analyze <export>, --run, --out <dir>,
               --model, --reps, --scenarios, --variants, --compare <a>:<b>,
               --pace-ms, --max-retries, --attempts, --timeout-ms,
               --keep-projects, --help
  pure helpers: parseJsonLines, num, median, fmt, isQuotaError, isDirtySrc
  process helpers: git, assertCleanSrc, runCli, pace, exportSession
  variant prep: sourceFor, patchSnapshotDisabled, patchLoadMarker
  project prep: prepareProject + fixtures (below)
  runner: runPrompt, runOne, runMeasurement
  analyzer: analyzeExport, validateRun
  report: pairRuns, summarizeScenario, summarizePooled, buildReport, renderReport
  selfTest, dryRun, analyzeMode, main
```

`assertCleanSrc()` must be implemented in this task and called at the start of `runMeasurement`, before `sourceFor`, project preparation, or any provider call:

```js
function isDirtySrc(statusText) {
  return String(statusText).trim().length > 0;
}

function assertCleanSrc() {
  const status = git(["status", "--porcelain", "--", "src"]);
  if (isDirtySrc(status)) {
    throw new Error("src/ is dirty; commit or stash before measuring");
  }
}
```

`git(args)` runs `git -C REPO_ROOT ...`; `sourceFor(variant, dest)` must produce exactly one variant's plugin sources:

- `pre-e8`: `git archive --format=tar 7629611^ src`, extract into `dest`.
- `e8-a`: `git archive --format=tar 8a1f2bb src`, extract into `dest`.
- `e8-attach` / `e8-b`: copy the current working-tree `src/*.ts` into `dest` (only after `assertCleanSrc`).

OpenCode's server cannot load TypeScript plugins via its esbuild path
("Unterminated string literal" build error), so `sourceFor` compiles the
extracted `.ts` sources to plain JavaScript (into a `js/` subdirectory under
`dest`) using the project's local `tsc`, then patches the compiled `.js`
files. `prepareProject` copies the compiled `.js` files (not `.ts`) into
`.opencode/plugins/memory/`.

Patch both compiled variants:

- `capture.js`: insert `if (true) return false; // E8 measurement: disable handoff writer` immediately after the opening brace of `snapshotIfDue`.
- `index.js`: insert `await mkdir(join(projectRootOf(ctx), LOAD_MARKER), { recursive: true }).catch(() => {});` at the start of the prompt hook.

`prepareProject(projectDir, variantDir, scenario, salt)` must create:

- `.opencode/plugins/memory/` with the variant's compiled `.js` files;
- `.opencode/opencode.jsonc` (Step 6);
- `AGENTS.md` with `# E8 measurement fixture ${salt}` (Step 7);
- `.opencode/memory/activeContext.md` with `- run salt: ${salt}`;
- `.opencode/memory/INDEX.md`:
  - `hint`: 3 lines, including `- auth-service: src/auth.ts`;
  - `status`: 31 lines (heading + 30 entries), over the 30-line cap;
  - `control`: 3 lines, no auth-service entry;
- `.opencode/memory/handoffs/2026-10-26-120000-abcdef.md` with `# Handoff\n\n- branch: e8-measurement\n` (except `control`);
- `.opencode/memory/decisions.md`, `architecture.md`, `style.md`, `issues.md` with small fixed fixtures;
- `alpha.txt` and `beta.txt` in the project root.

`promptOne(scenario, projectDir)` returns the §2.2 prompt; `PROMPT_TWO` is `Reply with exactly: SECOND-DONE`.

The analyzer's `summary.json` contract (Task 4 reads it) is:

```text
runs[], failures[], attempts[], pairs[], pooled, byScenario, comparisons[],
comparisonErrors[], generatedAt, provider, model, opencodeVersion, repoHead,
accountTier, meta{generatedAt,date,provider,model,accountTier,opencodeVersion,
  repoHead,preE8Ref,e8ARef,variants,scenarios,reps,maxRetries,attempts,paceMs}
run: scenario, rep, variant, attempt, sessionID, projectDir, salt, model,
     requestedModel, exportModel, exportOutcome, exportInfoTokens, prompts[],
     prompt1Text, prompt2Text, prompt1Files, prompt2Files, calls[], prompt1Calls,
     prompt2Calls, prompt1ToolParts, prompt1ToolPartDetails, allToolParts,
     assistantMessageCount, tokenlessAssistantCount, assistantErrorCount,
     prompt1First, prompt1Later{calls,cacheRead,promptTokens,cacheHitRate,p1LaterIncrementalRead},
     prompt2First{p2FirstIncrementalRead}, prompt1Total, prompt2Total,
     sessionTotal{...,computed:true},
     notice{marker,label,hint,status,handoff,markerCount,hintCount,statusCount,handoffCount},
     noticeLines, prompt2Notice, prompt2NoticeLines, skillToolParts,
     briefHashBefore, briefHashAfter, briefHashMatch, validationErrors,
     validationNotChecked, validationStatus, validationComplete, rawPath
attempt: scenario, rep, variant, attempt, status(valid|invalid|error),
         sessionID, projectDir, errors[], rawPath?
pair: scenario, rep, pre, e8, deltaLaterHit, deltaLaterCacheRead,
      deltaLaterAdjustedRead, deltaPrompt2Hit, deltaPrompt2CacheRead,
      deltaPrompt2AdjustedRead
```

`summary.md` must render the full attempt history (including discarded
attempts) and must not print "No failed runs." when any attempt was discarded.
`runMeasurement` writes `summary.json` and `summary.md` under `--out`, plus one
raw export per run under `raw/`. `dryRun` prepares both variants and all
projects without calling the model, and prints `dry-run ok:
<scenario>/<variant>` for each.

Expected: `node scripts/e8-cache-measure.mjs --self-test` prints `self-test ok` after Step 12.

- [ ] **Step 2: Apply the provider/CLI defaults**

Change the top constants:

```js
const DEFAULT_MODEL = "google/gemini-3.5-flash-lite";
const DEFAULT_REPS = 3;
const DEFAULT_SCENARIOS = ["hint", "status"];
const ALL_SCENARIOS = ["hint", "status", "control"];
const VARIANTS = ["pre-e8", "e8-a"];
const LOAD_MARKER = ".e8-plugin-loaded";
const DEFAULT_PACE_MS = 6000;
```

Add CLI flags in `parseArgs`/`printHelp`:

```text
--variants <list>     Comma-separated variants (default: pre-e8,e8-a)
--compare <a>:<b>     Pairing to report; repeatable (default: pre-e8:e8-a)
--pace-ms <ms>       Minimum gap between model calls (default: 6000)
--max-retries <n>    Extra whole-run attempts after a quota error (default: 4)
--attempts <n>       Extra whole-run attempts after a validation failure (default: 3)
```

`--analyze <export>` must also require explicit `--variant <name>` and
`--scenario <name>`; `--project <dir>` is optional and only enables the
filesystem checks. Reject `e8-attach`/`e8-b`, duplicate variants/scenarios/
comparisons, `baseline === candidate`, and any comparison endpoint absent from
`--variants`.

- [ ] **Step 3: Run every CLI call through a private, isolated server**

`runCli` must inject the isolated config roots into the child environment:

```js
function runCli(args, options) {
  if (!options?.out) {
    throw new Error(
      "runCli requires options.out for the isolated config roots",
    );
  }
  const result = spawnSync("opencode", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: join(options.out, "config", "opencode"),
      XDG_CONFIG_HOME: join(options.out, "xdg"),
    },
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
```

`runCli` must not throw on a non-zero exit: the quota retry needs to inspect the status and the JSON error event first. Thread `out` through **every** call, including `exportSession(projectDir, sessionID, out)` and `session delete`; the draft's `exportSession`/`delete` calls omitted it, which would make `join(undefined, "config", ...)` throw.

`prepareProject` must create `<out>/config/opencode` and `<out>/xdg/opencode` once, before the first project. The project's own `.opencode/opencode.jsonc` remains the source of the plugin and policy config. Do not put a global config file in the isolated directory; an empty config root plus the project config is the controlled baseline.

`runPrompt` must add `--standalone`:

```js
const args = ["run", "--standalone", "-m", model, "--format", "json", "--auto"];
```

Why: `--standalone` starts a private server per invocation, so the project-local plugin loads on the first prompt and a stale background server cannot serve an old plugin. The session DB is shared, so `--session <id>` still resumes the session.

- [ ] **Step 4: Pace and retry 429s**

Make `runPrompt` async and add a module-level pacer:

```js
let lastModelCallAt = 0;

async function pace(ms) {
  const wait = Math.max(0, ms - (Date.now() - lastModelCallAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastModelCallAt = Date.now();
}

function isQuotaError(text) {
  return /quota|rate.?limit|429|free-limit|RESOURCE_EXHAUSTED/i.test(text);
}
```

Add the JSONL parser as a helper, then make `runPrompt(projectDir, prompt, sessionID, model, opts)` async:

```js
function parseJsonLines(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return events;
}
```

`runPrompt` makes exactly one CLI call and throws a typed error that carries the session ID:

```js
class QuotaError extends Error {
  constructor(message, sessionID) {
    super(message);
    this.name = "QuotaError";
    this.sessionID = sessionID ?? null;
  }
}

class RunError extends Error {
  constructor(message, sessionID) {
    super(message);
    this.name = "RunError";
    this.sessionID = sessionID ?? null;
  }
}

async function runPrompt(projectDir, prompt, sessionID, model, opts) {
  await pace(opts.paceMs);
  const args = [
    "run",
    "--standalone",
    "-m",
    model,
    "--format",
    "json",
    "--auto",
  ];
  if (sessionID) args.push("--session", sessionID);
  args.push(prompt);

  const result = runCli(args, {
    cwd: projectDir,
    out: opts.out,
    timeoutMs: opts.timeoutMs,
  });
  const events = parseJsonLines(result.stdout);
  const error = events.find((event) => event?.type === "error");
  const session = sessionID ?? sessionIDFromEvents(events);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (error) {
    const message =
      error.error?.message ?? error.message ?? "opencode run error event";
    throw isQuotaError(combined)
      ? new QuotaError(message, session)
      : new RunError(message, session);
  }
  if (result.status !== 0) {
    throw new RunError(
      `opencode run failed (${result.status}): ${String(result.stderr).slice(-2000)}`,
      session,
    );
  }
  if (!session) throw new RunError("opencode run produced no sessionID", null);
  return { sessionID: session, stdout: result.stdout, stderr: result.stderr };
}
```

`runOne` owns retries at the whole-attempt level. A quota error, provider error, or validation failure discards the attempt: record it, delete the session if known, remove the project unless `--keep-projects`, and start a new attempt with a fresh project directory, salt, and session. `--max-retries` is the number of extra whole-run attempts allowed after a quota error; `--attempts` is the number allowed after a validation failure. The total cap is `1 + Math.max(opts.maxRetries, opts.attempts)`. Quota retries back off 5 s/10 s/20 s/30 s (capped at 30 s) and log each retry. A retry is a new attempt, not a measurement of the failed session.

- [ ] **Step 5: Add the measurement-only load marker**

In `sourceFor`, after copying the variant's `index.ts`, insert the marker at the start of the prompt hook:

```js
const hookStart = 'await ctx.session.hook("prompt", async (event) => {';
const markerLine =
  `\n        await mkdir(join(projectRootOf(ctx), ${JSON.stringify(LOAD_MARKER)}), ` +
  `{ recursive: true }).catch(() => {});`;
```

Both the E8-A and pre-E8 `index.ts` already import `mkdir`, `join`, and define `projectRootOf`. The marker is a directory outside the model request; it is how the harness distinguishes "the plugin never loaded" from "the plugin loaded but produced no notice". Keep the `snapshotIfDue` disable patch.

- [ ] **Step 6: Deny skills, MCP, and escape tools in every fixture**

`prepareProject` writes:

```json
{
  "plugins": ["./plugins/memory"],
  "permissions": [
    { "action": "memory_write", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "*", "effect": "deny" },
    { "action": "edit", "resource": "*", "effect": "deny" },
    { "action": "write", "resource": "*", "effect": "deny" },
    { "action": "webfetch", "resource": "*", "effect": "deny" },
    { "action": "websearch", "resource": "*", "effect": "deny" }
  ],
  "policies": [
    { "action": "integration.use", "resource": "skill:*", "effect": "deny" },
    { "action": "integration.use", "resource": "mcp:*", "effect": "deny" }
  ]
}
```

The exact `edit`/`write`/`webfetch`/`websearch` action names must match the host's permission actions; if the host rejects one, use the names in `src/templates.ts` / the permissions docs and record the change. The purpose is to force `read` and prevent fixture mutation or network escape, not to test permissions. `validateRun` must reject any tool part that is not a completed `read`, and any read path outside `projectDir`.

- [ ] **Step 7: Add the unique salt to `AGENTS.md` and the brief**

`prepareProject` already receives a `salt`. Write:

```js
await writeFile(
  join(projectDir, "AGENTS.md"),
  `# E8 measurement fixture ${salt}\n\nSynthetic project for cache-placement measurement. Do not edit files.\n`,
);
```

The active-context fixture already includes `- run salt: ${salt}`. The salt changes the system prefix early enough to prevent a prior run from satisfying the whole prefix, while remaining stable within the measured session.

- [ ] **Step 8: Replace the fixed warm-up loop with a standalone readiness check**

With `--standalone`, no provider warm-up is needed. Do **not** add the draft's two-warm-up loop, the 2-second watcher delay, or `session delete` warm-up cleanup. Then:

1. Move the per-attempt `projectDir` construction **inside** the attempt loop and include the attempt: `<out>/projects/<scenario>-<variant>-r<rep>-a<attempt>`. Never reuse a directory across attempts; a stale server/plugin state was the draft's failure mode.
2. `prepareProject`, write the measured salt, and hash the brief.
3. `await runPrompt(...)` for prompt 1 and keep its `sessionID`.
4. `await runPrompt(projectDir, PROMPT_TWO, first.sessionID, model, opts)` for prompt 2 in the **same** session.
5. Export the session once, after prompt 2, and `analyzeExport(...)` both prompts. Do not export between prompts for the measured run.
6. `validateRun(...)`, which must also require `existsSync(join(projectDir, LOAD_MARKER))` and the variant's expected notice. Pass `projectDir` into `validateRun` (or do the marker check in `runOne` immediately before validation); the function needs the path, not just the export summary.
7. On a missing marker, any validation error, or a quota/provider error, delete that attempt's session and project and retry with a fresh project directory, salt, and session. The measured session stays until its export is saved or the attempt is discarded.

No warm-up session is allowed before the measured prompt: it would seed the provider cache and bias the first-call baseline. If a future host version requires a warm-up, run it in a separate disposable project and record the deviation.

- [ ] **Step 9: Hash the brief inputs and verify stability**

After writing the measured salt and before prompt 1:

```js
const briefFiles = [
  join(memoryDir, "activeContext.md"),
  join(memoryDir, "INDEX.md"),
  ...(await readdir(join(memoryDir, "handoffs")))
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => join(memoryDir, "handoffs", n)),
];
const hashFiles = async () =>
  createHash("sha256")
    .update((await Promise.all(briefFiles.map((p) => readFile(p)))).join("\n"))
    .digest("hex");
```

Save `briefHashBefore`; re-hash after prompt 2 and require equality. Add `createHash` to the `node:crypto` import.

- [ ] **Step 10: Extend the analyzer with the baseline-adjusted metrics**

In `analyzeExport`, compute:

```js
const laterCalls = prompt1Calls.slice(1);
const laterCallCount = laterCalls.length;
const laterCacheRead = sum(laterCalls, "cacheRead");
const firstCacheRead = prompt1First?.cacheRead ?? 0;
const p1LaterIncrementalRead = Math.max(
  0,
  laterCacheRead - firstCacheRead * laterCallCount,
);
const p2FirstIncrementalRead = Math.max(
  0,
  (prompt2First?.cacheRead ?? 0) - firstCacheRead,
);
```

Add `prompt1Total.promptTokens`, `prompt2Total.promptTokens`, `sessionTotal.promptTokens`, `noticeLines` (count of lines starting with `[memory]`/`[memory-hint]` in prompt 1's text), and `skillToolParts` (tool parts named `skill`) to the summary. Add `p1LaterIncrementalRead` to the `prompt1Later` object and `p2FirstIncrementalRead` to the `prompt2First` object (or to a `prompt2` summary) so the pair builder can read them. The report must show the raw metrics and the adjusted metrics; do not hide the raw numbers.

In `pairRuns`, add the adjusted pair deltas used by the report:

```js
deltaLaterAdjustedRead:
  e8.prompt1Later.p1LaterIncrementalRead -
  pre.prompt1Later.p1LaterIncrementalRead,
deltaPrompt2AdjustedRead:
  (e8.prompt2First?.p2FirstIncrementalRead ?? 0) -
  (pre.prompt2First?.p2FirstIncrementalRead ?? 0),
```

Add a `summarizePooled(pairs)` helper next to `summarizeScenario` and store `pooled` in the report. The pooled row is the gate input; the per-scenario rows are the disagreement check.

- [ ] **Step 11: Extend the report**

Add `--compare <baseline>:<candidate>` (repeatable, default `pre-e8:e8-a`) and make `pairRuns(runs, baseline, candidate)`/`buildReport` use it. The default run compares `pre-e8:e8-a`; the attachment branch adds `e8-a:e8-attach`; the E8-B branch adds `pre-e8:e8-b` and `e8-a:e8-b`. Do not hardcode `pre-e8`/`e8-a` inside `pairRuns` or `summarizeScenario`.

Add columns to the per-run table:

```text
| scenario | rep | variant | p1 calls | p1 first hit | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted | p1 total tokens | p2 total tokens | notice lines | skill parts | brief hash match | marker | export outcome | export prompt tokens |
```

Add a "Validity" section that prints the valid/exhausted/attempt counts and
the failed checks per attempt. Add an "Attempt history" table with one row per attempt
(`scenario`, `rep`, `variant`, `attempt`, `status`, `session`, `project`,
`errors`), including discarded attempts. Print "No failed runs." only when
every recorded attempt is valid; otherwise say that discarded attempts are
listed in the history. Add a "Brief stability" section with the before/after
hashes per run. Add a "Raw usage" section that points to `summary.json` and the
per-run export path, and label session totals as computed from per-call rows.
For each comparison, print a pooled row (the gate input) and the per-scenario
rows. Keep the **default** comparison (`pre-e8:e8-a`) at the top level
(`pairs`, `pooled`, `byScenario`) so the Task 4 script works; put any extra
comparisons in `comparisons[]`.

- [ ] **Step 12: Extend the self-test**

The `selfTest` must assert:

- `prompt1Later.laterCacheHitRate` and the adjusted metrics on the synthetic export;
- `prompt2First` incremental read;
- `noticeLines` for the E8-A synthetic prompt and its prompt-2 notice;
- `skillToolParts` detected on a synthetic `skill` tool part;
- the pre-E8 synthetic export has no marker and no notice lines in either prompt;
- `pairRuns(..., "pre-e8", "e8-a")` and the pooled summary on a synthetic two-variant pair;
- a table-driven `validateRun` suite where the valid fixture passes and each
  mutation fails for the intended reason: wrong prompt 1/2 text; missing or
  extra user turns; prompt-2 hint/status/extra-handoff lines; pre-E8 and
  control notice markers; non-succeeded outcome; assistant `error` or
  `finish="error"`; missing or zero tokens; export `info.tokens` total
  mismatch; model mismatch; wrong project path; missing load marker; brief
  hash mismatch; non-completed or non-`read` tool parts; read paths outside
  `projectDir` or missing a path; INDEX attached in `status` or absent in
  `hint`;
- `validateRun` without `projectDir` returns the four
  `not checked (no projectDir)` labels and `validationStatus: "not-checked"`,
  and `isValidRun` rejects it;
- `pairRuns` throws on duplicate `(scenario, rep, variant)` keys, and
  `buildReport` reports a zero-pair comparison instead of silently passing;
- `parseArgs` rejects `e8-attach`, duplicate variants/scenarios/comparisons,
  `baseline === candidate`, comparison endpoints absent from `--variants`, and
  `--analyze` without explicit `--variant`/`--scenario`;
- attempt-history rendering includes discarded attempts and escapes table
  cells; "No failed runs." appears only for an all-valid history;
- `fileURIs` accepts both export (`source.uri`) and plugin (`uri`) attachment
  shapes; `isSessionID` requires the `ses_` prefix;
- `parseJsonLines` handling a non-JSON progress line without throwing;
- `isDirtySrc("") === false` and `isDirtySrc(" M src/index.ts") === true`.

Run:

```bash
node scripts/e8-cache-measure.mjs --self-test
```

Expected: `self-test ok`.

- [ ] **Step 13: Add a header comment that says what is measured and what is not**

The script header must state:

- this is a dev-only harness, not a package entrypoint;
- the snapshot writer is disabled in the copies;
- the account is free tier, so no billed-cost claim;
- the two primary metrics are `prompt1Later.cacheHitRate` and `prompt2First.cacheHitRate`, with baseline-adjusted reads reported alongside;
- the provider, model, and OpenCode version are recorded in `summary.json`.

- [ ] **Step 14: Run the dry run**

```bash
node scripts/e8-cache-measure.mjs --dry-run \
  --out /tmp/opencode/e8-dry-2026-10-27
```

Expected: four `dry-run ok:` lines for `pre-e8/hint`, `e8-a/hint`, `pre-e8/status`, `e8-a/status`; no model calls; the projects contain `.e8-plugin-loaded` only after a real prompt (not during dry-run).

- [ ] **Step 15: Commit the harness**

```bash
git add scripts/e8-cache-measure.mjs
git commit -m "test: add E8 cache-placement measurement harness"
```

---

### Task 2: Preflight the provider and the harness

**Files:** none (read-only checks; no repo changes)

- [ ] **Step 1: Confirm the model and credential**

```bash
opencode models | grep '^google/gemini-3.5-flash-lite$'
```

Expected: one line. If the model is absent, re-check `GEMINI_API_KEY` and the provider catalog; do not substitute a model without updating the plan and the doc.

- [ ] **Step 2: Confirm cache fields through the CLI**

```bash
cd /tmp/opencode
opencode run --standalone -m google/gemini-3.5-flash-lite \
  --format json --auto "Reply with exactly: PREFLIGHT_OK" \
  > /tmp/opencode/e8-preflight.jsonl 2>&1
```

Extract the session ID, run a second prompt in the same session, export it, and print the assistant token rows:

```bash
SID=$(python3 -c "import json,sys; [print(json.loads(l)['sessionID']) for l in open('/tmp/opencode/e8-preflight.jsonl') if l.strip().startswith('{') and 'sessionID' in l]" | head -1)
opencode run --standalone -m google/gemini-3.5-flash-lite --session "$SID" \
  --format json --auto "Reply with exactly: PREFLIGHT_TWO" >/dev/null 2>&1
opencode session export "$SID" > /tmp/opencode/e8-preflight-export.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/opencode/e8-preflight-export.json'))
for m in d['messages']:
    if m['type'] == 'assistant':
        print(m['tokens'])
print('session', d['info']['tokens'])
EOF
```

Expected: the second assistant row has `cache.read > 0` (the first may be 0 or a small shared-prefix hit). If `cache.read` is always 0, the provider/model path is not measurable; record the exact output and stop with "not measurable" (issue #22 stays open).

- [ ] **Step 3: Record the account tier**

If a 429 occurs, capture the error text. It must name the free-tier quota:

```text
generate_content_free_tier_requests
limit: 15
Generate content requests per minute limit exceeded on Free Tier.
```

Record: **Google AI Studio free tier, 15 requests/minute**. Do not claim billed costs.

- [ ] **Step 4: Confirm the harness refuses to run on a dirty `src/`**

```bash
touch src/.e8-dirty-probe
node scripts/e8-cache-measure.mjs --run --reps 1 --out /tmp/opencode/e8-dirty-check
rm src/.e8-dirty-probe
```

Expected: `src/ is dirty; commit or stash before measuring`; no provider calls. This check must run before the variant copy.

---

### Task 3: Smoke run (1 rep)

**Files:** none (writes only to `/tmp/opencode/e8-smoke-2026-10-27`)

- [ ] **Step 1: Run one rep of both scenarios**

```bash
node scripts/e8-cache-measure.mjs --run \
  --model google/gemini-3.5-flash-lite \
  --reps 1 --scenarios hint,status \
  --pace-ms 6000 --max-retries 4 \
  --out /tmp/opencode/e8-smoke-2026-10-27
```

Expected: two paired runs (4 sessions) with no failures; `summary.md` shows `p1 later hit`, `p2 first hit`, adjusted reads, and `marker=yes` for E8-A, `marker=no` for pre-E8.

- [ ] **Step 2: Inspect the raw export for one E8-A run**

```bash
ls /tmp/opencode/e8-smoke-2026-10-27/raw/
python3 - <<'EOF'
import json, glob
p = sorted(glob.glob('/tmp/opencode/e8-smoke-2026-10-27/raw/hint-e8-a-r1.json'))[0]
d = json.load(open(p))
for m in d['messages']:
    if m['type'] == 'user':
        print('USER:', repr(m.get('text', '')))
    if m['type'] == 'assistant':
        print('ASSISTANT:', m.get('tokens'))
EOF
```

Expected: the E8-A user text contains the user's sentence, a blank line, `[memory] handoff: ... (latest)`, the marker/label, and a `[memory-hint]` line. The pre-E8 user text contains only the user's sentence. The assistant rows contain all five usage fields.

- [ ] **Step 3: Inspect the brief hashes**

```bash
python3 - <<'EOF'
import json
s = json.load(open('/tmp/opencode/e8-smoke-2026-10-27/summary.json'))
for r in s['runs']:
    print(r['scenario'], r['variant'], r['briefHashBefore'] == r['briefHashAfter'])
EOF
```

Expected: `True` for every run. If `False`, stop and fix the snapshot/probe leakage before the full run.

- [ ] **Step 4: Inspect the UX block**

Copy the exact E8-A user text into a scratch note. Check the §2.6 UX checklist. Do not decide yet; the smoke is for the full-run review.

- [ ] **Step 5: Fix harness issues, not the data**

If a run is invalid, read the failure (quota, marker, tool call, brief hash), fix the harness/control, and re-run the smoke. Never edit the measured fixture or the export to make a run valid.

---

### Task 4: Full run (3 reps; 5 if ambiguous)

**Files:** none (writes only to `/tmp/opencode/e8-measurement-2026-10-27`)

- [ ] **Step 1: Run the full protocol**

```bash
node scripts/e8-cache-measure.mjs --run \
  --model google/gemini-3.5-flash-lite \
  --reps 3 --scenarios hint,status \
  --pace-ms 6000 --max-retries 4 \
  --out /tmp/opencode/e8-measurement-2026-10-27
```

Expected: 6 valid pairs (3 reps × 2 scenarios), `summary.json`, `summary.md`, and 12 raw exports. The run may take 20–40 minutes because of the free-tier pacing; do not parallelize model calls.

- [ ] **Step 2: Check validity before looking at the decision**

```bash
python3 - <<'EOF'
import json
s = json.load(open('/tmp/opencode/e8-measurement-2026-10-27/summary.json'))
print('runs', len(s['runs']), 'failures', len(s['failures']), 'pairs', len(s['pairs']))
for f in s['failures']:
    print('FAIL', f['scenario'], f['variant'], f['rep'], f['error'])
EOF
```

Expected: `pairs 6`, `failures 0`. If `pairs < 5`, run the 5-rep protocol (Step 5) or record "not measurable".

- [ ] **Step 3: Compute the decision table**

```bash
python3 - <<'EOF'
import json, math, statistics
s = json.load(open('/tmp/opencode/e8-measurement-2026-10-27/summary.json'))
def med(xs): return statistics.median(xs) if xs else None
def stats(rows, label):
    dl = [p['deltaLaterHit'] for p in rows]
    dp = [p['deltaPrompt2Hit'] for p in rows]
    dlr = [p['deltaLaterAdjustedRead'] for p in rows]
    dpr = [p['deltaPrompt2AdjustedRead'] for p in rows]
    n = len(rows)
    t = math.ceil(2 * n / 3) if n else 0
    print(label, 'N', n, 'T', t,
          'DLater', med(dl), '+', sum(x > 0 for x in dl), '-', sum(x < 0 for x in dl),
          'Dp2', med(dp), '+', sum(x > 0 for x in dp), '-', sum(x < 0 for x in dp),
          'DLaterRead', med(dlr), 'Dp2Read', med(dpr))
stats(s['pairs'], 'pooled')
for scenario in ('hint', 'status'):
    stats([p for p in s['pairs'] if p['scenario'] == scenario], scenario)
EOF
```

The pooled row is the gate input; the per-scenario rows are for the disagreement check. Record the medians and sign counts for `Δlater`, `Δp2`, `ΔlaterRead`, and `Δp2Read` in the measurement doc. Apply the §2.6 rule exactly. Do not change the thresholds after seeing the numbers.

- [ ] **Step 4: Check the two scenarios for disagreement**

If `hint` and `status` have opposite signs on the primary metric, inspect the per-rep rows. Do not average them into a misleading single number; report both. If the disagreement is caused by a provider cache reset or a call-structure difference, note it and use the 5-rep rerun.

- [ ] **Step 5: If needed, run 2 extra reps**

```bash
node scripts/e8-cache-measure.mjs --run \
  --model google/gemini-3.5-flash-lite \
  --reps 5 --scenarios hint,status \
  --pace-ms 6000 --max-retries 4 \
  --out /tmp/opencode/e8-measurement-2026-10-27-r5
```

Use the 5-rep medians for the gate only if the first run was ambiguous or had fewer than 5 valid pairs; record both runs and why the rerun happened.

- [ ] **Step 6: Save the evidence path**

Record in the measurement doc:

```text
Harness: scripts/e8-cache-measure.mjs
Run directory: /tmp/opencode/e8-measurement-2026-10-27
summary.json: <sha256>
summary.md: <sha256>
Raw exports: 12 files under raw/
```

Do not commit the `/tmp` directory. If the doc needs a full raw table, paste the per-call rows from `summary.json` into a fenced code block or a Markdown table; do not include API keys or auth headers.

---

### Task 5: Write `docs/2026-10-27-e8-measurement.md` and apply the decision gate

**Files:**

- Create: `docs/2026-10-27-e8-measurement.md`
- Modify: `docs/2026-10-20-e8-cache-placement-spike.md`

- [ ] **Step 1: Write the header and method**

Use this skeleton and fill the bracketed values from the run; do not leave placeholders:

```markdown
# E8 cache-placement measurement — 2026-10-27

## Status

Measured against Google Gemini 3.5 Flash Lite (Google AI Studio free tier)
on 2026-10-27. Decision: **<keep | change to attachment | fall back to E8-B | not measurable>**.
No billed-token savings claim is made; the account is free tier.

## Method

- Provider: Google AI Studio / Gemini API (`google`)
- Model: `google/gemini-3.5-flash-lite`
- Account tier: Free Tier (15 requests/minute; 429 evidence recorded)
- OpenCode: 2.1.4
- Repo HEAD: `<sha>`
- Pre-E8 ref: `7629611^`
- Harness: `scripts/e8-cache-measure.mjs` (`<sha256>`)
- Variants: pre-E8 system placement vs E8-A prompt-tail placement
- Scenarios: hint (within-turn churn), status (status-line churn)
- Reps: 3 per scenario per variant (6 pairs); smoke run excluded
- Controls: snapshot writer disabled in both copies; unique project/salt per
  run; skills/MCP denied; read-only tool surface; brief hashes equal before
  and after; `--standalone`; free-tier pacing.
```

- [ ] **Step 2: Add the raw usage table**

One row per assistant call. Include the scenario, rep, variant, prompt, call index, tool names, `input`, `output`, `reasoning`, `cache.read`, `cache.write`, `promptTokens`, `uncachedTokens`, `cacheHitRate`.

Use the `summary.json` values verbatim. If the table is too large for Markdown, include the session-level totals here and put the per-call rows in a fenced JSON block or a linked artifact. The issue requires the raw fields, not a pretty chart.

- [ ] **Step 3: Add the paired deltas and the baseline-adjusted table**

```markdown
## Paired deltas (E8-A minus pre-E8)

| scenario | pairs | median Δlater | +/− | median Δp2 | +/− | median ΔlaterRead | median Δp2Read |
| -------- | ----- | ------------- | --- | ---------- | --- | ----------------- | -------------- |
```

Explain the sign convention and that medians are over pairs, not over all calls. Include the `hint` and `status` rows separately. Include the 5-rep rerun if it happened.

- [ ] **Step 4: Add the validity and control evidence**

- Number of valid pairs; failed runs and why.
- Brief hashes before/after (all equal).
- Load marker present in every E8-A and pre-E8 run.
- E8-A marker/label present in hint/status prompts; pre-E8 has none.
- No `skill`/`shell` tool parts; both `read alpha.txt` and `read beta.txt` present.
- Snapshot writer disabled (link to the harness patch line).
- The exact provider quota evidence and pacing.

- [ ] **Step 5: Add the UX review**

Quote the exact E8-A prompt-1 user text from one `hint` run and one `status` run (redact absolute `/tmp` paths to `<project>` if desired; do not redact the notice text). Include:

- What the user sees: their text, a blank line, the notice block, labels.
- Whether the HTML marker is visible in the raw export and whether rendered Markdown hides it.
- Line count, length, and repetition across prompts.
- The §2.6 checklist result: **accept**, **accept with a wording fix**, or **reject**.
- The explicit conclusion required by issue #22: "Accepting transcript visibility is/is not an explicit decision."

Do not bury this in the cache section. It is a separate decision input.

- [ ] **Step 6: Add limitations and non-claims**

- One provider/model; Gemini implicit prefix caching; do not generalize to OpenAI/Anthropic/DeepSeek.
- Free tier; no billed-cost claim; the reported `cost` field is an estimate, not a charge.
- The shared base-system-prefix hit is large and constant; the raw hit rate can understate the placement effect. The adjusted metrics are reported for that reason.
- The snapshot writer is disabled in the copies; production snapshots can change the brief and invalidate the cache. This measurement isolates the placement, not the snapshot cadence.
- The line budgets are unchanged; 237/96 remain uncached line guardrails, not token metrics.
- No production cache metrics; ADR-0008 vocabulary unchanged.

- [ ] **Step 7: Record the decision and rationale**

Use the §2.6 rule. Include `N`, `T`, the pooled medians/sign counts, the per-scenario rows, and the adjusted reads. Example (choose one, not all):

```markdown
## Decision

**Keep E8-A prompt-tail placement.** N = 6 valid pairs (T = 4/6). Median
Δlater = +0.xx (x/N positive), median Δp2 = +0.xx (x/N positive). The
direction is consistent on both scenarios and the adjusted reads do not
contradict it. No billed-token claim: the account is free tier. The UX review
accepts the block: it is ≤3 labelled data-only lines, the user's text remains
first, and the visible HTML marker is a raw-transcript artifact that rendered
Markdown hides. Transcript visibility is accepted explicitly, not implicitly.
```

or:

```markdown
## Decision

**Change to <attachment | E8-B>.** N = 6 valid pairs (T = 4/6). Median
Δlater = −0.xx (x/N negative), median Δp2 = +0.xx. The cache verdict is
<loss/neutral> and the UX gate <rejects/accepts> the prompt-tail block, so
§2.6 selects <branch>. The re-measurement of the candidate is reported in the
second table; <it is adopted / it regressed by x and the issue stays open>.
No billed-token claim.
```

or:

```markdown
## Decision

**Not measurable.** Only N valid pairs were available despite the 5-rep rerun;
the quota / provider behavior prevented a fair comparison. Issue #22 stays
open/blocked until a maintainer-keyed run is possible. No savings claim.
```

- [ ] **Step 8: Update the spike doc**

Change the status line to:

```markdown
## Status

Placement is implemented and covered by tests. Measured on 2026-10-27 against
Google Gemini 3.5 Flash Lite (free tier): see
[`2026-10-27-e8-measurement.md`](./2026-10-27-e8-measurement.md). Decision:
<keep / change to attachment / change to E8-B / not measurable>. No billed-token
claim. The line budget remains an uncached worst-case guardrail, not a
billed-token metric.
```

Keep the measurement protocol section and the non-claims; add a one-line note that the protocol was executed and where the raw tables live. Do not delete the non-claims.

- [ ] **Step 9: Commit the measurement + spike doc**

```bash
git add docs/2026-10-27-e8-measurement.md docs/2026-10-20-e8-cache-placement-spike.md
git commit -m "docs: record E8 cache-placement measurement"
```

---

### Task 6: Keep branch — accept the prompt-tail placement and transcript visibility

Execute this task only if Task 5 selected **keep** (including "accept with a wording fix").

**Files:**

- Modify: `docs/design-spec-v2-production.md` §5.2, §9
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/adr/0002-agents-md-injection.md`, `docs/adr/0004-ledger-and-promotion.md`, `docs/adr/0007-untrusted-memory-content.md`
- Test: existing `test/hooks.test.ts`, `test/prompt-notices.test.ts` (no placement change; run them)
- Optional wording fix: `src/prompt-notices.ts` + the two tests

- [ ] **Step 1: Make transcript visibility explicit in spec §5.2**

Replace the bullet that currently says the block is model-facing "not the user directly" with:

```markdown
- The prompt-tail block is **model-facing and transcript-visible**: it is
  appended to the canonical persisted user prompt, so it appears in the user's
  transcript as part of that message. The server-plugin API exposes no separate
  UI/notification primitive, so delivery as a distinct alert still depends on
  the model relaying it; that remains best-effort. The placement was measured
  on 2026-10-27 (`docs/2026-10-27-e8-measurement.md`) and kept: the block is
  labelled data-only, capped at three lines, and keeps the stable system prefix
  free of volatile notices. The raw export shows the marker; rendered Markdown
  may hide the HTML comment. This visibility is an explicit, accepted trade-off,
  not an implicit side effect.
```

If the UX verdict was "accept with a wording fix", describe the final marker/label text here and in `src/prompt-notices.ts`.

- [ ] **Step 2: Add the §9 measurement note**

In the budget/eval section, after the 237-line sentence, add:

```markdown
The 2026-10-27 measurement (`docs/2026-10-27-e8-measurement.md`) compared
pre-E8 system placement with E8-A prompt-tail placement on Gemini 3.5 Flash
Lite (free tier). It records token/cache fields and the UX verdict; it does not
convert line counts into billed tokens. The account was free tier, so no
billed-cost claim is made.
```

- [ ] **Step 3: Add the README visibility note**

After the "It costs some context" bullet in the context/cost section, add:

```markdown
- The volatile `[memory]` notice block (newest-handoff pointer, status, hint) is
  appended to the user prompt itself, so it is visible in the transcript. It is
  capped at three labelled data-only lines. The 2026-10-27 measurement and the
  visibility decision are recorded in `docs/2026-10-27-e8-measurement.md`.
```

- [ ] **Step 4: Add the ADR measurement notes**

At the end of the E8 revision in each ADR, add one sentence:

```markdown
Measurement (2026-10-27): compared with pre-E8 on Gemini 3.5 Flash Lite (free
tier); see `docs/2026-10-27-e8-measurement.md`. The placement was kept and the
transcript visibility was accepted explicitly (or: changed to <option>).
```

Do not rewrite the ADR's original decision or its trust rationale; the note is an addendum.

- [ ] **Step 5: Add the CHANGELOG entry**

Under `Unreleased`, add:

```markdown
- Docs: record the 2026-10-27 E8 cache-placement measurement (Gemini 3.5 Flash
  Lite, free tier) and keep the prompt-tail notice placement. The prompt-tail
  block remains visible in the transcript by design; no billed-token claim is
  made.
```

If the wording fix changed the marker/label, mention it:

```markdown
- The prompt-tail marker/label was clarified to `<new text>`; the placement and
  budget are unchanged.
```

- [ ] **Step 6: Optional wording fix (only if the UX gate asked for one)**

If the only objection is the visible HTML marker:

1. Change `PROMPT_NOTICES_MARKER` in `src/prompt-notices.ts` to the agreed text.
2. Update the literal marker assertions in `test/prompt-notices.test.ts` and `test/hooks.test.ts`.
3. Keep `hasPromptNotices` and `appendPromptNotices` behavior identical.
4. Run the focused tests:

```bash
npx vitest run test/prompt-notices.test.ts test/hooks.test.ts
```

Expected: all pass. Then re-run the smoke measurement (Task 3) to confirm the notice still appears; the full measurement is not repeated unless the block length changed.

- [ ] **Step 7: Run the keep-branch gates**

```bash
npm run typecheck
npm test
npx prettier --check README.md CHANGELOG.md docs/design-spec-v2-production.md docs/2026-10-27-e8-measurement.md docs/2026-10-20-e8-cache-placement-spike.md docs/adr/0002-agents-md-injection.md docs/adr/0004-ledger-and-promotion.md docs/adr/0007-untrusted-memory-content.md
git diff --check
```

Expected: typecheck clean, all tests pass, Prettier reports all files formatted, `git diff --check` silent.

- [ ] **Step 8: Commit**

```bash
git add README.md CHANGELOG.md docs/design-spec-v2-production.md \
  docs/adr/0002-agents-md-injection.md docs/adr/0004-ledger-and-promotion.md \
  docs/adr/0007-untrusted-memory-content.md docs/2026-10-27-e8-measurement.md
git commit -m "docs: keep E8 prompt-tail placement after measurement"
```

If the wording fix touched `src/`/tests, include those files in the commit and use `docs: keep E8 prompt-tail placement and clarify notice marker`.

---

### Task 7: Change branch — attachment-based notice (conditional)

Execute this task only if Task 5 selected **change** and the UX gate rejected user-text visibility, regardless of the cache verdict. If the UX gate accepted the prompt-tail and the cache verdict is a loss, execute Task 8 instead. Do not execute this task together with Task 8.

**Files:**

- Modify: `src/prompt-notices.ts`, `src/index.ts`, `src/files.ts` (dedicated scratch writer)
- Modify: `test/prompt-notices.test.ts`, `test/hooks.test.ts`, `test/files.test.ts`
- Modify: `docs/design-spec-v2-production.md` §5.2/§9, `README.md`, `CHANGELOG.md`, ADR-0002/0004/0007
- Modify: `scripts/e8-cache-measure.mjs` to add an `e8-attach` variant and an `e8-a:e8-attach` comparison
- Commit the implementation and tests **before** the re-measurement: the harness refuses a dirty `src/`.

- [ ] **Step 1: Write the notice file instead of mutating the user text**

Add a dedicated scratch writer to `src/files.ts`. Do **not** add `prompt-notices.md` to `ALLOWED_ROOT_FILES`: it is plugin-owned scratch data, not a memory file, and must stay out of `INDEX.md`, the brief, and the memory read/search surface.

```ts
export const PROMPT_NOTICES_FILE = "prompt-notices.md";

/**
 * Overwrite the plugin-owned prompt-notices scratch file atomically. Confined
 * to a constant name under the memory root; not in ALLOWED_ROOT_FILES, not
 * indexed, not loaded into the brief. Redaction and the 3-line notice cap
 * apply, matching the prompt-tail budget.
 */
export async function writePromptNotices(
  text: string,
  opts?: CappedFileOptions,
): Promise<void> {
  if (typeof text !== "string") {
    throw new Error("[memory] writePromptNotices text must be a string");
  }
  const redactedText = redact(text);
  const lines = countLines(redactedText);
  if (lines > 3) {
    throw new Error(`[memory] prompt notices have ${lines} lines; cap is 3`);
  }
  const root = resolveMemoryRoot(opts?.memoryRoot);
  await withFileWriteLock(root, async () => {
    const abs = resolveUnderRoot(root, PROMPT_NOTICES_FILE);
    await publishAtomic(root, abs, redactedText);
  });
}
```

In `src/prompt-notices.ts`, add the URI helper:

```ts
import { PROMPT_NOTICES_FILE } from "./files.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function promptNoticesUri(memoryRoot: string): string {
  return pathToFileURL(join(memoryRoot, PROMPT_NOTICES_FILE)).href;
}
```

In `src/index.ts` prompt hook, replace the `appendPromptNotices` call with:

```ts
if (plan.text.length > 0) {
  await writePromptNotices(`${plan.text}\n`, { memoryRoot });
  const uri = promptNoticesUri(memoryRoot);
  event.prompt.files ??= [];
  if (!event.prompt.files.some((file) => file?.uri === uri)) {
    event.prompt.files.push({ uri });
  }
}
```

Overwriting is the idempotency mechanism: the block is deterministic for the same prompt, so a retry replaces it rather than appending a second copy. Do not call `hasPromptNotices` on the user text for this path. The user's `event.prompt.text` must remain byte-for-byte unchanged. Remove any imports that become unused (`appendPromptNotices`/`hasPromptNotices` if no other call site uses them); `npm run typecheck` must stay clean.

- [ ] **Step 2: Add tests**

`test/files.test.ts`:

- `writePromptNotices` creates `.opencode/memory/prompt-notices.md` and overwrites it atomically;
- the writer rejects more than three lines;
- `readCapped("prompt-notices.md", ...)` is rejected as non-allowlisted (the file is not a memory file).

`test/prompt-notices.test.ts`:

- the planned block has the pointer/status/hint order and the marker;
- the notice URI is a file URL under the memory root;
- no notices → the prompt hook attaches no notice URI;
- budget drop still omits the pointer/status as before.

`test/hooks.test.ts`:

- `event.prompt.text` equals the user text exactly (no appended block);
- `event.prompt.files` contains the INDEX URI and the notice URI;
- the notice URI is not duplicated on a retry;
- the pre-existing INDEX attachment logic is unchanged;
- the file is written under `.opencode/memory/prompt-notices.md`;
- update the existing E8-A assertions (prompt-tail append, context-prefix stability, quoted-marker/budget cases) to the attachment placement; do not leave a test asserting the block is in `event.prompt.text`.

Run:

```bash
npx vitest run test/prompt-notices.test.ts test/hooks.test.ts test/files.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit the implementation before re-measuring**

The harness's `src/` dirty guard is intentional. Commit the code and tests first, then verify the tree is clean:

```bash
npx vitest run test/prompt-notices.test.ts test/hooks.test.ts test/files.test.ts
git add src/prompt-notices.ts src/index.ts src/files.ts \
  test/prompt-notices.test.ts test/hooks.test.ts test/files.test.ts
git commit -m "feat: attach E8 prompt notices instead of appending user text"
test -z "$(git status --porcelain -- src)" && echo "src clean"
```

Expected: tests pass, commit succeeds, `src clean`.

- [ ] **Step 4: Add the `e8-attach` variant and comparison to the harness**

`sourceFor` gains:

```js
} else if (variant === "e8-attach") {
  // working tree: the attachment implementation just committed
  for (const name of await readdir(join(REPO_ROOT, "src"))) {
    if (name.endsWith(".ts"))
      await cp(join(REPO_ROOT, "src", name), join(dest, name));
  }
} else if (variant === "e8-a") {
  // the measured E8-A source, not the working tree after the attachment change
  const tar = execFileSync(
    "git",
    ["-C", REPO_ROOT, "archive", "--format=tar", "8a1f2bb", "src"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // ... extract as in the pre-e8 branch ...
}
```

Update `VARIANTS`, the CLI `--variants` parsing, the self-test, the `validateRun` expectations (prompt text equals the user text with no marker; the notice URI is in `prompt.files`; `.opencode/memory/prompt-notices.md` contains the marker/label; no skill/shell), and the comparison labels. Run the default comparison `pre-e8:e8-a` plus `e8-a:e8-attach`.

- [ ] **Step 5: Re-run the measurement**

```bash
node scripts/e8-cache-measure.mjs --run \
  --model google/gemini-3.5-flash-lite \
  --variants pre-e8,e8-a,e8-attach \
  --compare pre-e8:e8-a --compare e8-a:e8-attach \
  --reps 3 --scenarios hint,status \
  --pace-ms 6000 --max-retries 4 \
  --out /tmp/opencode/e8-measurement-attach-2026-10-27
```

Expected: 18 valid runs (3 variants × 2 scenarios × 3 reps), with the `e8-a:e8-attach` comparison plus the original `pre-e8:e8-a` table. Do not reuse the first run's sessions. If fewer than 5 of the 6 `e8-a:e8-attach` pairs are valid, record "not measurable" for the change branch and keep issue #22 open; do not cherry-pick.

- [ ] **Step 6: Update the docs with the second table and the final decision**

Add the `e8-a:e8-attach` results to `docs/2026-10-27-e8-measurement.md` as a second table. Apply the §2.6 Step 4 adoption rule for the case that selected this branch (win/neutral + UX reject, or loss + UX reject). Do not restate a different threshold. If the attachment fails the rule, record the regression and leave issue #22 open with the evidence. Do not claim a win from the attachment if the cache regressed. Spec §5.2: the volatile block is an attached `prompt-notices.md` file, not user text; the user's message stays clean; the attachment is visible in the UI as a file. README: same. ADR-0002/0004/0007: add a new revision "2026-10-27 — attachment-based notices" with the reason (UX rejection of user-text visibility) and the cache result. CHANGELOG: the change.

- [ ] **Step 7: Run gates and commit the docs/harness**

```bash
npm run typecheck
npm test
node scripts/e8-cache-measure.mjs --self-test
npx prettier --check README.md CHANGELOG.md docs/design-spec-v2-production.md docs/2026-10-27-e8-measurement.md
git diff --check
git add scripts/e8-cache-measure.mjs docs/2026-10-27-e8-measurement.md \
  docs/design-spec-v2-production.md README.md CHANGELOG.md \
  docs/adr/0002-agents-md-injection.md docs/adr/0004-ledger-and-promotion.md \
  docs/adr/0007-untrusted-memory-content.md
git commit -m "docs: record attachment-based E8 notices"
```

If the docs update changes `src/` or tests, that is a bug in this task: the implementation was committed in Step 3. Revert the stray change and re-run the focused tests.

---

### Task 8: Fallback branch — E8-B frozen per-prompt bundle (conditional)

Execute this task only if Task 5 selected **change** and the UX gate accepted the prompt-tail (or accepted with a wording fix) while the cache verdict is a loss. If the UX gate rejected user-text visibility, execute Task 7 instead. Do not execute this task together with Task 7.

**Files:**

- Modify: `src/index.ts` (context hook and prompt hook), `src/prompt-notices.ts` (shared bundle builder)
- Modify: `test/hooks.test.ts`, `test/prompt-notices.test.ts`
- Modify: `docs/design-spec-v2-production.md` §5.2/§9, `README.md`, `CHANGELOG.md`, ADR-0002/0004/0007
- Modify: `scripts/e8-cache-measure.mjs` to add an `e8-b` variant and comparisons
- Commit the implementation and tests **before** the re-measurement: the harness refuses a dirty `src/`.

- [ ] **Step 1: Freeze the bundle per prompt in `ctx.storage`**

In the `context` hook, derive the current prompt from the last user message ID, with a prompt-hash fallback if the installed `Message` type has no `id`. Extract the existing prompt-hook budget logic into a shared helper so E8-B cannot drift from E8-A:

```ts
// Same file or a shared module; keep the existing metrics bumps at the call site.
async function buildPromptNoticeText(args: {
  promptText: string;
  ledger: LedgerStorage;
  projectID: string;
  sessionID: string;
  memoryRoot: string;
  options: MemoryOptions;
}): Promise<{
  text: string;
  statusShown: boolean;
  statusDropped: boolean;
  hintArms: boolean;
  hintShown: boolean;
}> {
  const { promptText, ledger, projectID, sessionID, memoryRoot, options } =
    args;
  const noticeBudget = promptNoticeBudget(
    options.indexLines,
    options.injectBudgetLines,
  );
  const rememberHint = await matchRememberNearMiss(promptText, {
    storage: ledger,
    projectID,
    sessionID,
    memoryRoot,
  });
  const hint =
    rememberHint ??
    (await matchIndex(promptText, {
      storage: ledger,
      projectID,
      sessionID,
      memoryRoot,
      indexLines: options.indexLines,
    }));
  const hintArms = rememberHint === undefined && hint !== undefined;
  const statusFits = promptStatusFits(noticeBudget, hint !== undefined);
  const hasStatus = await hasStatusLine(ledger, projectID);
  const status =
    statusFits && hasStatus
      ? await statusLine(ledger, projectID, {
          indexLines: options.indexLines,
        })
      : undefined;
  const statusDropped = !statusFits && hasStatus;
  const handoff = await newestHandoffLine(memoryRoot);
  const plan = planPromptNotices({
    handoff,
    status,
    hint,
    budget: noticeBudget,
  });
  return {
    text: plan.text,
    statusShown: status !== undefined,
    statusDropped,
    hintArms,
    hintShown: hint !== undefined,
  };
}
```

Then the context hook:

```ts
import { extractLatestUserText, promptHashFor } from "./hints.js";

const promptText = extractLatestUserText(event.messages) ?? "";
const lastUserMessage = event.messages
  .filter((message) => message.role === "user")
  .at(-1) as { id?: string; role: string; content?: unknown } | undefined;
const promptID = lastUserMessage?.id ?? promptHashFor(promptText);
const bundleKey = `e8b/${event.sessionID}`;
const cached = await ctx.storage.get(bundleKey);
let bundle: string;
if (
  cached !== undefined &&
  typeof cached === "object" &&
  cached !== null &&
  "promptID" in cached &&
  cached.promptID === promptID &&
  typeof cached.text === "string"
) {
  bundle = cached.text;
} else {
  const brief = await loadBrief(memoryRoot, {
    fileLines: options.fileLines,
    maxLines: briefInjectionCap(options.indexLines, options.injectBudgetLines),
  });
  const notices = await buildPromptNoticeText({
    promptText,
    ledger,
    projectID,
    sessionID: event.sessionID,
    memoryRoot,
    options,
  });
  bundle = [brief, notices.text].filter(Boolean).join("\n");
  await ctx.storage.set(bundleKey, { promptID, text: bundle });
  if (notices.statusShown) bump("status.shown");
  else if (notices.statusDropped) bump("status.dropped");
  if (notices.hintShown) {
    bump("hint.shown");
    if (notices.hintArms) await setArm(ledger, projectID, event.sessionID);
  }
}
if (bundle.length > 0) event.system.push({ type: "text", text: bundle });
```

`planPromptNotices` enforces the same budget as E8-A: pointer dropped first, then status, never a hint. `statusLine` is called only when `statusFits && hasStatus`, so a tight budget leaves the notice queued instead of consuming it invisibly. `plan.text` carries the marker on its first line; the marker is inert in system text. If you prefer marker-free system text, strip the marker suffix without changing the line count.

`src/hints.ts`'s `extractLatestUserText` already accepts the `event.messages` array and reads `role` + `content`; use it rather than inventing a second parser. Keep **one** bundle per session, overwritten when the last user message ID (or hash fallback) changes, so storage does not grow per prompt.

The production context hook must not write debug files. The harness's `e8-b` variant patch (Task 8 Step 4) adds a measurement-only write of the computed bundle to `<project>/.e8-bundle.txt` so `validateRun` can assert the branch; that patch exists only in the copied variant.

Remove the notice block from the `prompt` hook (the prompt hook keeps INDEX attach and the remember fast path). Remove imports that become unused (`appendPromptNotices`, `planPromptNotices`, `statusLine`, `newestHandoffLine`, etc. only if no other call site uses them); `npm run typecheck` must stay clean. The status/hint are now computed in the context hook; the hint throttle still uses the session/prompt hash. `statusLine` consumes notices on the first call and the frozen bundle repeats the same text on later calls; the next prompt recomputes and may consume new notices.

- [ ] **Step 2: Add tests**

`test/hooks.test.ts`:

- two context calls in the same prompt receive identical system text;
- a second prompt (different last user message ID) recomputes and can change the bundle;
- a status notice is consumed once and repeated identically in the frozen bundle;
- a hint is present on every call of the same prompt (no re-injection churn);
- the prompt hook no longer appends notices to `event.prompt.text`;
- the snapshot writer remains per-call (it may update the brief for the next prompt, but not the frozen bundle);
- storage has one key per session, overwritten on prompt change;
- with `injectBudgetLines - indexLines < 3`, a status notice is **not** consumed: it stays queued and can appear on a later prompt; the pointer is dropped first and a hint is retained;
- repeated context calls for the same prompt do not bump `status.shown`/`hint.shown` twice (the frozen bundle is computed once);
- update the existing E8-A assertions (prompt-tail append, context-prefix stability, quoted-marker/budget cases) and the `brief.injected`/`brief.lines`/`brief.empty` expectations to the frozen-bundle placement; do not leave a test asserting the prompt-tail block is appended to `event.prompt.text`.

`test/prompt-notices.test.ts`:

- the bundle builder order is brief, pointer, status, hint;
- the budget planner still drops the pointer first, then status, never a hint.

Run:

```bash
npx vitest run test/hooks.test.ts test/prompt-notices.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit the implementation before re-measuring**

The harness's `src/` dirty guard is intentional. Commit the code and tests first, then verify the tree is clean:

```bash
npx vitest run test/hooks.test.ts test/prompt-notices.test.ts
git add src/index.ts src/prompt-notices.ts test/hooks.test.ts test/prompt-notices.test.ts
git commit -m "feat: freeze E8 notices per prompt (E8-B)"
test -z "$(git status --porcelain -- src)" && echo "src clean"
```

Expected: tests pass, commit succeeds, `src clean`.

- [ ] **Step 4: Add the `e8-b` variant and re-measure**

`sourceFor` copies the working-tree `src/` for `e8-b` and `8a1f2bb` for `e8-a` (the same pin as Task 7 Step 4). For the `e8-b` copy only, patch the context hook to write the computed bundle to `<project>/.e8-bundle.txt` (outside the model request) so `validateRun` can assert the notice marker/label and the frozen text. Add `e8-b` to `VARIANTS`, the self-test, the `validateRun` expectations (prompt text unchanged; `.e8-bundle.txt` contains the notice marker/label; no skill/shell), and the comparison labels. Run:

```bash
node scripts/e8-cache-measure.mjs --run \
  --model google/gemini-3.5-flash-lite \
  --variants pre-e8,e8-a,e8-b \
  --compare pre-e8:e8-a --compare pre-e8:e8-b --compare e8-a:e8-b \
  --reps 3 --scenarios hint,status \
  --pace-ms 6000 --max-retries 4 \
  --out /tmp/opencode/e8-measurement-e8b-2026-10-27
```

Expected: 18 valid runs (3 variants × 2 scenarios × 3 reps). If fewer than 5 of the 6 `e8-a:e8-b` pairs are valid, record "not measurable" for the change branch and keep issue #22 open; do not cherry-pick.

- [ ] **Step 5: Decide whether E8-B actually wins**

Report `e8-b` vs `pre-e8` and `e8-b` vs `e8-a` with the same `N`/`T` rule. Apply the §2.6 Step 4 **loss-case** adoption rule (the `+0.05` bound is E8-B vs pre-E8; the `−0.05` bound is E8-B vs E8-A). Compute `N`/`T` separately for each comparison; do not pool the two baselines and do not restate a different threshold. If E8-B fails the rule, record that it did not win and leave issue #22 open with the evidence. Record the cross-prompt trade-off explicitly. Do not claim a win from E8-B if the cache did not improve.

- [ ] **Step 6: Update the docs**

Spec §5.2: E8-B is the fallback; the system prefix is frozen per prompt (no within-turn churn) but a new prompt can still invalidate history; the prompt text stays clean. README: same, plus the trade-off. ADR-0002/0004/0007: a new 2026-10-27 revision explaining why E8-A was not kept and what E8-B changes. CHANGELOG: the change. Add the E8-B comparison table and the adoption/rejection verdict to `docs/2026-10-27-e8-measurement.md`.

- [ ] **Step 7: Run gates and commit the docs/harness**

```bash
npm run typecheck
npm test
node scripts/e8-cache-measure.mjs --self-test
npx prettier --check README.md CHANGELOG.md docs/design-spec-v2-production.md docs/2026-10-27-e8-measurement.md
git diff --check
git add scripts/e8-cache-measure.mjs docs/2026-10-27-e8-measurement.md \
  docs/design-spec-v2-production.md README.md CHANGELOG.md \
  docs/adr/0002-agents-md-injection.md docs/adr/0004-ledger-and-promotion.md \
  docs/adr/0007-untrusted-memory-content.md
git commit -m "docs: record E8-B frozen-bundle measurement"
```

If the docs update changes `src/` or tests, that is a bug in this task: the implementation was committed in Step 3. Revert the stray change and re-run the focused tests.

---

### Task 9: Verification, changelog, and PR

**Files:** none beyond the selected branch; verify everything.

- [ ] **Step 1: Run the full verification suite**

```bash
npm run typecheck
npm test
npm run test:coverage
node scripts/e8-cache-measure.mjs --self-test
npx prettier --check README.md CHANGELOG.md docs/design-spec-v2-production.md docs/2026-10-27-e8-measurement.md docs/2026-10-20-e8-cache-placement-spike.md
git diff --check
```

Expected: typecheck clean; all tests pass; coverage thresholds pass; `self-test ok`; Prettier clean; no whitespace errors.

- [ ] **Step 2: Verify the docs match the chosen placement**

Check each of these against the actual code:

- Spec §5.2 says prompt-tail, attachment, or E8-B exactly as implemented.
- README budget/visibility language matches.
- ADR-0002/0004/0007 revisions match.
- CHANGELOG entry matches.
- The measurement doc's decision matches.
- No doc claims a billed-token saving; no doc says the line budget is a token metric.

- [ ] **Step 3: Verify the transcript visibility statement is explicit**

Search for the word "visible" in the spec/README/measurement doc:

```bash
grep -n "transcript\|visible\|visibility" README.md docs/design-spec-v2-production.md docs/2026-10-27-e8-measurement.md
```

Expected: a clear sentence in each surface that the prompt-tail block is visible (keep), the user text is clean (attachment), or the system bundle is repeated (E8-B). No "model-facing only" wording that implies the user cannot see it.

- [ ] **Step 4: Verify no secrets or private content leaked**

```bash
grep -RniE "api[_-]?key|authorization|bearer|GEMINI_API_KEY=[^<]" \
  docs/2026-10-27-e8-measurement.md scripts/e8-cache-measure.mjs || true
```

Expected: no key values. The word `GEMINI_API_KEY` in a command is fine only when it is an env reference, not a value. The raw exports contain only fixture text and token fields; do not commit them.

- [ ] **Step 5: Push and open the PR**

```bash
git status --short
git log --oneline -5
git push -u origin issue-22-e8-cache-placement
gh pr create --repo nexusnv/opencode-nexusnv-memory \
  --base main --head issue-22-e8-cache-placement \
  --title "E8: measure cache placement and decide the prompt-tail surface" \
  --body-file /tmp/opencode/e8-pr-body.md
```

Use `gh pr create` after writing the body to `/tmp/opencode/e8-pr-body.md`. The body must link issue #22 and include:

- the provider/model/account tier and date;
- the two-prompt/multi-tool method;
- the paired raw and adjusted deltas;
- the decision and rationale;
- the UX verdict and whether transcript visibility is accepted;
- the explicit non-claims (one provider, free tier, no billed-token claim, no production metrics);
- the follow-ups (DeepSeek/OpenAI/Anthropic runs when keys are available; #26 for the broader UX pass).

- [ ] **Step 6: Comment on issue #22**

```bash
gh issue comment 22 --repo nexusnv/opencode-nexusnv-memory \
  --body "Measurement complete: <summary + link to the doc + decision>. The issue is <kept open for a multi-provider follow-up | closed by PR #N>."
```

If the result is "not measurable", do not close the issue; comment with the blocker and the exact failed commands.

---

## 5. Acceptance mapping

| Issue #22 acceptance bullet                                                                    | Where covered                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Measured numbers for at least one caching provider, or "not measurable" and stays open/blocked | Tasks 2–5; §2.7                              |
| No billed-token savings claim without measurement                                              | §2.1, §2.6, Task 5 Step 6; free-tier account |
| Written keep / attachment / E8-B / not-measurable decision with rationale                      | §2.6; Task 5 Step 7                          |
| Tests and docs match the chosen placement                                                      | Task 6/7/8 per branch; Task 9 Step 2         |
| If unchanged, accepting transcript visibility is explicit                                      | Task 5 Step 5; Task 6 Step 1; Task 9 Step 3  |
| Two prompts, multi-tool turn, stable brief                                                     | §2.2, §2.3; Task 1 Steps 8–9; Task 4         |
| Input/output, cache read/write, hit rate, raw fields                                           | §2.4; Task 5 Steps 2–4                       |
| Compare pre-E8 with current placement                                                          | §2.2; Task 4                                 |
| Record date, provider, model, account tier                                                     | §2.1; Task 5 Step 1                          |
| UX review as a user would                                                                      | §2.6; Task 5 Step 5                          |
| No production cache metrics, no budget change, no general redesign                             | Non-goals; file map                          |

---

## 6. Risks and rollback

- **Free-tier quota (15 RPM):** the primary risk. Pace at 6 s, retry 429 with backoff, and never parallelize. If the quota is exhausted, stop and record "not measurable"; do not switch to a model without recording the substitution.
- **Provider cache granularity:** Gemini's implicit cache may report a large shared base-prefix hit. Use paired medians and baseline-adjusted reads, not a single run's hit rate. If the adjustment is unstable, report both and treat a sign disagreement as "not measurable".
- **Plugin load race:** `--standalone` plus a unique project per attempt plus the load marker. Never reuse a project directory across attempts; that was the draft's failure mode.
- **Snapshot writer:** disabled in the copies to keep the brief byte-identical. Disclose it. If production snapshot cadence is the real question, that is a follow-up measurement, not this issue.
- **Model nondeterminism:** skill/MCP/shell denial and a fixed `read` prompt; validate every run; use 3 reps. If the model still refuses `read`, record the invalid run and retry; do not count it.
- **Scope creep:** do not add a sixth config option, a new metric name, a budget change, or a production cache counter. The measurement is a dev script + docs.
- **Rollback:** if the measurement is invalid or the decision is not measurable, revert only the harness/doc commits if they are not wanted; leave `src/` untouched. If a change branch is implemented and the re-measurement fails, `git revert` the change commit and restore the keep/not-measurable doc.

---

## 7. Self-review notes

- The plan's primary evidence is the paired `3 reps × 2 scenarios` run, not the smoke.
- The harness is dev-only and not in the npm package; `package.json` is unchanged.
- The account tier is recorded from the provider's own 429 text, not inferred from the cost field.
- The decision rule has a cache-neutral path that still requires the UX gate; a neutral result cannot silently become a "win".
- The keep branch's docs edits make transcript visibility explicit in spec/README/measurement/ADR; the issue's "not implicit" requirement is met.
- The attachment and E8-B branches are conditional and mutually exclusive; do not execute both.
- The plan does not claim billed savings, production metrics, or a budget change.
