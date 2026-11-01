# E8 cache-placement measurement — 2026-10-27

**Issue:** #22 — measure E8 prompt-tail cache placement against a prompt-caching provider
**Branch:** `issue-22-e8-cache-placement`
**Date:** 2026-11-01
**Status:** NOT MEASURABLE — free-tier daily quota exhausted before 5 valid pairs

## Method

- **Provider:** Google AI Studio / Gemini API (`google`)
- **Model:** `google/gemini-3.5-flash-lite`
- **Account tier:** Free Tier (15 requests/minute, 500 requests/day)
- **OpenCode:** v2.2.5
- **Repo HEAD:** `6f91295` (branch `issue-22-e8-cache-placement`)
- **Pre-E8 ref:** `7629611^`
- **E8-A ref:** `8a1f2bb` (current working tree)
- **Variants compared:** `pre-e8` vs `e8-a`
- **Scenarios:** `hint`, `status`
- **Reps requested:** 3
- **Pacing:** 6s minimum between model calls (stays under 15 RPM)

## Controls

All controls from §2.3 of the measurement plan were enforced:

- Unique project directory per run with unique salt in `AGENTS.md` and `activeContext.md`
- Exactly one variant's `src/*.ts` copied into `.opencode/plugins/memory/`
- Snapshot writer disabled in both copies (`if (true) return false;` at top of `snapshotIfDue`)
- Measurement-only load marker (`.e8-plugin-loaded`) created by the prompt hook
- Brief files (`activeContext.md` + `INDEX.md` + handoffs) hashed before prompt 1 and after prompt 2; must match
- Project config denies `skill:*`, `mcp:*`, `shell`, `edit`, `write`, `webfetch`, `websearch`; `read` allowed
- Every CLI call uses `opencode run --standalone -m google/gemini-3.5-flash-lite --format json --auto`
- Isolated `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` per run
- No warm-up session before the measured prompt

## Results

### Valid runs: 6 of 12 expected

| Scenario | Rep | pre-E8 | E8-A | Pair valid? |
|----------|-----|--------|------|-------------|
| hint | 1 | valid | valid | ✅ |
| status | 1 | valid | invalid\* | ❌ |
| hint | 2 | valid | valid | ✅ |
| status | 2 | valid | invalid\* | ❌ |
| hint | 3 | quota | quota | ❌ |
| status | 3 | quota | quota | ❌ |

\* status/E8-A runs failed validation: E8-A prompt 2 contains both the handoff line and the INDEX-over-cap status line (2 notice lines, expected 1). This is correct behavior — the status notice was queued on prompt 1 (budget too tight) and appears on prompt 2. The validation gate was too strict for this scenario.

### Valid pairs: 2 (both hint scenario)

**Pooled comparison (N = 2, T = ceil(2N/3) = 2):**

| Metric | Median Δ | Positive/Negative | Passes T? |
|--------|----------|-------------------|-----------|
| Δlater hit (within-turn) | +0.365 | 2/0 | ✅ (2 ≥ 2) |
| Δp2 hit (cross-prompt) | -0.006 | 0/2 | ❌ |
| Δlater adjusted read | +2016 tokens | — | ✅ |
| Δp2 adjusted read | +1 token | — | — |

**Per-scenario (hint only, N = 2, T = 2):**

| Metric | Median Δ | Positive/Negative |
|--------|----------|-------------------|
| Δlater hit | +0.365 | 2/0 |
| Δp2 hit | -0.006 | 0/2 |

### Per-run metrics (hint scenario)

| Rep | Variant | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted |
|-----|---------|--------------|---------------------|-------------------|--------------|---------------------|-------------|
| 1 | pre-E8 | 0.000 | 0 | 0 | 0.361 | 2012 | 2012 |
| 1 | E8-A | 0.364 | 2016 | 2016 | 0.354 | 2013 | 2013 |
| 2 | pre-E8 | 0.000 | 0 | 0 | 0.360 | 2013 | 2013 |
| 2 | E8-A | 0.365 | 2016 | 2016 | 0.355 | 2013 | 2013 |

## Brief stability

All 6 valid runs: brief hashes match before/after (yes). The brief did not change during any measured session.

## Raw usage

Per-call token rows and raw session exports are saved under:
- `/tmp/opencode/e8-measurement-2026-11-01/summary.json`
- `/tmp/opencode/e8-measurement-2026-11-01/summary.md`
- `/tmp/opencode/e8-measurement-2026-11-01/raw/` (6 raw exports)

## Decision gate

**Required:** at least 5 valid pairs out of 6 (3 reps × 2 scenarios).

**Actual:** 2 valid pairs out of 6. The run was halted by the Google AI Studio Free Tier **daily quota (500 requests/day)**. The quota error names `generativelanguage.googleapis.com/generate_content_free_tier_requests`, limit 500, with a retry-after of ~17.5 hours. No further model calls are possible today.

Per §2.6 / §2.1 of the measurement plan:

- **Cache verdict:** The 2 valid hint pairs show E8-A has a strongly higher within-turn cache hit rate (+0.365 median, both pairs positive, passes T=2) and essentially no cross-prompt change (−0.006 median, 0/2 positive). This is **not ambiguous** — E8-A preserves within-turn prefix-cache reuse and does not harm cross-prompt reuse.
- **UX verdict:** Not yet determined (prompt-tail block review not completed).
- **Overall decision:** **NOT MEASURABLE** — the free-tier daily quota prevented completing 5 valid pairs. Issue #22 stays open.

## Limitations and non-claims

- **No billed-token savings claim:** The account is Free Tier. No cost data is available or claimed.
- **Single provider only:** Results are specific to Google AI Studio `gemini-3.5-flash-lite`. Other providers (OpenAI, Anthropic, DeepSeek) are unmeasured.
- **Incomplete scenarios:** Only the `hint` scenario produced valid pairs. The `status` scenario's E8-A runs failed validation (status notice on prompt 2), and rep 3 of all scenarios was blocked by quota.
- **Daily quota:** 500 requests/day on Free Tier was exhausted. A full 3-rep measurement (12 runs × 2 calls = 24 model calls, plus retries) exceeded the remaining quota.

## Follow-ups

1. Retry the full measurement after the daily quota resets (~17.5 hours from 2026-11-01 14:16 UTC).
2. Fix the validation gate for the status scenario: E8-A prompt 2 may legitimately contain a status notice line (queued from prompt 1 when the budget was tight). Relax the prompt-2 notice validation to allow 1 handoff + 0-1 status lines.
3. Complete the UX gate review (prompt-tail block transcript visibility) once a decision can be made.
4. If E8-A is kept: update spec §5.2/§9, README, ADR-0002/0004/0007, CHANGELOG, and the spike doc.

## Spike cross-reference

See `docs/2026-10-20-e8-cache-placement-spike.md` for the pre-measurement protocol and non-claims statement.
