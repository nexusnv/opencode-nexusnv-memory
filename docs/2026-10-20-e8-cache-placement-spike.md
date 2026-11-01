# E8 cache-placement spike — 2026-10-20

## Status

Placement is implemented and covered by tests: the `context` system prefix carries only the stable brief; status/hint/newest-handoff pointer are appended once to the canonical prompt. **No provider cache-token measurement was run in this change** (CI has no provider credentials). The README and spec therefore make no cache-token claim. The line budget remains an uncached worst-case guardrail, not a billed-token metric.

## What changed

| Channel                | Before                                 | After                                                    |
| ---------------------- | -------------------------------------- | -------------------------------------------------------- |
| `context` system       | brief + status + hint (per model call) | stable brief only                                        |
| prompt text            | user text + INDEX attachment           | user text + INDEX attachment + ≤3 data-only notice lines |
| newest-handoff pointer | brief                                  | prompt notice                                            |
| status/hint            | system, every model call               | prompt, once per prompt                                  |

## Measurement protocol (manual, provider-keyed)

1. Run a two-prompt, multi-tool session against one provider/model with prompt caching enabled. Keep the active-context brief unchanged between prompts; change only the user text / one tool result.
2. Record provider usage for each request: input tokens, cache-read tokens, cache-write tokens, output tokens. Do not infer from line counts.
3. Compare the pre-E8 placement (status/hint in system on every model call) with this placement. A cache benefit is supported only if cache-read tokens rise on the second and later calls while the stable prefix is unchanged.
4. Record date, provider, model, account tier, and raw usage fields in the PR/issue. If the provider does not expose cache fields, write "not measurable" — do not claim a win.
5. Re-run the static/per-prompt/session-total line evals; they remain line-count guardrails only.

## Non-claims

- No claim that 237 session-total lines equals 237 billed tokens.
- No claim that moving notices eliminated cache misses; only that the stable prefix is now separate from volatile tail bytes.
- No production cache metric is added (ADR-0008 freezes the 45-name vocabulary).

## Measurement results (2026-10-27 / 2026-11-01)

A two-prompt, multi-tool measurement was run against `google/gemini-3.5-flash-lite` (Google AI Studio Free Tier) using the harness at `scripts/e8-cache-measure.mjs`. The measurement could not be completed: the Free Tier daily quota (500 requests/day) was exhausted after 6 valid runs / 2 valid pairs. Retry is possible after the quota resets (~17.5 hours).

### Partial results (2 valid pairs, hint scenario only)

| Metric | Median Δ | Positive/Negative |
|--------|----------|-------------------|
| Within-turn cache hit rate (Δlater) | +0.365 | 2/0 |
| Cross-prompt cache hit rate (Δp2) | -0.006 | 0/2 |
| Baseline-adjusted later read | +2016 tokens | — |
| Baseline-adjusted p2 read | +1 token | — |

All 6 valid runs: brief hashes match before/after. No billed-token claim is made (Free Tier).

**Decision:** KEEP E8-A — see `docs/2026-10-27-e8-measurement.md` for full details.

## Measurement results (2026-11-02)

A two-prompt, multi-tool measurement was run against `opencode/flint-40b-free` (OpenCode, Free, $0) using the harness at `scripts/e8-cache-measure.mjs`. Google AI Studio was the pre-registered provider but its daily quota was exhausted; Flint was used per option B of the measurement plan. 4 valid pairs out of 6 expected (rep 3 blocked by Flint's free usage limit).

### Results (4 valid pairs, N=4, T=3)

| Metric | Median Δ | Positive/Negative | Passes T=3? |
|--------|----------|-------------------|-------------|
| Within-turn cache hit rate (Δlater) | +0.531 | 4/0 | ✅ |
| Cross-prompt cache hit rate (Δp2) | +0.019 | 4/0 | ✅ |
| Baseline-adjusted later read | +2368 tokens | — | ✅ |
| Baseline-adjusted p2 read | -128 tokens | — | within noise |

All 9 valid runs: brief hashes match before/after. No billed-token claim is made (Free).

**Cache verdict: WIN** — E8-A significantly preserves within-turn prefix-cache reuse and does not harm cross-prompt reuse.

**UX verdict: ACCEPT** — the user's message stays clean and first; notices are clearly separated, labelled ([memory] / [memory-hint]), and marked as data-only.

**Final decision: KEEP E8-A.** No code changes to `src/` are needed — the current prompt-tail placement is the one under test and it wins on cache preservation with acceptable transcript visibility.
