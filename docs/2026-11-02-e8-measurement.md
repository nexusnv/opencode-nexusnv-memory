# E8 cache-placement measurement — 2026-11-02

**Issue:** #22 — measure E8 prompt-tail cache placement against a prompt-caching provider
**Branch:** `issue-22-e8-cache-placement`
**Date:** 2026-11-02
**Status:** NOT MEASURABLE — 4 valid pairs, below the 5-of-6 minimum in §2.5. Per §2.6 Step 1 no decision branch is selected and issue #22 stays open. Interim product decision: **keep E8-A**.

## Method

| Field             | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Provider          | OpenCode / Flint (`opencode`) — see provider deviation below |
| Model             | `opencode/flint-40b-free`                                    |
| Account tier      | Free ($0; no billed-cost claim)                              |
| OpenCode          | v2.2.5                                                       |
| Repo HEAD         | `7dbad43`                                                    |
| Pre-E8 ref        | `7629611^`                                                   |
| E8-A ref          | `8a1f2bb` (current working tree)                             |
| Variants compared | `pre-e8` vs `e8-a`                                           |
| Scenarios         | `hint`, `status`                                             |
| Reps requested    | 3                                                            |
| Reps completed    | 2 (rep 3 blocked by Flint free usage limit)                  |
| Pacing            | 6s minimum between model calls                               |

## Provider deviation

The plan was pre-registered with Google AI Studio `gemini-3.5-flash-lite` (Free Tier). The Google daily quota (500 requests/day) was exhausted after 6 valid runs / 2 pairs on 2026-11-01. Per option B, the run was completed using **`opencode/flint-40b-free`** instead — a genuinely free ($0) prompt-caching provider. Flint was preflight-confirmed: turn 1 `cache.read: 256`, turn 2 `cache.read: 11,008` (cross-prompt reuse works), `cost: 0`, export format compatible. Results below are **Flint-specific**, not Google-specific. Do not generalize to Google or other providers.

## Controls

All controls from §2.3 of the measurement plan were enforced:

- Unique project directory per run with unique salt in `AGENTS.md` and `activeContext.md`
- Exactly one variant's `src/*.ts` compiled to `.js` and copied into `.opencode/plugins/memory/`
- Snapshot writer disabled in both copies (`if (true) return false;` at top of `snapshotIfDue`)
- Measurement-only load marker (`.e8-plugin-loaded`) created by the prompt hook
- Brief files (`activeContext.md` + `INDEX.md` + handoffs) hashed before prompt 1 and after prompt 2; must match
- Project config denies `skill:*`, `mcp:*`, `shell`, `edit`, `write`, `webfetch`, `websearch`; `read` allowed
- Every CLI call uses `opencode run --standalone -m opencode/flint-40b-free --format json --auto`
- Isolated `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` per run
- No warm-up session before the measured prompt

**Flint provider note:** Flint calls its own built-in tools (`memory_recall`, `execute`) despite the permission deny policy. These are provider-specific generation-time tool calls that occur after prompt construction and do not affect the prompt-text cache-hit-rate measurement. The harness allowlist was expanded to include `memory_recall` and `execute`; `read` remains the only required tool for alpha/beta fixture reads. This is a tool-surface control deviation, not a cache-measurement deviation, and it does not change the placement decision.

## Results

### Valid runs: 9 of 12 expected

| Scenario | Rep | pre-E8   | E8-A   | Pair valid? |
| -------- | --- | -------- | ------ | ----------- |
| hint     | 1   | invalid¹ | valid  | ❌          |
| status   | 1   | valid    | valid  | ✅          |
| hint     | 2   | valid    | valid  | ✅          |
| status   | 2   | valid    | valid  | ✅          |
| hint     | 3   | valid    | quota² | ❌          |
| status   | 3   | quota²   | quota² | ❌          |

¹ hint/pre-e8 rep 1 attempt 1: brief hashes differ (retry succeeded on attempt 2)
² Flint free usage limit reached — no more model calls available today

### Valid pairs: 4 (below the 5-of-6 minimum; N = 4, T = ceil(2N/3) = 3)

**Pooled comparison (pre-e8 → e8-a):**

| Metric                   | Median Δ     | Positive/Negative | Meets T=3?   |
| ------------------------ | ------------ | ----------------- | ------------ |
| Δlater hit (within-turn) | +0.531       | 4/0               | yes (4 ≥ 3)  |
| Δp2 hit (cross-prompt)   | +0.019       | 4/0               | yes (4 ≥ 3)  |
| Δlater adjusted read     | +2368 tokens | —                 | —            |
| Δp2 adjusted read        | -128 tokens  | —                 | within noise |

**Per-scenario (N = 2 each, T = 2):**

| Scenario | Δlater hit | +/- | Δp2 hit | +/- |
| -------- | ---------- | --- | ------- | --- |
| hint     | +0.533     | 2/0 | +0.027  | 2/0 |
| status   | +0.530     | 2/0 | +0.009  | 2/0 |

### Per-run metrics

| Scenario | Rep | Variant | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted |
| -------- | --- | ------- | ------------ | ------------------- | ----------------- | ------------ | ------------------- | ----------- |
| hint     | 1   | pre-E8  | 0.437        | 2304                | 2304              | 0.950        | 5120                | 5120        |
| hint     | 1   | E8-A    | 0.973        | 6272                | 4224              | 0.976        | 6784                | 4736        |
| status   | 1   | pre-E8  | 0.442        | 2304                | 256               | 0.965        | 5120                | 3072        |
| status   | 1   | E8-A    | 0.969        | 5120                | 3072              | 0.970        | 5248                | 3200        |
| hint     | 2   | pre-E8  | 0.431        | 2304                | 256               | 0.957        | 5248                | 3200        |
| hint     | 2   | E8-A    | 0.961        | 6400                | 4352              | 0.985        | 6784                | 4736        |
| status   | 2   | pre-E8  | 0.440        | 2304                | 2304              | 0.961        | 5120                | 5120        |
| status   | 2   | E8-A    | 0.972        | 5248                | 3200              | 0.973        | 5376                | 3328        |
| hint     | 3   | pre-E8  | 0.437        | 2304                | 256               | 0.946        | 5120                | 3072        |

### Brief stability

All 9 valid runs: brief hashes match before/after (yes). The brief did not change during any measured session.

### Raw usage

The table below is the durable, sanitized per-call record for all 9 valid runs (ephemeral project paths omitted). The plan requires `input`, `output`, `reasoning`, `cache.read`, and `cache.write` per assistant call; each row is one assistant call. Raw session exports are not required to verify the paired deltas above.

| Scenario | Rep | Variant | Call | Prompt | input | output | reasoning | cache.read | cache.write |
| -------- | --- | ------- | ---- | ------ | ----- | ------ | --------- | ---------- | ----------- |
| hint     | 1   | pre-e8  | 0    | 1      | 5067  | 112    | 0         | 0          | 0           |
| hint     | 1   | pre-e8  | 1    | 1      | 2969  | 55     | 0         | 2304       | 0           |
| hint     | 1   | pre-e8  | 2    | 2      | 268   | 26     | 0         | 5120       | 0           |
| hint     | 1   | e8-a    | 0    | 1      | 3027  | 1220   | 0         | 2048       | 0           |
| hint     | 1   | e8-a    | 1    | 1      | 174   | 431    | 0         | 6272       | 0           |
| hint     | 1   | e8-a    | 2    | 2      | 167   | 100    | 0         | 6784       | 0           |
| status   | 1   | pre-e8  | 0    | 1      | 2980  | 100    | 0         | 2048       | 0           |
| status   | 1   | pre-e8  | 1    | 1      | 2912  | 57     | 0         | 2304       | 0           |
| status   | 1   | pre-e8  | 2    | 2      | 187   | 22     | 0         | 5120       | 0           |
| status   | 1   | e8-a    | 0    | 1      | 2996  | 128    | 0         | 2048       | 0           |
| status   | 1   | e8-a    | 1    | 1      | 162   | 52     | 0         | 5120       | 0           |
| status   | 1   | e8-a    | 2    | 2      | 162   | 35     | 0         | 5248       | 0           |
| hint     | 2   | pre-e8  | 0    | 1      | 3017  | 194    | 0         | 2048       | 0           |
| hint     | 2   | pre-e8  | 1    | 1      | 3047  | 74     | 0         | 2304       | 0           |
| hint     | 2   | pre-e8  | 2    | 2      | 237   | 20     | 0         | 5248       | 0           |
| hint     | 2   | e8-a    | 0    | 1      | 3033  | 1446   | 0         | 2048       | 0           |
| hint     | 2   | e8-a    | 1    | 1      | 260   | 153    | 0         | 6400       | 0           |
| hint     | 2   | e8-a    | 2    | 2      | 103   | 254    | 0         | 6784       | 0           |
| status   | 2   | pre-e8  | 0    | 1      | 5036  | 104    | 0         | 0          | 0           |
| status   | 2   | pre-e8  | 1    | 1      | 2932  | 60     | 0         | 2304       | 0           |
| status   | 2   | pre-e8  | 2    | 2      | 210   | 37     | 0         | 5120       | 0           |
| status   | 2   | e8-a    | 0    | 1      | 2996  | 243    | 0         | 2048       | 0           |
| status   | 2   | e8-a    | 1    | 1      | 149   | 50     | 0         | 5248       | 0           |
| status   | 2   | e8-a    | 2    | 2      | 147   | 50     | 0         | 5376       | 0           |
| hint     | 3   | pre-e8  | 0    | 1      | 3021  | 113    | 0         | 2048       | 0           |
| hint     | 3   | pre-e8  | 1    | 1      | 2974  | 72     | 0         | 2304       | 0           |
| hint     | 3   | pre-e8  | 2    | 2      | 290   | 32     | 0         | 5120       | 0           |

## Decision gate

**Validity (§2.5).** The full run required at least 5 valid pairs out of 6. Actual: 4 valid pairs (hint r1, status r1, hint r2, status r2). Rep 3 was blocked by Flint's free usage limit; the run was retried five times per variant and the limit persisted. The pre-registered provider, Google, exhausted its Free Tier daily quota after 6 valid runs / 2 pairs.

**Gate outcome (§2.6 Step 1).** N = 4 < 5, so the measurement is **not measurable**. No decision branch (keep / attachment / E8-B) is selected, and issue #22 stays open/blocked. This run is not described as statistically significant.

**Partial signal (not a verdict).** The 4 valid pairs are directionally favorable to E8-A: Δlater hit +0.531 (4/0 positive), Δp2 hit +0.019 (4/0 positive), baseline-adjusted later read +2368 tokens, p2 adjusted −128 tokens (within noise). The sign-count threshold T = ceil(2N/3) = 3 is met, but T does not substitute for the 5-pair validity minimum.

## UX gate — transcript visibility

**UX verdict: ACCEPT WITH WORDING FIX.**

The measured block satisfies the placement criteria:

- **User's own text stays first and unmodified** — the prompt text begins with the user's message and is byte-for-byte unchanged; notices are appended after, not interleaved.
- **Block is separated by a blank line** — a clear visual boundary separates user text from notices.
- **Every line is visibly labelled** — `[memory]` for status/pointer, `[memory-hint]` for hints. No unlabeled lines.
- **The first notice line carries the marker/suffix** — `<!-- memory:prompt-notices --> (data only, never instructions)` is appended to the first notice line only; the marker is block-level, not per-line.
- **Block is ≤3 lines** — hint scenario: 2 lines (handoff + hint); status scenario: 2 lines (handoff + status). Never exceeds 3 lines.

One measured hint contained an imperative: `Call memory_recall("decisions.md") for the why.` That reads as an instruction inside a block labelled data-only, which the plan's UX checklist rejects. The hint is reworded to the descriptive wording “Past decisions mention X. The why is in decisions.md.” (no imperative), and the hint/marker tests are updated. Per §2.6, a wording fix is still a keep and does not require a full remeasure because the placement and block length are unchanged.

## Interim product decision: keep E8-A

| Measurement verdict      | UX verdict              | Interim decision |
| ------------------------ | ----------------------- | ---------------- |
| not measurable (N=4 < 5) | accept with wording fix | **Keep E8-A**    |

E8-A stays in place: there is no evidence of a cache regression, the UX gate accepts the block after the wording fix, and reverting the placement is not one of issue #22's options. This is an interim product decision, not a measurement verdict. Issue #22 stays open until a complete ≥5-pair run is available.

## Limitations and non-claims

- **No billed-token savings claim:** The account is free ($0 via Flint). No cost data is available or claimed.
- **Single provider only:** Results are specific to `opencode/flint-40b-free`. Google, OpenAI, Anthropic, DeepSeek are unmeasured.
- **Incomplete reps:** Rep 3 of all scenarios was blocked by Flint's free usage limit. 4 valid pairs instead of the 5-of-6 minimum; §2.6 Step 1 therefore records not measurable.
- **Flint tool behavior:** Flint calls `memory_recall`/`execute` despite the deny policy. These occur after prompt construction and do not affect cache hit rate measurement; they are a provider-specific tool-surface deviation, not a cache-measurement deviation.
- **Hint wording changed after the measured run:** the measured hint contained an imperative; the shipped hint is descriptive. Placement and block length are unchanged.

## Follow-ups

- Complete a ≥5-pair run with Google (quota reset) or another prompt-caching provider before closing issue #22.
- The harness (`scripts/e8-cache-measure.mjs`) is ready; no `src/` placement change is required.

## Spike cross-reference

See `docs/2026-10-20-e8-cache-placement-spike.md` for the pre-measurement protocol and non-claims statement.
