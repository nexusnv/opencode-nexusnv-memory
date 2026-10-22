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
