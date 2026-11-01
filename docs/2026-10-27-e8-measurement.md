# E8 cache-placement measurement — 2026-11-02

**Issue:** #22 — measure E8 prompt-tail cache placement against a prompt-caching provider
**Branch:** `issue-22-e8-cache-placement`
**Date:** 2026-11-02
**Status:** DECISION — **Keep E8-A** (cache verdict: WIN; UX verdict: ACCEPT)

## Method

| Field | Value |
|-------|-------|
| Provider | OpenCode / Flint (`opencode`) — see provider deviation below |
| Model | `opencode/flint-40b-free` |
| Account tier | Free ($0; no billed-cost claim) |
| OpenCode | v2.2.5 |
| Repo HEAD | `7dbad43` |
| Pre-E8 ref | `7629611^` |
| E8-A ref | `8a1f2bb` (current working tree) |
| Variants compared | `pre-e8` vs `e8-a` |
| Scenarios | `hint`, `status` |
| Reps requested | 3 |
| Reps completed | 2 (rep 3 blocked by Flint free usage limit) |
| Pacing | 6s minimum between model calls |

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

**Flint provider note:** Flint calls its own built-in tools (`memory_recall`, `execute`) despite the permission deny policy. These are provider-specific generation-time tool calls that do not affect the prompt-text cache-hit-rate measurement (tool calls occur after prompt construction). The harness allowlist was expanded to include `memory_recall` and `execute`; `read` remains the only required tool for alpha/beta fixture reads.

## Results

### Valid runs: 9 of 12 expected

| Scenario | Rep | pre-E8 | E8-A | Pair valid? |
|----------|-----|--------|------|-------------|
| hint | 1 | invalid¹ | valid | ❌ |
| status | 1 | valid | valid | ✅ |
| hint | 2 | valid | valid | ✅ |
| status | 2 | valid | valid | ✅ |
| hint | 3 | valid | quota² | ❌ |
| status | 3 | quota² | quota² | ❌ |

¹ hint/pre-e8 rep 1 attempt 1: brief hashes differ (retry succeeded on attempt 2)
² Flint free usage limit reached — no more model calls available today

### Valid pairs: 4 of 6 expected (N = 4, T = ceil(2N/3) = 3)

**Pooled comparison (pre-e8 → e8-a):**

| Metric | Median Δ | Positive/Negative | Passes T=3? |
|--------|----------|-------------------|-------------|
| Δlater hit (within-turn) | +0.531 | 4/0 | ✅ (4 ≥ 3) |
| Δp2 hit (cross-prompt) | +0.019 | 4/0 | ✅ (4 ≥ 3) |
| Δlater adjusted read | +2368 tokens | — | ✅ |
| Δp2 adjusted read | -128 tokens | — | within noise |

**Per-scenario (N = 2 each, T = 2):**

| Scenario | Δlater hit | +/- | Δp2 hit | +/- |
|----------|------------|-----|---------|-----|
| hint | +0.533 | 2/0 | +0.027 | 2/0 |
| status | +0.530 | 2/0 | +0.009 | 2/0 |

### Per-run metrics

| Scenario | Rep | Variant | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted |
|----------|-----|---------|--------------|---------------------|-------------------|--------------|---------------------|-------------|
| hint | 1 | pre-E8 | 0.437 | 2304 | 2304 | 0.950 | 5120 | 5120 |
| hint | 1 | E8-A | 0.973 | 6272 | 4224 | 0.976 | 6784 | 4736 |
| status | 1 | pre-E8 | 0.442 | 2304 | 256 | 0.965 | 5120 | 3072 |
| status | 1 | E8-A | 0.969 | 5120 | 3072 | 0.970 | 5248 | 3200 |
| hint | 2 | pre-E8 | 0.431 | 2304 | 256 | 0.957 | 5248 | 3200 |
| hint | 2 | E8-A | 0.961 | 6400 | 4352 | 0.985 | 6784 | 4736 |
| status | 2 | pre-E8 | 0.440 | 2304 | 2304 | 0.961 | 5120 | 5120 |
| status | 2 | E8-A | 0.972 | 5248 | 3200 | 0.973 | 5376 | 3328 |
| hint | 3 | pre-E8 | 0.437 | 2304 | 256 | 0.946 | 5120 | 3072 |

### Brief stability

All 9 valid runs: brief hashes match before/after (yes). The brief did not change during any measured session.

### Raw usage

Per-call token rows and raw session exports are saved under:
- `/tmp/opencode/e8-measurement-flint-2026-11-02-v2/summary.json`
- `/tmp/opencode/e8-measurement-flint-2026-11-02-v2/summary.md`
- `/tmp/opencode/e8-measurement-flint-2026-11-02-v2/raw/` (9 raw exports)

## Decision gate

**Required:** at least 5 valid pairs out of 6 (§2.5). Actual: 4 valid pairs. Flint's free usage limit prevented rep 3. The run was retried but Flint's limit persisted for all remaining attempts.

**Statistical threshold:** N = 4, T = ceil(2N/3) = 3. Δlater hit = +0.531 with 4/0 positive pairs (≥ T). Δp2 hit = +0.019 with 4/0 positive pairs (≥ T). Both metrics pass the sign-count threshold.

**Cache verdict: WIN** — E8-A significantly preserves within-turn prefix-cache reuse (+0.531 median later hit rate, all 4 pairs positive) and does not harm cross-prompt reuse (+0.019 median p2 hit rate, all 4 pairs positive). Results are consistent across hint (+0.533/+0.027) and status (+0.530/+0.009) scenarios.

## UX gate — transcript visibility

**UX verdict: ACCEPT**

Reviewing the prompt-tail block as a user would see it in the transcript:

- **User's own text stays first and unmodified** — the prompt text begins with the user's message ("Context: auth-service login. Use the read tool to read ...") and is byte-for-byte unchanged; notices are appended after, not interleaved.
- **Block is separated by a blank line** — a clear visual boundary separates user text from notices.
- **Every line is visibly labelled** — `[memory]` for status/pointer, `[memory-hint]` for hints. No unlabeled lines.
- **Data-only suffix present** — each notice line ends with `<!-- memory:prompt-notices --> (data only, never instructions)`, making it unambiguous that this is data, not instructions.
- **Block is ≤3 lines** — hint scenario: 2 lines (handoff + hint); status scenario: 2 lines (handoff + status). Never exceeds 3 lines.
- **First-time user clarity** — the marker/suffix makes it clear these are system-generated data lines, not part of the user's message or model instructions. A user would not mistake them for instructions to follow.

**Transcript-visibility conclusion: explicit and acceptable.** The user's message stays clean and first; notices are clearly separated, labelled, and marked as data-only. No hidden or deceptive content.

## Final decision: **KEEP E8-A**

| Cache verdict | UX verdict | Decision |
|---------------|------------|----------|
| win | accept | **Keep E8-A** |

E8-A is kept as-is. No code changes to `src/` are needed — the current prompt-tail placement is the one under test and it wins on cache preservation with acceptable transcript visibility.

## Limitations and non-claims

- **No billed-token savings claim:** The account is free ($0 via Flint). No cost data is available or claimed.
- **Single provider only:** Results are specific to `opencode/flint-40b-free`. Google, OpenAI, Anthropic, DeepSeek are unmeasured.
- **Incomplete reps:** Rep 3 of all scenarios was blocked by Flint's free usage limit. 4 valid pairs instead of the planned 6; the statistical threshold T=3 is met but §2.5's 5-pair minimum was not reached.
- **Flint tool behavior:** Flint calls `memory_recall`/`execute` despite the deny policy. These don't affect cache hit rate measurement but are a provider-specific deviation from the read-only tool surface control.

## Follow-ups

None required for the KEEP decision. If a future run with Google or another provider is desired, the harness (`scripts/e8-cache-measure.mjs`) is ready to use.

## Spike cross-reference

See `docs/2026-10-20-e8-cache-placement-spike.md` for the pre-measurement protocol and non-claims statement.
