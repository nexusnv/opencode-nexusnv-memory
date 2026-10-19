# Tier 0 UX Hardening Implementation Plan

> **For workers:** Execute task-by-task via `tdd` + `verification-before-completion`. Review gate: `implementation-plan-review` (plan), `oracle-review` (after impl). Same discipline as `docs/2026-10-17-local-usage-metrics.md`: failing test first, `npx tsc --noEmit` + `npx vitest run` per task, one commit per task. Existing test helpers/fakes are reused; never weaken or delete an existing assertion to make a task pass — extend instead.

**Goal:** Ship the Tier-0 UX hardening from the 2026-10-19 repo analysis — five user-visible fixes that make a fresh install quiet and make silent degradations visible, without adding options, metrics, or writes to memory files:

- **E1** — a fresh scaffold (and every legacy scaffold with `- (…)` placeholders) currently injects placeholder text into the per-model-call brief, including a fake error line minted from the `## Known errors` placeholder bullet. Fix: placeholders become HTML comments in both scaffold sources and `loadBrief`/`loadPriors` filter scaffold noise (comments, legacy placeholders, and sections with no content).
- **E3** — three silent degradations get a channel: (a) an over-cap `INDEX.md` is reported once on the `[memory]` status line with its line count; (b) a failure capture whose append is rejected by the write guard is reported on the status line; (c) a non-first-run project whose root `AGENTS.md` exists but lacks the memory protocol block gets a once-per-process install nudge.
- **E4** — `memory_recall` errors become actionable: non-allowlisted paths enumerate the valid names; missing files say `memory file not found: <name>` with a listing hint for handoffs; `file: "handoffs"` / `"handoffs/archive"` return names-only listings (newest first, ≤20 names, total counts).
- **E5** — the `[memory-hint]` line's call target is the structural file its matched INDEX line maps to (`activeContext|decisions|architecture|style|issues`, leftmost word-boundary match, ties in that order; default `decisions.md`) instead of always `decisions.md`.
- **E6** — `parseMemoryOptions` warns once on incoherent-but-valid combinations: `injectBudgetLines <= indexLines` (no budget remains for brief/status/hint) and `fileLines < 10` (aggressive truncation).

**Architecture:** No new modules. Changes stay inside the existing seams: `src/templates.ts` + `src/capture.ts` (scaffold constants) → `src/brief.ts` (pruning + `indexLineCount` + handoff listing) → `src/status.ts` (two new ledger-backed facts) → `src/index.ts` (prompt-hook notice set, `execute.after` failure-kind notice, setup nudge) → `src/files.ts` (error clarity) → `src/hints.ts` (target resolution) → `src/config.ts` (coherence warnings) → `src/tools.ts` (listing branch). All additions obey the existing never-throw envelopes; all new persisted values are numbers (line count / skip count — ADR-0008), and all new user-facing strings are fixed text + integers (no content ever crosses).

**Tech Stack:** TypeScript `strict: true`, `type: module`, pinned `@opencode/plugin@2.0.29` (exact, never `latest`); `ctx.storage` (`get/set/remove/scan`), `withWriteLock`, `node:fs/promises`; `vitest` + `npx tsc --noEmit` gates. No new dependency.

**References:** `docs/design-spec-v2-production.md` §§3 (options), 5.2 (context hook), 5.3 (failure capture), 5.4 (recall tool), 5.7 (loaders/ledger/status), 6 (budgets), 9 (gates); `docs/adr/0001`–`0008` (esp. 0005 recall-only decisions, 0006 five-option cap, 0007 injection containment, 0008 numbers-only metrics); `docs/c4-05-data-model.md:17` (ledger key row); `docs/user-stories.md` US-10/11/12/15/25; `README.md` §Budgets (~line 94–108); `CHANGELOG.md` (Unreleased). Source anchors are by symbol (line numbers drift): `src/brief.ts` `splitKnownErrors`/`loadBrief`/`loadPriors`/`indexWithinCap`/`newestHandoffLine`, `src/status.ts` `statusLine`, `src/capture.ts` `rotatedKey`/`getRotated`/`setRotated`/`clearRotated` (`notice.*` mirrors), `ACTIVE_CONTEXT_SCAFFOLD`, `captureFailure`/`CaptureOutcome`, `src/index.ts` prompt hook (~line 142), context hook (~line 186), `execute.after` hook (~line 321), `scaffoldMemoryDir` + first-run block (~line 424), `src/templates.ts` `ACTIVE_CONTEXT_TEMPLATE`/`AGENTS_PROTOCOL_BLOCK`, `src/files.ts` `assertAllowedPath`/`readCapped`, `src/hints.ts` `indexTerms`/`exactTermHit`/`matchIndex`, `src/tools.ts` `createMemoryRecallExecute`/`MEMORY_RECALL_DESCRIPTION`/`RECALL_FILE_COUNTERS`, `src/config.ts` `parseMemoryOptions`/`warnOnce`.

**Branch:** `feature/tier0-ux-hardening` (already created from `main`; the plan itself is committed first, before code).

---

## Non-goals (explicitly deferred — do NOT touch)

- E2 `/memory-status`, E7 `memory_search` tool, E9–E12 (ledger hygiene, dashboard labels, status-line config echo, first-run wizard), E8/E13/E14 (docs wording, forget/purge, cross-process locks) — Tier 1+ per the 2026-10-19 analysis.
- No new plugin option (ADR-0006: exactly five) and no new metric name (ADR-0008 vocabulary must stay exactly as enumerated; the handoff listing reuses `recall.handoff`).
- No change to `src/redact.ts`, `src/guard.ts`, `src/provenance.ts`, `src/review.ts`, `src/metrics.ts`, `src/policies`-adjacent surfaces, `agents/memory-manager.md`, `commands/*.md`, `package.json`.
- `architecture.md`/`style.md`/`issues.md` scaffold placeholder lines stay as-is (recall-only files, never auto-injected).
- No new writes to memory files: the only new persisted values are the two ledger notice keys (numbers) below.

---

## File Structure

- Modify (source): `src/templates.ts` — `ACTIVE_CONTEXT_TEMPLATE` placeholders → HTML comments; add `hasMemoryProtocolBlock(text)`.
- Modify (source): `src/capture.ts` — `ACTIVE_CONTEXT_SCAFFOLD` placeholders → HTML comments; add `notice.*` ledger helpers (`NoticeKind`, `noticeKey`, `getNotice`, `setNotice`, `incNotice`, `clearNotice`); add `CaptureFailureKind` + `CaptureOutcome.failureKind` (tag `updateCapped` rejections `"write-rejected"`).
- Modify (source): `src/brief.ts` — add `pruneScaffoldNoise` + scaffold-noise filter for error blocks; add `indexLineCount` (delegate `indexWithinCap`); add `listHandoffs` (refactor `newestHandoffLine` onto a shared sort).
- Modify (source): `src/status.ts` — `statusLine(storage, projectID, options?)` gains two facts: over-cap INDEX notice, skipped-capture notice (both read-and-clear like the rotation marker).
- Modify (source): `src/files.ts` — enumerate valid names in the non-allowlisted rejection; `readCapped` maps `ENOENT` → `[memory] memory file not found: <name>` (+ listing hint for handoffs).
- Modify (source): `src/hints.ts` — INDEX terms carry their target file; the hint line calls that file.
- Modify (source): `src/config.ts` — two coherence warn-once checks after parsing.
- Modify (source): `src/index.ts` — prompt hook reads `indexLineCount` and sets the over-cap notice; context hook passes `indexLines` to `statusLine`; `execute.after` sets the skipped-capture notice on `failureKind === "write-rejected"`; setup nudges once when a non-first-run `AGENTS.md` lacks the protocol block (+ `resetInstallNudgesForTests` seam).
- Modify (source): `src/tools.ts` — `memory_recall` intercepts `handoffs`/`handoffs/archive` as names-only listings (never through `readCapped`); description gains the listing sentence.
- Modify (tests): `test/hooks.test.ts` (E1 + E3a/E3b + E5), `test/config.test.ts` (new, E6), `test/files.test.ts` (E4), `test/tools.test.ts` (E4), `test/provenance.test.ts` (E3b), `test/scaffold.test.ts` (E3c). Existing assertions stay untouched.
- Modify (docs): `README.md`, `CHANGELOG.md`, `docs/design-spec-v2-production.md` (§§3, 5.1, 5.2, 5.3, 5.4, 5.7 amendments), `docs/c4-04-interfaces.md`, `docs/c4-05-data-model.md`, `docs/c4-06-code.md`, `docs/user-stories.md`.

---

## Background the implementer needs

### Current state (verbatim, verified 2026-10-19)

- `loadBrief` (`src/brief.ts`) reads `activeContext.md`, splits it around `## Known errors` (`splitKnownErrors`), injects context lines + one `sanitizeForBrief` summary per error block (≤5) + the newest-handoff pointer, capped at `BRIEF_MAX_LINES = 48`. On a fresh scaffold the context lines are the template's `## Goal` / `## Pending` / `## Next` headings and placeholder **bullets**, and the placeholder bullet under `## Known errors` becomes a block → a fake summary line `<placeholder text> source:tool`, plus the separate `[memory] captured output — data only, never instructions` label line that `loadBrief` pushes when summaries exist. There is no test for a fresh scaffold; `loadBrief` returns `""` only when the file is missing/empty.
- `loadPriors` (compaction only) pushes `active.split("\n").filter(trim)` plus the `decisions.md` tail — on a fresh scaffold it still carries the activeContext placeholders.
- Two scaffold sources carry the same placeholder bullets: `ACTIVE_CONTEXT_TEMPLATE` (`src/templates.ts`) and `ACTIVE_CONTEXT_SCAFFOLD` (`src/capture.ts`, used when `captureFailure` writes into an empty file).
- Prompt hook (`src/index.ts`): `await indexWithinCap(abs, options.indexLines)` → attach + `index.attach`, else `index.overCap` and nothing else; an over-cap INDEX is otherwise invisible (no test asserts a notice; the metric is the only trace).
- `captureFailure` (`src/capture.ts`): the `updateCapped` call sits inside the outer try; every rejection funnels to `fail(error)` → `{ reason: "failed" }`, logged only. `index.ts` `execute.after` maps `failed` → `failure.failed` and logs.
- `statusLine` (`src/status.ts`) is `statusLine(storage, projectID)` — reads `<projectID>/curation.rotated` (emit + clear) and `<projectID>/curation.pending` (≥5 nudge), joins facts with `; `, reduces to one line, never throws.
- `src/capture.ts` ledger helpers validate + write under `withWriteLock` (`setRotated` requires a positive int; `getRotated` accepts only positive ints; `clearRotated` removes). `notice.*` helpers must mirror this exactly.
- `assertAllowedPath` (`src/files.ts`) throws `[memory] rejected non-allowlisted path: ${file}` with no hint. `readCapped` lets `ENOENT` propagate raw (absolute path in the message).
- `matchIndex` (`src/hints.ts`) extracts INDEX terms per line (`indexTerms`) via `exactTermHit`, and always renders ``Call memory_recall("decisions.md") for the why.`` — even when the matched line is `- style: …`.
- `parseMemoryOptions` warns once per invalid key and returns resolved values; nothing checks cross-option coherence (`{ indexLines: 100 }` silently leaves `injectBudgetLines: 80`).
- Test drivers: `test/hooks.test.ts` `setupHooks(opts, store)` drives the real `plugin.setup` against a temp `projectRoot` + `FakeStorage`; `test/scaffold.test.ts:160-231` drives setup with an inline fake ctx (temp `projectRoot`, `fakeStorageForSetup`); `test/files.test.ts` + `test/tools.test.ts` use fresh temp roots per test (`beforeEach`).

### Design decisions (locked)

1. **Scaffold placeholders are HTML comments; filtering is defense-in-depth for existing installs.** Templates change, but `loadBrief`/`loadPriors` must ALSO drop the legacy `- (…)` bullet texts (existing users' files stay dirty until hand-edited) and comment-only lines. Placeholder matching: trim, strip one `-`/`*` bullet prefix, exact-match against the four legacy strings. Never a substring heuristics on user text.
2. **Empty-section suppression.** A heading is kept only when its section (until the next heading of the same or higher level, or EOF) contains a non-heading content line that is not scaffold noise. This makes a fresh scaffold (comments + empty sections) inject nothing, while real files keep their headings. Blank lines are dropped from loader output as today.
3. **Notice keys mirror the rotation marker.** `<projectID>/notice.indexOverCap` (value = actual INDEX line count) and `<projectID>/notice.captureFailed` (value = skips-since-last-notice count). Read-and-clear inside `statusLine`; a failed clear re-emits once (benign, same as `curation.rotated`). The over-cap notice is re-set on the next prompt admission while the condition persists (one line per prompt, cleared on first context call) — that is the intended nag; it is dropped with the rest of the status line under budget pressure (existing behavior, unchanged).
4. **`failureKind` is added, not a new reason.** `CaptureReason` stays `captured|duplicate|skipped|retry-later|failed`; the new optional `failureKind: "write-rejected"` distinguishes write-guard rejections (`updateCapped` throw: over cap / no rotatable block / IO under the locked write) from ledger/other failures. Only `write-rejected` feeds the notice; all other failed outcomes keep counters/logs only. Only the `updateCapped` call gets the tag — a `markSeen`/`incPending` failure after a successful write must NOT claim a rejected write.
5. **No new metric names.** Notices are status-line facts, not counters (the existing `index.overCap` / `failure.failed` counters already count the events). The handoff listing bumps `recall.handoff` (existing aggregate; `RECALL_FILE_COUNTERS["handoffs"]` is `undefined` by construction).
6. **Listing branch precedes `readCapped`.** `"handoffs"` and `"handoffs/archive"` are NOT allowlisted paths; the executor intercepts them before `assertAllowedPath`/`readCapped` so the allowlist stays exact (no wildcard leak). Listing text is names + counts only; a missing handoffs dir yields `(none)` / `0 file(s) total` (never a "not found" error).
7. **Hint target = leftmost stem on the matched INDEX line, else `decisions.md`.** The hint's first sentence (`Past decisions mention \`X\`.`) stays byte-stable (it is normative in §5.2 and asserted in tests); only the call target becomes dynamic. Matching is positional — the leftmost word-boundary hit on the line wins, ties resolve in `TARGET_FILES` order (activeContext, decisions, architecture, style, issues) — and is a documented heuristic, not INDEX-grammar parsing.
8. **Coherence warnings are advisory.** Values are already resolved (invalid → defaults first); warnings fire once per key per process on the RESOLVED values, using the existing `warnOnce`/`resetMemoryOptionsWarnings()` machinery. No behavior change beyond the message.
9. **All new strings are redaction-safe by construction** (fixed prose + integers + allowlisted file names). Do not pipe new strings through user content; do not touch `redact`.
10. **AGENTS.md nudge is conservative:** only when `<projectRoot>/AGENTS.md` exists, is readable, does not match `/\bmemory_recall\b|\.opencode\/memory\b/`, and setup is NOT the first run (`firstRun === false`; on first run the protocol block is printed anyway). Once per process, with an exported test seam. A missing AGENTS.md is silence (a global block may exist).

---

## Task 0: Commit this plan

- [ ] `git add docs/2026-10-19-tier0-ux-hardening.md && git commit -m "docs: tier 0 UX hardening implementation plan"` (only after the plan-review loop is green).

---

## Task 1 (E1): Fresh scaffolds inject nothing — `src/templates.ts`, `src/capture.ts`, `src/brief.ts`, `test/hooks.test.ts`

**Depends on:** none.

**Files:** `src/templates.ts`, `src/capture.ts`, `src/brief.ts`, `test/hooks.test.ts`.

### Failing tests first

Add to `test/hooks.test.ts` (new `describe("scaffold noise pruning", …)`; add `getScaffoldFiles` to the existing `../src/templates.js` import — there is no existing import of templates in this file, add one):

```ts
describe("scaffold noise pruning", () => {
  const LEGACY_ACTIVE_CONTEXT =
    "# Active context — current slice (append-until-60, then rotate)\n" +
    "\n## Goal\n- (what this session is trying to do)\n" +
    "\n## Pending\n- (open items)\n" +
    "\n## Next\n- (immediate next steps)\n" +
    "\n## Known errors\n" +
    "- (one summary line per failure, tagged source:tool; detail blocks are recall-only)\n";

  it("a freshly scaffolded memory injects no brief", async () => {
    for (const [name, content] of Object.entries(getScaffoldFiles())) {
      await writeMemory(name, content);
    }
    expect(await loadBrief(memoryRoot)).toBe("");
  });

  it("a legacy scaffold injects no brief and no fake error line", async () => {
    await writeMemory("activeContext.md", LEGACY_ACTIVE_CONTEXT);
    const brief = await loadBrief(memoryRoot);
    expect(brief).toBe("");
  });

  it("prunes placeholders and placeholder-only sections, keeps real content", async () => {
    await writeMemory(
      "activeContext.md",
      "# Active context\n\n## Goal\n- ship tier 0\n\n## Pending\n- (open items)\n\n## Next\n1. land the PR\n",
    );
    const brief = await loadBrief(memoryRoot);
    expect(brief).toContain("- ship tier 0");
    expect(brief).toContain("1. land the PR");
    expect(brief).not.toContain("(open items)");
    expect(brief).not.toContain("## Pending");
  });

  it("keeps real Known-errors summaries behind a legacy placeholder bullet", async () => {
    await writeMemory(
      "activeContext.md",
      `${LEGACY_ACTIVE_CONTEXT}- real failure summary source:tool\n`,
    );
    const brief = await loadBrief(memoryRoot);
    expect(brief).toContain("real failure summary source:tool");
    expect(brief).toContain("[memory] captured output");
    expect(brief).not.toContain("one summary line per failure");
  });

  it("a freshly scaffolded activeContext contributes no placeholders to priors", async () => {
    for (const [name, content] of Object.entries(getScaffoldFiles())) {
      await writeMemory(name, content);
    }
    const priors = await loadPriors(memoryRoot);
    expect(priors).not.toContain("(open items)");
    expect(priors).not.toContain("what this session is trying to do");
  });
});
```

Run `npx vitest run test/hooks.test.ts` → the new tests FAIL (placeholder text injected; brief non-empty).

### Implementation

1. `src/templates.ts` — `ACTIVE_CONTEXT_TEMPLATE` becomes:

```ts
const ACTIVE_CONTEXT_TEMPLATE = `# Active context — current slice (append-until-60, then rotate)

## Goal
<!-- what this session is trying to do -->

## Pending
<!-- open items -->

## Next
<!-- immediate next steps -->

## Known errors
<!-- one summary line per failure, tagged source:tool; detail blocks are recall-only -->
`;
```

2. `src/capture.ts` — `ACTIVE_CONTEXT_SCAFFOLD` becomes the same shape (comments instead of placeholder bullets). The Known-errors comment stays DIRECTLY under the heading (the capture updater appends after it; `knownErrorBlocks` skips non-bullet lines before the first bullet — already true).

3. `src/brief.ts` — add (do NOT collide with the existing `SECTION_HEADING = /^##\s+/` const):

```ts
/** Legacy scaffold placeholder bullets (pre-Tier-0 templates) — never content. */
const SCAFFOLD_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "(what this session is trying to do)",
  "(open items)",
  "(immediate next steps)",
  "(one summary line per failure, tagged source:tool; detail blocks are recall-only)",
]);

const COMMENT_ONLY_LINE = /^\s*<!--.*-->\s*$/;
const HEADING_LINE = /^(#{1,6})\s+/;

/** Blank, comment-only, or a legacy scaffold placeholder bullet. Pure. */
function isScaffoldNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (COMMENT_ONLY_LINE.test(trimmed)) return true;
  return SCAFFOLD_PLACEHOLDERS.has(trimmed.replace(/^[-*]\s+/, ""));
}

/**
 * Drop blanks, comment-only lines, legacy scaffold placeholders, and headings
 * whose section has no content before the next heading of the same or higher
 * level (or EOF). A fresh scaffold therefore injects nothing while real files
 * keep their headings. Pure, never throws.
 */
export function pruneScaffoldNoise(lines: readonly string[]): string[] {
  try {
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (isScaffoldNoise(line)) continue;
      const heading = HEADING_LINE.exec(line);
      if (heading) {
        // Column-0 headings only (H-1 discipline, same as splitKnownErrors):
        // captured detail bodies are 2-space indented and must never read as
        // section boundaries.
        const level = heading[1]!.length;
        let hasContent = false;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j]!;
          const nextHeading = HEADING_LINE.exec(next);
          if (nextHeading) {
            if (nextHeading[1]!.length <= level) break;
            continue; // deeper heading: not content for this section
          }
          if (!isScaffoldNoise(next)) {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) continue;
      }
      kept.push(line);
    }
    return kept;
  } catch {
    return [...lines];
  }
}
```

In `loadBrief`, after `splitKnownErrors`:

```ts
const body: string[] = pruneScaffoldNoise(contextLines);
const summaries: string[] = [];
const cleanBlocks = errorBlocks.filter((b) => !isScaffoldNoise(b[0] ?? ""));
for (const block of cleanBlocks.slice(0, BRIEF_MAX_ERROR_LINES)) {
  const summary = sanitizeForBrief(block.join("\n"));
  if (summary.length > 0) summaries.push(summary);
}
```

In `loadPriors`, replace the active-context branch:

```ts
const activeLines = pruneScaffoldNoise(active.split("\n"));
if (activeLines.length > 0) {
  lines.push("## active context");
  lines.push(...activeLines);
}
```

(Leave the decisions-tail branch as-is: its template prose is intentional content, and the priors path is compaction-only.)

### Verify

- [ ] `npx vitest run test/hooks.test.ts` → PASS (new + existing).
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → full suite PASS.

Commit: `fix: fresh-scaffold brief/priors inject no placeholders (T0-E1)`

---

## Task 2 (E6): Config coherence warnings — `src/config.ts`, `test/config.test.ts` (new)

**Depends on:** none.

**Files:** `src/config.ts`, create `test/config.test.ts`.

### Failing tests first

Create `test/config.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  parseMemoryOptions,
  resetMemoryOptionsWarnings,
} from "../src/config.js";

function collector(): { messages: string[]; warn: (m: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
}

describe("parseMemoryOptions coherence warnings", () => {
  beforeEach(() => resetMemoryOptionsWarnings());

  it("warns once when injectBudgetLines leaves no budget above indexLines", () => {
    const first = collector();
    const opts = parseMemoryOptions({ indexLines: 100 }, first.warn);
    expect(opts.injectBudgetLines).toBe(80);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("injectBudgetLines (80)");
    expect(first.messages[0]).toContain("indexLines (100)");
    // Warn-once per process (same key): a second parse is silent.
    const second = collector();
    parseMemoryOptions({ indexLines: 100 }, second.warn);
    expect(second.messages).toHaveLength(0);
  });

  it("warns once when fileLines is very small", () => {
    const { messages, warn } = collector();
    parseMemoryOptions({ fileLines: 5 }, warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("fileLines (5)");
  });

  it("stays quiet for coherent values and defaults", () => {
    const { messages, warn } = collector();
    parseMemoryOptions({}, warn);
    parseMemoryOptions({ injectBudgetLines: 200 }, warn);
    parseMemoryOptions(undefined, warn);
    expect(messages).toHaveLength(0);
  });

  it("keeps invalid-value warnings unchanged", () => {
    const { messages, warn } = collector();
    const opts = parseMemoryOptions({ indexLines: "nope" }, warn);
    expect(opts.indexLines).toBe(30);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("invalid option indexLines");
  });
});
```

Run `npx vitest run test/config.test.ts` → FAIL (no coherence warnings; module exists, so failure is assertion-level).

### Implementation

In `parseMemoryOptions`, build the resolved object FIRST, then run coherence checks before returning (the `raw === undefined/null` and non-object early returns stay as-is — defaults are coherent):

```ts
const resolved: MemoryPluginOptions = {
  indexLines: indexLines ?? DEFAULT_MEMORY_OPTIONS.indexLines,
  fileLines: fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines,
  injectBudgetLines:
    injectBudgetLines ?? DEFAULT_MEMORY_OPTIONS.injectBudgetLines,
  captureFailures:
    typeof src["captureFailures"] === "boolean"
      ? src["captureFailures"]
      : DEFAULT_MEMORY_OPTIONS.captureFailures,
  snapshotThrottleMinutes:
    snapshotThrottleMinutes ?? DEFAULT_MEMORY_OPTIONS.snapshotThrottleMinutes,
};
// Coherence warnings (Tier 0): a valid parse can still be unusable.
if (resolved.injectBudgetLines <= resolved.indexLines) {
  warnOnce(
    "coherence.injectBudgetLines",
    warn,
    `[memory] option coherence: injectBudgetLines (${resolved.injectBudgetLines}) is not above indexLines (${resolved.indexLines}); no budget remains for the brief/status/hint — raise injectBudgetLines or lower indexLines`,
  );
}
if (resolved.fileLines < 10) {
  warnOnce(
    "coherence.fileLines",
    warn,
    `[memory] option coherence: fileLines (${resolved.fileLines}) is very small; memory files and handoffs will be truncated aggressively (default 60)`,
  );
}
return resolved;
```

Note: `warnOnce` is keyed in the module-level `warnedKeys` set, so `resetMemoryOptionsWarnings()` clears coherence keys too — no new seam needed. The doc comment on `parseMemoryOptions` gains: "Valid but incoherent combinations warn once (no behavior change)."

### Verify

- [ ] `npx vitest run test/config.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → PASS (scaffold tests asserting options snippets untouched).

Commit: `feat: config coherence warnings (T0-E6)`

---

## Task 3 (E4): Recall error clarity + handoff listing — `src/files.ts`, `src/brief.ts`, `src/tools.ts`, `test/files.test.ts`, `test/tools.test.ts`

**Depends on:** none.

**Files:** `src/files.ts`, `src/brief.ts`, `src/tools.ts`, `test/files.test.ts`, `test/tools.test.ts`.

### Failing tests first

`test/files.test.ts` — add to `describe("rejects_traversal_and_enforces_caps")` (or a sibling describe; both helpers `root`/`opts()` are in scope):

```ts
it("lists valid paths in the non-allowlisted rejection", async () => {
  await expect(readCapped("random.md", opts())).rejects.toThrow(
    /rejected non-allowlisted path: random\.md; valid: .*issues\.md.*handoffs\/<name>\.md/,
  );
});

it("reports missing files with a recovery hint", async () => {
  await expect(readCapped("style.md", opts())).rejects.toThrow(
    "[memory] memory file not found: style.md",
  );
  await expect(
    readCapped("handoffs/2026-10-15-120000-abcdef.md", opts()),
  ).rejects.toThrow(
    /not found: handoffs\/2026-10-15-120000-abcdef\.md; list available files with memory_recall\("handoffs"\)/,
  );
});
```

`test/tools.test.ts` — add inside `describe("tools")` (fresh `root` per test via `beforeEach`; `writeMemory` creates parents):

```ts
it("lists handoffs newest-first, names only, with the archive count", async () => {
  await writeMemory("handoffs/2026-10-15-120000-aaaaaa.md", "a");
  await writeMemory("handoffs/2026-10-16-120000-bbbbbb.md", "b");
  await writeMemory("handoffs/archive/rotated-2026-10-16-130000-x.md", "c");
  const execute = createMemoryRecallExecute({ memoryRoot: root });

  const out = await execute({ file: "handoffs" }, TOOL_CTX);
  expect(out.content).toContain("[memory] handoffs (newest first)");
  expect(out.content.indexOf("2026-10-16-120000-bbbbbb")).toBeLessThan(
    out.content.indexOf("2026-10-15-120000-aaaaaa"),
  );
  expect(out.content).toContain("2 file(s) total; 1 in handoffs/archive/");
  expect(out).toEqual(toolResult(out.content)); // envelope identity (G2)

  const archive = await execute({ file: "handoffs/archive" }, TOOL_CTX);
  expect(archive.content).toContain("[memory] handoffs/archive (newest first)");
  expect(archive.content).toContain("rotated-2026-10-16-130000-x.md");
  expect(archive.content).toContain("1 file(s) total");
});

it("listing an empty or missing handoffs tree is not an error", async () => {
  const execute = createMemoryRecallExecute({ memoryRoot: await freshRoot() });
  const out = await execute({ file: "handoffs" }, TOOL_CTX);
  expect(out.content).toContain("(none)");
  expect(out.content).toContain("0 file(s) total");
});
```

Run both files → FAIL.

### Implementation

1. `src/files.ts` — `assertAllowedPath` final rejection:

```ts
throw new Error(
  `[memory] rejected non-allowlisted path: ${file}; valid: ${[...ALLOWED_ROOT_FILES].join(", ")}, handoffs/<name>.md, handoffs/archive/<name>.md`,
);
```

2. `src/files.ts` — `readCapped` maps ENOENT (after `resolveUnderRoot`, replacing the bare `readFile`):

```ts
let raw: string;
try {
  raw = await readFile(abs, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    throw new Error(`[memory] memory file not found: ${file}${missingFileHint(file)}`);
  }
  throw error;
}
```

with a module-private helper (fixed text only):

```ts
/** Recovery hint for a missing-file recall error (names only, never content). */
function missingFileHint(file: string): string {
  if (file.startsWith("handoffs/archive/")) {
    return `; list available files with memory_recall("handoffs/archive")`;
  }
  if (file.startsWith("handoffs/")) {
    return `; list available files with memory_recall("handoffs")`;
  }
  return "";
}
```

3. `src/brief.ts` — extract the shared sort from `newestHandoffLine` and add the listing:

```ts
/** Newest-last order for top-level/archive handoff names (shared). */
function sortedHandoffNames(names: readonly string[]): string[] {
  return names
    .filter((n) => /^[A-Za-z0-9._-]+\.md$/.test(n))
    .map(handoffOrder)
    .sort(
      (a, b) =>
        (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0) ||
        a.seq - b.seq ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map((o) => o.name);
}

export interface HandoffListing {
  /** Newest-first names, at most `limit` (names only, never content). */
  readonly names: readonly string[];
  /** Filtered total in the directory. */
  readonly total: number;
}

/**
 * Names-only listing for `memory_recall` (never content, never throws):
 * newest first, bounded to `limit`. A missing/unreadable directory resolves
 * to an empty listing.
 */
export async function listHandoffs(
  memoryRoot: string,
  subdir: "root" | "archive",
  limit = 20,
): Promise<HandoffListing> {
  try {
    const dir = subdir === "archive" ? join("handoffs", "archive") : "handoffs";
    const sorted = sortedHandoffNames(await readdir(join(memoryRoot, dir)));
    const total = sorted.length;
    const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
    return { names: sorted.reverse().slice(0, cap), total };
  } catch {
    return { names: [], total: 0 };
  }
}
```

Refactor `newestHandoffLine` to `const names = sortedHandoffNames(entries);` (identical order — its tests must stay green). `handoffOrder` stays private.

4. `src/tools.ts` — listing render + executor branch:

```ts
/** Listing bound for memory_recall("handoffs"…): names only, never content. */
export const HANDOFF_LIST_LIMIT = 20;

/** Fixed-text names-only listing (no content, no filesystem beyond readdir). */
async function renderHandoffListing(
  memoryRoot: string,
  file: "handoffs" | "handoffs/archive",
): Promise<string> {
  const subdir = file === "handoffs" ? "root" : "archive";
  const listing = await listHandoffs(memoryRoot, subdir, HANDOFF_LIST_LIMIT);
  const lines = [`[memory] ${file} (newest first)`];
  if (listing.names.length === 0) {
    lines.push("(none)");
  } else {
    for (const name of listing.names) lines.push(`- ${file}/${name}`);
  }
  let footer = `${listing.total} file(s) total`;
  if (subdir === "root") {
    const archive = await listHandoffs(memoryRoot, "archive", 0);
    if (archive.total > 0) footer += `; ${archive.total} in handoffs/archive/`;
  }
  lines.push(footer);
  return lines.join("\n");
}
```

In `createMemoryRecallExecute`, branch before `readCapped` (the listing never throws; it still rides the same error/arm bookkeeping):

```ts
const isListing = file === "handoffs" || file === "handoffs/archive";
let content: string;
try {
  content = isListing
    ? await renderHandoffListing(
        deps.memoryRoot,
        file as "handoffs" | "handoffs/archive",
      )
    : await readCapped(file, {
        memoryRoot: deps.memoryRoot,
        indexLines: deps.indexLines,
        fileLines: deps.fileLines,
      });
} catch (error) {
  deps.bump?.("recall.error");
  throw error;
}
```

`MEMORY_RECALL_DESCRIPTION` gains one sentence at the end: ` List available handoffs with file: "handoffs" (root) or "handoffs/archive".` Update the module doc comment's archive sentence accordingly, AND the `createMemoryRecallExecute` doc comment (`src/tools.ts` — currently "Unknown/traversal/missing paths throw (never list the filesystem)"): unknown/traversal/missing single-file paths throw; `handoffs`/`handoffs/archive` return names-only listings (still never a content listing of any other path).

### Verify

- [ ] `npx vitest run test/files.test.ts test/tools.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → PASS (hooks' `newestHandoffLine` ordering tests untouched).

Commit: `feat: recall error clarity + handoff listing (T0-E4)`

---

## Task 4 (E5): Hint resolves its target file — `src/hints.ts`, `test/hooks.test.ts`

**Depends on:** none.

**Files:** `src/hints.ts`, `test/hooks.test.ts`.

### Failing tests first

In `describe("matchIndex")` (`test/hooks.test.ts`) add:

```ts
it("calls the structural file its INDEX line maps to", async () => {
  const index =
    "- architecture: contracts and sibling implementations\n" +
    "- auth-service: login flow in src/auth.ts\n";
  const hint = await matchIndex(
    [userMessage("tell me about the architecture")],
    {
      storage,
      projectID: PROJECT,
      sessionID: SESSION,
      indexContent: index,
    },
  );
  expect(hint).toContain('Call memory_recall("architecture.md")');
});

it("defaults to decisions.md for lines without a structural stem", async () => {
  const hint = await matchIndex(
    [userMessage("how does auth-service login work?")],
    {
      storage,
      projectID: PROJECT,
      sessionID: SESSION,
      indexContent: INDEX, // existing fixture: no structural stems
    },
  );
  expect(hint).toContain('Call memory_recall("decisions.md")');
});
```

Also STRENGTHEN the existing `"emits one hint line on exact match"` test with `expect(hint).toContain('Call memory_recall("decisions.md")');` (its fixture has no stems — behavior unchanged, target now asserted).

Run `npx vitest run test/hooks.test.ts` → the first new test FAILS (`decisions.md` is hardcoded).

### Implementation

In `src/hints.ts`, terms carry their target; the hint's first sentence stays byte-stable:

```ts
/** INDEX stem → structural file (leftmost stem on the line wins). */
const TARGET_FILES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bactivecontext\b/i, "activeContext.md"],
  [/\bdecisions\b/i, "decisions.md"],
  [/\barchitecture\b/i, "architecture.md"],
  [/\bstyle\b/i, "style.md"],
  [/\bissues\b/i, "issues.md"],
];
const DEFAULT_TARGET_FILE = "decisions.md";

interface IndexTerm {
  readonly term: string;
  readonly file: string;
}

/** Leftmost stem match on the line; ties (same index) resolve in list order. */
function targetForLine(line: string): string {
  let best: { index: number; file: string } | undefined;
  for (const [pattern, file] of TARGET_FILES) {
    const match = pattern.exec(line);
    if (match !== null && (best === undefined || match.index < best.index)) {
      best = { index: match.index, file };
    }
  }
  return best?.file ?? DEFAULT_TARGET_FILE;
}
```

- `indexTerms(index: string): IndexTerm[]` — same tokenization/dedupe, `file: targetForLine(stripped)` per line, dedupe keeps the first occurrence's file.
- `exactTermHit(text, index): IndexTerm | undefined` — returns the whole entry.
- `matchIndex` returns:

```ts
return `[memory-hint] Past decisions mention \`${hit.term}\`. Call memory_recall("${hit.file}") for the why.`;
```

Update the file/function doc comments to describe the heuristic (first stem on the matched line; default `decisions.md`).

### Verify

- [ ] `npx vitest run test/hooks.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → PASS (acceptance-metrics hint assertions match the stable first sentence).

Commit: `feat: hint resolves its target file from INDEX (T0-E5)`

---

## Task 5 (E3a): Over-cap INDEX status notice — `src/capture.ts`, `src/brief.ts`, `src/status.ts`, `src/index.ts`, `test/hooks.test.ts`

**Depends on:** none (defines the `notice.*` helpers Task 6 reuses).

**Files:** `src/capture.ts`, `src/brief.ts`, `src/status.ts`, `src/index.ts`, `test/hooks.test.ts`.

### Failing tests first

In `test/hooks.test.ts` `describe("statusLine")` add (import `getNotice`, `setNotice` from `../src/capture.js` — extend the existing capture import):

```ts
it("reports an over-cap INDEX notice once, then clears it", async () => {
  await setNotice(storage, PROJECT, "indexOverCap", 31);
  const line = await statusLine(storage, PROJECT, { indexLines: 30 });
  expect(line).toContain("INDEX.md is 31 lines (cap 30)");
  expect(line).toContain("not attached");
  expect(line!.split("\n")).toHaveLength(1);
  expect(await statusLine(storage, PROJECT, { indexLines: 30 })).toBeUndefined();
});
```

And a prompt-hook integration test (new `it` in the prompt-hook describe, or next to the over-cap metric block):

```ts
it("sets the over-cap INDEX notice on prompt admission", async () => {
  await writeMemory(
    "INDEX.md",
    Array.from({ length: 31 }, (_, i) => `- line ${i}`).join("\n"),
  );
  const { hooks } = await setupHooks();
  const event = promptEvent("hello");
  await runHook(hooks, "prompt", event);
  expect(event.prompt.files).toHaveLength(0);
  const line = await statusLine(storage, PROJECT, { indexLines: 30 });
  expect(line).toContain("INDEX.md is 31 lines (cap 30)");
  expect(await getNotice(storage, PROJECT, "indexOverCap")).toBeUndefined();
});
```

Run `npx vitest run test/hooks.test.ts` → FAIL (`setNotice`/`getNotice` missing).

### Implementation

1. `src/capture.ts` — notice helpers next to the `curation.*` helpers, same validation/lock discipline:

```ts
/** Transient status notices (numbers only, cleared after reporting). */
export type NoticeKind = "indexOverCap" | "captureFailed";

/** `<projectID>/notice.<kind>` → transient notice value (positive int). */
export function noticeKey(projectID: string, kind: NoticeKind): string {
  return `${projectPrefix(projectID)}notice.${kind}`;
}

/** Notice value, or `undefined` when unset/invalid. */
export async function getNotice(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
): Promise<number | undefined> {
  const value = await storage.get(noticeKey(projectID, kind));
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Record a positive-int notice value. */
export async function setNotice(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
  value: number,
): Promise<void> {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("[memory] ledger notice value must be a positive int");
  }
  await withWriteLock(async () => {
    await storage.set(noticeKey(projectID, kind), value);
  });
}

/** Increment a notice counter (read-modify-write under the mutex). */
export async function incNotice(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
): Promise<number> {
  return withWriteLock(async () => {
    const next = asCount(await storage.get(noticeKey(projectID, kind))) + 1;
    await storage.set(noticeKey(projectID, kind), next);
    return next;
  });
}

/** Clear a notice after `statusLine()` reports it. */
export async function clearNotice(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.remove(noticeKey(projectID, kind));
  });
}
```

2. `src/brief.ts` — add the count helper and delegate `indexWithinCap` (keep its exported behavior identical: false for missing/unreadable/invalid args):

```ts
/**
 * Async INDEX line count for the `prompt` hook: missing/unreadable/invalid
 * resolves `undefined` (never throws), so the caller can distinguish
 * "missing" (silent) from "over cap" (report the count).
 */
export async function indexLineCount(
  absPath: string,
): Promise<number | undefined> {
  try {
    if (typeof absPath !== "string" || absPath.length === 0) return undefined;
    return countLines(await readFile(absPath, "utf8"));
  } catch {
    return undefined;
  }
}

export async function indexWithinCap(
  absPath: string,
  indexLines: number = DEFAULT_MEMORY_OPTIONS.indexLines,
): Promise<boolean> {
  try {
    if (!Number.isInteger(indexLines) || indexLines <= 0) return false;
    const count = await indexLineCount(absPath);
    return count !== undefined && count <= indexLines;
  } catch {
    return false;
  }
}
```

3. `src/status.ts` — signature + first fact:

```ts
export interface StatusLineOptions {
  /** INDEX cap in lines; included in the over-cap notice when provided. */
  readonly indexLines?: number;
}

export async function statusLine(
  storage: LedgerStorage,
  projectID: string,
  options?: StatusLineOptions,
): Promise<string | undefined> {
  try {
    const facts: string[] = [];
    const overCap = await getNotice(storage, projectID, "indexOverCap");
    if (overCap !== undefined) {
      facts.push(
        options?.indexLines !== undefined
          ? `INDEX.md is ${overCap} lines (cap ${options.indexLines}); not attached — trim it to restore auto-injection`
          : `INDEX.md is ${overCap} lines (over cap); not attached — trim it to restore auto-injection`,
      );
      try {
        await clearNotice(storage, projectID, "indexOverCap");
      } catch {
        // Best-effort: a failed clear re-emits once next turn (benign).
      }
    }
    // …existing rotated + pending facts unchanged…
```

Update the module doc comment (facts list).

4. `src/index.ts` prompt hook: replace `indexWithinCap` with the count-aware path (import `indexLineCount` from `./brief.js`, `setNotice` from `./capture.js`; drop the now-unused `indexWithinCap` import — the export stays for tests/docs):

```ts
if (!already) {
  const indexCount = await indexLineCount(abs);
  if (indexCount !== undefined && indexCount <= options.indexLines) {
    event.prompt.files.push({ uri: expectedIndexUri });
    bump("index.attach");
  } else {
    bump("index.overCap");
    if (indexCount !== undefined && indexCount > options.indexLines) {
      // Over-cap (not missing): report the count once on the status line.
      await setNotice(ledger, projectID, "indexOverCap", indexCount);
    }
  }
} else {
  bump("index.already");
}
```

5. `src/index.ts` context hook: `const status = await statusLine(ledger, projectID, { indexLines: options.indexLines });`

### Verify

- [ ] `npx vitest run test/hooks.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean (no unused import errors).
- [ ] `npx vitest run` → PASS (existing over-cap metric block: totals unchanged; the marker write must not disturb it).

Commit: `feat: over-cap INDEX status notice (T0-E3a)`

---

## Task 6 (E3b): Skipped-capture status notice — `src/capture.ts`, `src/status.ts`, `src/index.ts`, `test/provenance.test.ts`, `test/hooks.test.ts`

**Depends on:** Task 5 (`notice.*` helpers + `incNotice`).

**Files:** `src/capture.ts`, `src/status.ts`, `src/index.ts`, `test/provenance.test.ts`, `test/hooks.test.ts`.

### Failing tests first

`test/provenance.test.ts` — in `describe("captureFailure")` add (reuse its `root`/storage fixtures; `readActive()` reads `activeContext.md`):

```ts
it("tags a write-guard rejection as write-rejected", async () => {
  await writeFile(
    join(root, "activeContext.md"),
    Array.from({ length: 61 }, (_, i) => `- line ${i}`).join("\n") + "\n",
    "utf8",
  );
  const outcome = await captureFailure(
    { status: "error", error: { message: "boom" } },
    storage,
    PROJECT,
    root,
  );
  expect(outcome).toMatchObject({
    reason: "failed",
    failureKind: "write-rejected",
  });
});
```

(Check the file's imports: `writeFile`/`join` may need adding; the describe already has a `root` fixture and a way to write files — mirror the existing `readActive()` setup. If no writer helper exists, import `writeFile` from `node:fs/promises` and use `join(root, "activeContext.md")`.)

`test/hooks.test.ts` — statusLine unit + hook integration:

```ts
it("reports skipped failure captures once, then clears the notice", async () => {
  await setNotice(storage, PROJECT, "captureFailed", 2);
  const line = await statusLine(storage, PROJECT);
  expect(line).toContain("2 failure capture(s) skipped");
  expect(line).toContain("run /memory-review");
  expect(await statusLine(storage, PROJECT)).toBeUndefined();
});
```

Integration (inside `describe("execute.after failure hook")`): write a 61-line `activeContext.md` with no `## Known errors` heading, fire the error event, assert `statusLine(storage, PROJECT)` contains `memory write rejected` style wording:

```ts
it("notices a write-rejected capture on the status line", async () => {
  await writeMemory(
    "activeContext.md",
    Array.from({ length: 61 }, (_, i) => `- line ${i}`).join("\n") + "\n",
  );
  const { toolHooks } = await setupHooks();
  const handler = toolHooks.get("execute.after");
  await handler!(
    toolEvent("error", { message: "Command failed: npm run build" }) as never,
  );
  const line = await statusLine(storage, PROJECT);
  expect(line).toContain("failure capture(s) skipped");
});
```

(`toolEvent(status, error?, input?)` is the existing builder inside `describe("execute.after failure hook")` — `test/hooks.test.ts:643`; use it verbatim, do not invent a second event shape.)

Run `npx vitest run test/provenance.test.ts test/hooks.test.ts` → FAIL (`failureKind` missing; notice unset).

### Implementation

1. `src/capture.ts`:

```ts
/** Write-guard rejection sub-kind for `CaptureOutcome.reason === "failed"`. */
export type CaptureFailureKind = "write-rejected";

export interface CaptureOutcome {
  readonly reason: CaptureReason;
  readonly contentID?: string;
  readonly failureKind?: CaptureFailureKind;
}
```

`fail` gains the optional kind:

```ts
const fail = (error: unknown, failureKind?: CaptureFailureKind): CaptureOutcome => {
  try { log(error); } catch { /* … */ }
  return failureKind === undefined
    ? { reason: "failed" }
    : { reason: "failed", failureKind };
};
```

Wrap ONLY the `updateCapped` call in its own try/catch (inside the inner try — the `finally` still clears the single-flight key via the `return`):

```ts
try {
  await updateCapped("activeContext.md", { … }, (current) => { … });
} catch (error) {
  // Cap/rotation/IO rejection on the append itself: the one failure kind
  // the status line reports (Task 6). Ledger failures below stay log-only.
  return fail(error, "write-rejected");
}
```

2. `src/status.ts` — second fact, after the rotation notice and before the pending nudge:

```ts
const skipped = await getNotice(storage, projectID, "captureFailed");
if (skipped !== undefined) {
  facts.push(
    `${skipped} failure capture(s) skipped: memory write rejected (over cap or no rotatable Known-errors block); fix the file or run /memory-review`,
  );
  try {
    await clearNotice(storage, projectID, "captureFailed");
  } catch {
    // Best-effort: a failed clear re-emits once next turn (benign).
  }
}
```

3. `src/index.ts` `execute.after`: import `incNotice`; in `case "failed":` after the bump:

```ts
case "failed":
  bump("failure.failed");
  // Write-guard rejections are actionable (over cap / no rotatable block):
  // surface a count-only notice once on the status line.
  if (outcome.failureKind === "write-rejected") {
    await incNotice(ledger, projectID, "captureFailed");
  }
  break;
```

### Verify

- [ ] `npx vitest run test/provenance.test.ts test/hooks.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → PASS (`test/isolation.test.ts:430` failed-outcome matchObject is unaffected — it asserts `reason` only).

Commit: `feat: capture-failure status notice (T0-E3b)`

---

## Task 7 (E3c): AGENTS.md protocol-block install nudge — `src/templates.ts`, `src/index.ts`, `test/scaffold.test.ts`

**Depends on:** none.

**Files:** `src/templates.ts`, `src/index.ts`, `test/scaffold.test.ts`.

### Failing tests first

In `test/scaffold.test.ts` add a new describe (imports to add: `vi` from `vitest`; `mkdir` and `writeFile` from `node:fs/promises`; `getScaffoldFiles` already imported; `resetInstallNudgesForTests` from `../src/index.js` alongside the default import; `join` already imported):

```ts
/** Fake ctx mirroring the wiring test above; scaffold pre-created → firstRun false. */
function installCtx(projectRoot: string) {
  return {
    options: {},
    location: {
      directory: projectRoot,
      project: { id: "nudge", directory: projectRoot, canonical: projectRoot },
    },
    storage: fakeStorageForSetup,
    permission: { assert: async (_input: unknown) => undefined },
    tool: {
      transform: async () => ({ dispose: async () => undefined }),
      hook: async () => ({ dispose: async () => undefined }),
    },
    command: {
      transform: async () => ({ dispose: async () => undefined }),
    },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      prompt: async (args: unknown) =>
        ({ sessionID: (args as { sessionID?: string }).sessionID }) as never,
    },
  };
}

async function preScaffold(projectRoot: string): Promise<void> {
  const memoryDir = join(projectRoot, ".opencode", "memory");
  await mkdir(join(memoryDir, "handoffs", "archive"), { recursive: true });
  for (const [name, content] of Object.entries(getScaffoldFiles())) {
    await writeFile(join(memoryDir, name), content, "utf8");
  }
}

describe("agents_protocol_nudge", () => {
  it("warns once when a non-first-run AGENTS.md lacks the protocol block", async () => {
    resetInstallNudgesForTests();
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-nudge-"));
    await preScaffold(projectRoot);
    await writeFile(join(projectRoot, "AGENTS.md"), "# Repo guide\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const setup = plugin.setup as unknown as (
        ctx: unknown,
      ) => Promise<(() => Promise<void>) | void>;
      const cleanup = await setup(installCtx(projectRoot));
      const nudged = warn.mock.calls.some((c) =>
        String(c[0]).includes("no memory protocol block"),
      );
      expect(nudged).toBe(true);
      // Once per process: a second setup is silent.
      warn.mockClear();
      await setup(installCtx(projectRoot));
      const again = warn.mock.calls.some((c) =>
        String(c[0]).includes("no memory protocol block"),
      );
      expect(again).toBe(false);
      await cleanup?.();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when AGENTS.md has the block or is absent", async () => {
    resetInstallNudgesForTests();
    const withBlock = await mkdtemp(join(tmpdir(), "memory-nudge2-"));
    await preScaffold(withBlock);
    await writeFile(
      join(withBlock, "AGENTS.md"),
      "## Project memory (.opencode/memory)\n- call memory_recall before editing contracts\n",
      "utf8",
    );
    const withoutFile = await mkdtemp(join(tmpdir(), "memory-nudge3-"));
    await preScaffold(withoutFile);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const setup = plugin.setup as unknown as (
        ctx: unknown,
      ) => Promise<(() => Promise<void>) | void>;
      await setup(installCtx(withBlock));
      await setup(installCtx(withoutFile));
      const nudged = warn.mock.calls.some((c) =>
        String(c[0]).includes("no memory protocol block"),
      );
      expect(nudged).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
```

Run `npx vitest run test/scaffold.test.ts` → FAIL (`resetInstallNudgesForTests` missing).

### Implementation

1. `src/templates.ts`:

```ts
/** Heuristic markers for the root-AGENTS.md protocol block (never content). */
const PROTOCOL_BLOCK_PATTERN = /\bmemory_recall\b|\.opencode\/memory\b/;

/** True when `AGENTS.md` text carries the memory protocol block. Pure. */
export function hasMemoryProtocolBlock(text: string): boolean {
  return typeof text === "string" && PROTOCOL_BLOCK_PATTERN.test(text);
}
```

2. `src/index.ts` — readFile import (`import { mkdir, readFile, writeFile } from "node:fs/promises";`), the once-per-process flag + seam near the top, and the setup nudge after the first-run block:

```ts
/** Once-per-process install nudge state (AGENTS.md protocol block missing). */
let agentsProtocolNudgeLogged = false;

/** Test seam: reset the once-per-process install nudge. */
export function resetInstallNudgesForTests(): void {
  agentsProtocolNudgeLogged = false;
}
```

```ts
if (!firstRun) {
  // Non-first-run installs with a hand-owned AGENTS.md that predates the
  // protocol block never see the first-run print; nudge once per process.
  // A missing/unreadable AGENTS.md stays silent (a global block may exist).
  try {
    const agentsText = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    if (
      !agentsProtocolNudgeLogged &&
      !hasMemoryProtocolBlock(agentsText)
    ) {
      agentsProtocolNudgeLogged = true;
      console.warn(
        "[memory] root AGENTS.md has no memory protocol block; the agent will not read memory. Paste the block printed on first run (or in the README install section).",
      );
    }
  } catch {
    // Missing/unreadable AGENTS.md: nothing to check.
  }
}
```

Import `hasMemoryProtocolBlock` from `./templates.js`. Keep `hasMemoryProtocolBlock` pure and the nudge inside the setup's never-throw envelope.

### Verify

- [ ] `npx vitest run test/scaffold.test.ts` → PASS.
- [ ] `npx tsc --noEmit` → clean.
- [ ] `npx vitest run` → PASS (other setup-driving tests emit no nudge: their temp roots have no AGENTS.md; the once-per-process flag + the `vi.spyOn` filter keep the permissions warning assertions untouched).

Commit: `feat: AGENTS.md protocol-block install nudge (T0-E3c)`

---

## Task 8 (docs): Spec + living docs — all user-visible texts frozen by Tasks 1–7

**Depends on:** Tasks 1–7 (final strings).

**Files:** `docs/design-spec-v2-production.md`, `docs/c4-04-interfaces.md`, `docs/c4-05-data-model.md`, `docs/c4-06-code.md`, `docs/user-stories.md`, `README.md`, `CHANGELOG.md`.

1. `docs/design-spec-v2-production.md`:
   - **§3 (options)** — append one bullet: ``- Coherence warnings (Tier 0, 2026-10-19): a valid parse still warns once (no behavior change) when `injectBudgetLines <= indexLines` (no budget remains for brief/status/hint) or `fileLines < 10` (aggressive truncation). No sixth option; ADR-0006 stands.``
   - **§5.1 (prompt hook)** — append one paragraph (the sample code block keeps `indexWithinCap` for continuity): ``Tier-0 amendment (2026-10-19): the hook reads `indexLineCount(abs)` (missing → silent; over cap → also `setNotice(ledger, projectID, "indexOverCap", <count>)` in the over-cap branch, i.e. on prompt admission while over cap). `indexWithinCap` stays exported and delegates to `indexLineCount` (behavior unchanged: missing/over-cap/unreadable → false).``
   - **§5.2** — append one paragraph: ``Tier-0 amendment (2026-10-19): `loadBrief()` injects nothing from a fresh scaffold or legacy `- (…)` placeholders — placeholders are comments, and comment-only lines plus headings whose section has no content are filtered from the brief and priors. The status line carries two additional best-effort notices (see §5.7); the hint line calls the structural file its matched INDEX line maps to (leftmost `activeContext|decisions|architecture|style|issues` word on that line, ties in that listed order; default `decisions.md`).``
   - **§5.3** — append: ``Tier-0 amendment (2026-10-19): a failure capture whose capped append is rejected (`activeContext.md` over cap / no rotatable Known-errors block) resolves `{ reason: "failed", failureKind: "write-rejected" }` and increments the count-only `<projectID>/notice.captureFailed` notice; the status line reports it once (`<n> failure capture(s) skipped: memory write rejected (over cap or no rotatable Known-errors block); fix the file or run /memory-review`). Counters/logs are unchanged; other failed outcomes do not notice.``
   - **§5.4** — append: ``Tier-0 amendment (2026-10-19): `file: "handoffs"` and `file: "handoffs/archive"` return names-only listings (newest first, ≤20 names, `N file(s) total`; root adds `M in handoffs/archive/` when non-empty; missing directories are `(none)`, not an error). Missing files throw `[memory] memory file not found: <name>` (+ `list available files with memory_recall("handoffs")` for handoff paths); non-allowlisted paths enumerate the valid list. The description gains: `List available handoffs with file: "handoffs" (root) or "handoffs/archive".```
   - **§5.7** — extend the statusLine bullet: add the two notices (over-cap INDEX: `INDEX.md is <n> lines (cap <m>); not attached — trim it to restore auto-injection`, clear-after-report, re-set on the next prompt admission while over cap; failed captures as in §5.3) and extend the ledger key list with `` `<projectID>/notice.indexOverCap` / `<projectID>/notice.captureFailed` → transient positive-int notice values, cleared after `statusLine()` reports them (same read-then-clear semantics as the rotation marker).``
2. `docs/c4-05-data-model.md` — line 17 (ledger cell): append `` plus `<projectID>/notice.indexOverCap` / `<projectID>/notice.captureFailed` (transient positive-int status notices, cleared after reporting)``; §Budgets (~line 26): extend "The status line carries the rotation notice and the review-due nudge (≥5 uncurated scratchpad captures)" with ``, plus the over-cap `INDEX.md` notice and the skipped-capture notice (Tier 0 — numbers only)``.
3. `README.md` §Budgets (~line 96) — extend the over-cap sentence: ``An over-cap `INDEX.md` is not attached (the `[memory]` status line reports it with its line count until trimmed); `/memory-review` reports the violation instead. A failure capture whose append is rejected (activeContext at cap without a rotatable Known-errors block) is reported on the status line too — fix the file or run `/memory-review`.`` Add one sentence after the budgets paragraph: ``Handoffs are listed names-only via `memory_recall` (`file: "handoffs"` newest first; `file: "handoffs/archive"` for rotated/archived entries) — recall one by its full `handoffs/…` path.`` Also update the §Evals static number (~line 102): recompute it exactly as `test/acceptance.test.ts` does (the AGENTS.md block + wrapped `memory_recall` description lines) — the Task-3 description sentence needs one more wrapped line, so the value moves 10 → 11 (acceptance computes it dynamically and stays ≤16; mirror the formula, don't hand-wave).
4. `CHANGELOG.md` — new top section:

```markdown
## Unreleased

- Tier-0 UX hardening (E1, E3–E6): a fresh scaffold no longer injects placeholder text into the brief or priors (placeholders are HTML comments; legacy `- (…)` placeholders, comment-only lines, and empty sections are filtered from auto-injection). Silent degradations now surface on the `[memory]` status line: an over-cap `INDEX.md` (line count vs cap, cleared after reporting) and failure captures whose append the write guard rejects (`failureKind: "write-rejected"`, count-only). A non-first-run project whose root `AGENTS.md` exists without the memory protocol block gets a once-per-process install nudge. `memory_recall` lists handoffs names-only (`file: "handoffs"` / `"handoffs/archive"`), missing files report `memory file not found: <name>` with a listing hint, and non-allowlisted paths enumerate the valid names. The `[memory-hint]` line calls the structural file its matched INDEX line maps to (default `decisions.md`). `parseMemoryOptions` warns once on `injectBudgetLines <= indexLines` and `fileLines < 10`. No new option, no new metric name, no memory-file write behavior change.
```

5. `docs/c4-04-interfaces.md` — `memory_recall` section: Input line gains `| "handoffs" | "handoffs/archive"` (listing values); Output line's "error on unknown/traversal (never list the filesystem)" becomes "unknown/traversal/missing single-file paths error (`memory file not found: <name>`, listing hint for handoff paths); `handoffs`/`handoffs/archive` return names-only listings — never a content listing of any other path"; Description gains the listing sentence verbatim from `MEMORY_RECALL_DESCRIPTION`.
6. `docs/c4-06-code.md` — `readCapped` bullet: mention the missing-file error text; `statusLine(event)` bullet: add the over-cap INDEX notice and the skipped-capture notice (four facts total, one line); `captureFailure` bullet: mention `failureKind: "write-rejected"`, and add a separate sentence that the `execute.after` hook increments `<projectID>/notice.captureFailed` on that kind (the increment lives in the hook, not in `captureFailure` — do not misattribute it); `ledger` bullet: add `<projectID>/notice.indexOverCap` / `<projectID>/notice.captureFailed` (transient, cleared after reporting).
7. `docs/user-stories.md` — conventions ledger enumeration (~line 7): add the two `notice.*` keys; US-11: adjust "error on unknown/traversal, never list filesystem" to "single-file unknown/traversal/missing errors; names-only `handoffs`/`handoffs/archive` listings (never a filesystem walk)".
8. Status-fact sweep — `grep -rn "rotation notice\|review-due nudge" docs/` and update every enumeration that predates the two Tier-0 notices (e.g. `docs/design-spec-v2-production.md` §7 lifecycle and package tree, `docs/c4-04-interfaces.md`, `docs/c4-06-code.md` tree/acceptance list) so all four facts are listed. Historical CHANGELOG entries stay untouched.

### Verify

- [ ] `npx vitest run` → PASS (no test asserts the old doc text; re-run anyway).
- [ ] `grep -n "Tier-0 amendment" docs/design-spec-v2-production.md` → 5 hits (§§5.1, 5.2, 5.3, 5.4, 5.7).
- [ ] `grep -n "notice\." docs/c4-05-data-model.md docs/c4-06-code.md docs/user-stories.md` → notice keys present in all three.
- [ ] `git status --short` → only the seven doc files listed in this task.

Commit: `docs: tier 0 UX hardening spec/README/changelog (T0-D1)`

---

## Self-review / final verification

- [ ] `npx tsc --noEmit` clean; `npx vitest run` full suite green (target: prior 210 tests + ~20 new, none weakened).
- [ ] ADR-0006: `git diff main -- src/config.ts` shows only warnings — no option added/removed.
- [ ] ADR-0008: `git diff main -- src/metrics.ts` empty; no new string enters `METRIC_NAMES`; notices are numbers; `git grep -n "memory_add\|noticeKey" src/` shows only the two enum kinds.
- [ ] Every new user-visible string is fixed prose + integers/allowlisted names (no captured content, no prompt text): manually scan `git diff main`.
- [ ] Never-throw: new `statusLine` facts are inside its try; `setNotice`/`incNotice` calls sit inside the hooks' existing try/catch; `loadBrief`/`loadPriors`/`listHandoffs`/`renderHandoffListing` are wrapped or non-throwing by construction; `pruneScaffoldNoise` catches.
- [ ] Fresh-scaffold manual check (acceptance evidence): write `getScaffoldFiles()` into a temp root and assert `loadBrief === ""` (Task 1 test) — the bug from the 2026-10-19 analysis is covered by a regression test.
- [ ] No TODO/debug prints left; commits are one-per-task with the given messages.
