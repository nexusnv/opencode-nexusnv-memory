# E13 — INDEX Pointer Cleanup after `/memory-forget` (Issue #23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a successful `/memory-forget` from a structural memory file, detect `INDEX.md` lines that point at the removed content, surface unambiguous candidates with exact line numbers, and offer an explicit per-line `/memory-forget INDEX.md --line N --confirm` follow-up — without ever rewriting `INDEX.md` automatically or bulk-removing rows.

**Architecture:** A new pure module (`src/index-pointers.ts`) parses INDEX lines into `topic → file:section`, resolves section headings in the forgotten file, and classifies each pointer as a candidate (literal pointer gone, or referenced section now empty) or ambiguous (file-general, unresolvable section, or a line that also points at remaining content). `src/forget.ts` reads INDEX through the existing contained reader, attaches the report to the dry-run and result, and writes only the source file. The command increments a new transient `notice.indexStale` count when candidates exist; the existing `[memory]` status line reports it once, and `/memory-status` surfaces it as a read-only pending action.

**Tech Stack:** TypeScript 5.9 (strict), Node.js 20+, Vitest 5, existing `src/files.ts` contained readers and `ctx.storage` ledger helpers. No new dependency, no new config option, no model-callable tool.

---

## Scope and locked decisions

Read this before Task 1. These are the decisions the PR is built on; do not re-litigate them mid-implementation.

1. **The follow-up is a separate command invocation, not a new flag.** The source forget never calls `applyForget` on `INDEX.md`. For each unambiguous candidate it prints the exact `/memory-forget INDEX.md --line N --confirm` command. This is the “second, explicit step” in issue #23 and keeps ADR-0009’s “INDEX is not inferred” posture. A `--cleanup-index` flag was rejected: it would combine two rewrites in one approval cycle and make bulk removal easier to trigger by accident.
2. **Only unambiguous evidence is a candidate.**
   - A literal topic/section pointer whose text disappears with the selection, or
   - A `file:section` pointer whose section loses every remaining non-blank line (the heading itself may be removed or left behind).
3. **File-general lines are not candidates.** The scaffold map lines (`- architecture: contracts, …`) and any line that only names the file are ignored, not queued for removal. This is the issue’s “no false removal” acceptance criterion.
4. **Ambiguous mappings stay manual.** An explicit section that cannot be resolved, a duplicate heading match, or a line whose topic names removed content while the referenced section still has content is reported with a reason and left untouched.
5. **No automatic cleanup, no bulk removal, no model-facing delete tool.** Each INDEX line needs its own permission prompt and its own `--confirm`.
6. **`notice.indexStale` is a transient storage notice, not a metric.** It carries a count only, is consumed atomically by the next status line, and does not change the ADR-0008 metric vocabulary. The existing `notice.forgotten` fact still reports the forget/archive/git warning; the candidate count rides the adjacent `notice.indexStale` fact on the same status line. This avoids changing the numeric contract of `notice.forgotten` while still including the cleanup in the forget status report.
7. **Out of scope (do not add):** automatic TTL/decay, purging `handoffs/archive/`, model-initiated forget intents, a `memory_forget`/`memory_delete` tool, a sixth config option.

## File map

**Create**

| File | Responsibility |
| --- | --- |
| `src/index-pointers.ts` | Pure INDEX parsing, section resolution, candidate/ambiguity classification. No filesystem, no storage. |
| `test/index-pointers.test.ts` | Unit tests for the pure detector. |

**Modify**

| File | Change |
| --- | --- |
| `src/forget.ts` | Read INDEX, attach `IndexPointerReport` to `ForgetResult` and the preview/result renderers, keep `applyForget` writing only the source file. |
| `src/forget-command.ts` | Increment `notice.indexStale` by the candidate count after a successful forget. |
| `src/capture.ts` | Add `"indexStale"` to `NoticeKind` and `incNoticeBy(storage, projectID, kind, delta)`. |
| `src/status.ts` | Render the `indexStale` fact in the one `[memory]` line; include it in `hasStatusLine`. |
| `src/status-report.ts` | Read the pending `indexStale` count (without consuming it); render an Activity row and a next action. |
| `test/forget.test.ts` | Preview/result/apply coverage, including no-pointer and ambiguous cases. |
| `test/lifecycle-commands.test.ts` | Command-level notice coverage and proof that INDEX is not rewritten. |
| `test/hooks.test.ts` | `statusLine`/`hasStatusLine` coverage for the new notice. |
| `test/status-report.test.ts` | Read-only pending stale pointer row/action coverage. |
| `docs/adr/0009-forget-and-handoff-gc.md` | Revise decision item 5, item 9, and consequences. |
| `docs/design-spec-v2-production.md` | §5.7 status fact, §5.13 status report amendment, §6 lifecycle command table, §7 flow step 8. |
| `README.md` | Lifecycle docs: candidate detection, per-line follow-up, ambiguous fallback, status notice. |
| `CONTRIBUTING.md` | Repository layout + acceptance bullet + invariant wording. |
| `CHANGELOG.md` | Unreleased entry. |

---

## Before you start

- [ ] **Create the branch**

```bash
git switch -c feat/23-index-pointer-cleanup
```

- [ ] **Confirm the baseline is green**

```bash
npm run typecheck
npm test
```

Expected: both commands exit 0 on the current `main` baseline. Do not proceed if the baseline fails; record the failure and fix it separately first.

---

### Task 1: Pure INDEX pointer detector

**Files:**
- Create: `test/index-pointers.test.ts`
- Create: `src/index-pointers.ts`

- [ ] **Step 1: Write the failing test file**

Create `test/index-pointers.test.ts` with this exact content:

```ts
import { describe, expect, it } from "vitest";
import {
  detectIndexPointers,
  emptyIndexPointerReport,
} from "../src/index-pointers.js";

function report(params: {
  readonly index: string;
  readonly current: string;
  readonly next: string;
  readonly removed: ReadonlyArray<{
    readonly lineNumbers: readonly number[];
    readonly text: string;
  }>;
  readonly file?: string;
}) {
  return detectIndexPointers({
    forgottenFile: params.file ?? "architecture.md",
    currentFileText: params.current,
    nextFileText: params.next,
    removedUnits: params.removed,
    indexText: params.index,
  });
}

describe("detectIndexPointers", () => {
  it("flags a literal topic pointer that disappears", () => {
    const result = report({
      index: "- legacy queue adapter → architecture.md\n",
      current: "# Architecture\n- legacy queue adapter stays\n- keep\n",
      next: "# Architecture\n- keep\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- legacy queue adapter → architecture.md",
        reason: "literal",
      },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("does not flag a file-general scaffold pointer", () => {
    const result = report({
      index:
        "- architecture: contracts, sibling implementations, style-lock pointer\n",
      current: "# Architecture\n- legacy queue adapter stays\n- keep\n",
      next: "# Architecture\n- keep\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("flags a section pointer whose section loses all content", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- old adapter",
      "- retry policy",
      "## Keep",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n## Queue\n## Keep\n- keep",
      removed: [
        { lineNumbers: [3], text: "- old adapter" },
        { lineNumbers: [4], text: "- retry policy" },
      ],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
  });

  it("does not flag a section pointer that still has content", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- old adapter",
      "- retry policy",
      "## Keep",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n## Queue\n- retry policy\n## Keep\n- keep",
      removed: [{ lineNumbers: [3], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("flags a topic pointer whose section still has content as ambiguous", () => {
    const current = [
      "# Architecture",
      "## Integrations",
      "- legacy queue adapter stays",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- legacy queue adapter → architecture.md:Integrations\n",
      current,
      next: "# Architecture\n## Integrations\n- keep",
      removed: [{ lineNumbers: [3], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.line).toBe(1);
    expect(result.ambiguous[0]!.reason).toContain("section still has content");
  });

  it("flags an unresolvable explicit section as ambiguous", () => {
    const current = "# Architecture\n- keep\n";
    const result = report({
      index: "- Queue → architecture.md:Missing section\n",
      current,
      next: current,
      removed: [{ lineNumbers: [2], text: "- remove me" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Missing section",
        reason:
          'section "missing section" was not found in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("ignores pointers to other files", () => {
    const result = report({
      index: "- legacy queue adapter → decisions.md\n",
      current: "# Architecture\n- legacy queue adapter stays\n",
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("returns an empty report for INDEX.md itself", () => {
    const result = report({
      file: "INDEX.md",
      index: "- anything\n",
      current: "- anything\n",
      next: "",
      removed: [{ lineNumbers: [1], text: "- anything" }],
    });
    expect(result).toEqual(emptyIndexPointerReport("inspected"));
  });

  it("does not flag a pointer whose phrase survives elsewhere", () => {
    const result = report({
      index: "- legacy queue adapter → architecture.md\n",
      current:
        "# Architecture\n- legacy queue adapter old\n- legacy queue adapter new\n",
      next: "# Architecture\n- legacy queue adapter new\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter old" }],
    });
    expect(result.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run test/index-pointers.test.ts
```

Expected: FAIL with `Cannot find module '../src/index-pointers.js'` (or equivalent resolution error). This proves the test is wired before the implementation exists.

- [ ] **Step 3: Write `src/index-pointers.ts`**

Create `src/index-pointers.ts` with this exact content:

```ts
/**
 * INDEX pointer detection for `/memory-forget` (issue #23, E13, ADR-0009).
 *
 * Pure and filesystem-free: callers pass the pre-forget file text, the
 * post-forget text, the removed units, and the raw INDEX text. The detector
 * only *suggests* cleanup; it never rewrites INDEX.
 *
 * A pointer is a candidate only when the evidence is unambiguous:
 *   - an exact literal topic/section phrase disappears with the selection, or
 *   - a `file:section` pointer's section loses every remaining non-blank line.
 *
 * File-general scaffold lines are ignored. An unresolvable explicit section,
 * a duplicate heading match, or a line whose topic names removed content while
 * the referenced section still has content is reported as ambiguous and left
 * for manual editing.
 */

/** Minimum normalized pointer length for literal matching. */
const MIN_POINTER_LENGTH = 8;

/** The structural files an INDEX line may point at. */
const FILE_TOKENS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly file: string;
}> = [
  { pattern: /\bactivecontext\.md\b/i, file: "activeContext.md" },
  { pattern: /\bdecisions\.md\b/i, file: "decisions.md" },
  { pattern: /\barchitecture\.md\b/i, file: "architecture.md" },
  { pattern: /\bstyle\.md\b/i, file: "style.md" },
  { pattern: /\bissues\.md\b/i, file: "issues.md" },
  { pattern: /\bindex\.md\b/i, file: "INDEX.md" },
  {
    pattern: /\bactivecontext\b(?=\s*(?:[:#]|$))/i,
    file: "activeContext.md",
  },
  { pattern: /\bdecisions\b(?=\s*(?:[:#]|$))/i, file: "decisions.md" },
  {
    pattern: /\barchitecture\b(?=\s*(?:[:#]|$))/i,
    file: "architecture.md",
  },
  { pattern: /\bstyle\b(?=\s*(?:[:#]|$))/i, file: "style.md" },
  { pattern: /\bissues\b(?=\s*(?:[:#]|$))/i, file: "issues.md" },
  { pattern: /\bindex\b(?=\s*(?:[:#]|$))/i, file: "INDEX.md" },
];

/** Generic file-name words that never make a pointer specific on their own. */
const FILE_WORDS: ReadonlySet<string> = new Set([
  "activecontext",
  "activecontext.md",
  "decisions",
  "decisions.md",
  "architecture",
  "architecture.md",
  "style",
  "style.md",
  "issues",
  "issues.md",
  "index",
  "index.md",
]);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*\#*\s*$/;

export interface RemovedUnit {
  readonly lineNumbers: readonly number[];
  readonly text: string;
}

export interface IndexPointerCandidate {
  /** 1-based line number in INDEX.md. */
  readonly line: number;
  /** Raw INDEX line; renderers redact and clip it. */
  readonly text: string;
  readonly reason: "literal" | "empty-section";
}

export interface IndexPointerAmbiguity {
  /** 1-based line number in INDEX.md. */
  readonly line: number;
  /** Raw INDEX line; renderers redact and clip it. */
  readonly text: string;
  readonly reason: string;
}

export type IndexPointerStatus =
  | "inspected"
  | "missing"
  | "truncated"
  | "unreadable";

export interface IndexPointerReport {
  readonly status: IndexPointerStatus;
  readonly candidates: readonly IndexPointerCandidate[];
  readonly ambiguous: readonly IndexPointerAmbiguity[];
}

export function emptyIndexPointerReport(
  status: IndexPointerStatus = "missing",
): IndexPointerReport {
  return { status, candidates: [], ambiguous: [] };
}

interface Heading {
  readonly index: number;
  readonly level: number;
  readonly text: string;
}

interface ParsedIndexLine {
  readonly file: string;
  readonly topic: string;
  readonly section: string;
}

type SectionResolution =
  | { readonly heading: Heading; readonly end: number }
  | "missing"
  | "ambiguous";

/** Lowercase, strip markdown decoration and edge punctuation for matching. */
function normalizePointerText(text: string): string {
  return text
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.>#\-–—]+/, "")
    .replace(/[\s:;,.>#\-–—]+$/, "")
    .trim()
    .toLowerCase();
}

function findFileToken(
  text: string,
): { readonly file: string; readonly index: number; readonly length: number } | undefined {
  let best:
    | { readonly file: string; readonly index: number; readonly length: number }
    | undefined;
  for (const token of FILE_TOKENS) {
    const match = token.pattern.exec(text);
    if (match === null) continue;
    const candidate = {
      file: token.file,
      index: match.index,
      length: match[0].length,
    };
    if (
      best === undefined ||
      candidate.index < best.index ||
      (candidate.index === best.index && candidate.length > best.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Drop a leading file-name token so `- architecture: …` has no topic. */
function topicBeforeFile(left: string, file: string): string {
  const cleaned = normalizePointerText(left);
  if (cleaned.length === 0) return "";
  const stem = file.replace(/\.md$/i, "").toLowerCase();
  if (cleaned === file.toLowerCase() || cleaned === stem) return "";
  return cleaned;
}

function parseIndexLine(line: string): ParsedIndexLine | undefined {
  const arrow = /→|->|=>/.exec(line);
  const token = findFileToken(line);
  if (token === undefined) return undefined;
  const left = line.slice(0, token.index);
  const after = line.slice(token.index + token.length);
  const topicSource =
    arrow !== null && arrow.index < token.index
      ? line.slice(0, arrow.index)
      : left;
  return {
    file: token.file,
    topic:
      arrow !== null && arrow.index < token.index
        ? normalizePointerText(topicSource)
        : topicBeforeFile(topicSource, token.file),
    section: normalizePointerText(
      after.replace(/^\s*[:#/\-–—]*\s*/, ""),
    ),
  };
}

function parseHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_RE.exec(lines[i]!);
    if (match === null) continue;
    const text = normalizePointerText(match[2]!);
    if (text.length === 0) continue;
    headings.push({ index: i, level: match[1]!.length, text });
  }
  return headings;
}

function resolveSection(
  headings: readonly Heading[],
  section: string,
  lineCount: number,
): SectionResolution {
  const matches = headings.filter((heading) => heading.text === section);
  if (matches.length === 0) return "missing";
  if (matches.length > 1) return "ambiguous";
  const heading = matches[0]!;
  let end = lineCount;
  for (const other of headings) {
    if (other.index > heading.index && other.level <= heading.level) {
      end = other.index;
      break;
    }
  }
  return { heading, end };
}

/** True when no non-blank line remains in the section except removed lines. */
function sectionLosesAllContent(
  lines: readonly string[],
  start: number,
  end: number,
  removed: ReadonlySet<number>,
): boolean {
  if (removed.has(start)) return true;
  for (let i = start + 1; i < end; i += 1) {
    if (removed.has(i)) continue;
    if (lines[i]!.trim() === "") continue;
    return false;
  }
  return true;
}

function isSpecificPointer(pointer: string, file: string): boolean {
  if (pointer.length < MIN_POINTER_LENGTH) return false;
  if (FILE_WORDS.has(pointer)) return false;
  const stem = file.replace(/\.md$/i, "").toLowerCase();
  return pointer !== file.toLowerCase() && pointer !== stem;
}

/**
 * Detect INDEX lines that the selection made stale. Pure; never throws for
 * well-formed strings and never reads files. `currentFileText` and
 * `nextFileText` are the pre- and post-forget text of the *forgotten* file.
 */
export function detectIndexPointers(input: {
  readonly forgottenFile: string;
  readonly currentFileText: string;
  readonly nextFileText: string;
  readonly removedUnits: readonly RemovedUnit[];
  readonly indexText: string;
}): IndexPointerReport {
  const candidates: IndexPointerCandidate[] = [];
  const ambiguous: IndexPointerAmbiguity[] = [];
  if (input.forgottenFile === "INDEX.md") {
    return { status: "inspected", candidates, ambiguous };
  }

  const fileLines = input.currentFileText.split("\n");
  const indexLines = input.indexText.split("\n");
  const headings = parseHeadings(fileLines);
  const removed = new Set<number>();
  for (const unit of input.removedUnits) {
    for (const line of unit.lineNumbers) removed.add(line - 1);
  }
  const removedText = normalizePointerText(
    input.removedUnits.map((unit) => unit.text).join("\n"),
  );
  const nextText = normalizePointerText(input.nextFileText);

  for (let i = 0; i < indexLines.length; i += 1) {
    const raw = indexLines[i]!;
    const parsed = parseIndexLine(raw);
    if (parsed === undefined || parsed.file !== input.forgottenFile) continue;
    const { topic, section } = parsed;
    const pointer = section.length > 0 ? section : topic;
    if (pointer.length === 0) continue;

    const resolution = resolveSection(headings, pointer, fileLines.length);
    const sectionEmpty =
      resolution !== "missing" &&
      resolution !== "ambiguous" &&
      sectionLosesAllContent(
        fileLines,
        resolution.heading.index,
        resolution.end,
        removed,
      );
    const pointerGone =
      isSpecificPointer(pointer, input.forgottenFile) &&
      removedText.includes(pointer) &&
      !nextText.includes(pointer);
    const topicGone =
      topic.length > 0 &&
      isSpecificPointer(topic, input.forgottenFile) &&
      removedText.includes(topic) &&
      !nextText.includes(topic);

    if (sectionEmpty) {
      candidates.push({ line: i + 1, text: raw, reason: "empty-section" });
      continue;
    }
    if (pointerGone) {
      candidates.push({ line: i + 1, text: raw, reason: "literal" });
      continue;
    }
    if (topicGone) {
      if (section.length === 0) {
        candidates.push({ line: i + 1, text: raw, reason: "literal" });
      } else {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason:
            "names removed content but the referenced section still has content; edit the line rather than remove it",
        });
      }
      continue;
    }
    if (section.length > 0 && topic.length > 0) {
      if (resolution === "ambiguous") {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason: `section "${section}" matches more than one heading in ${input.forgottenFile}; edit INDEX.md manually`,
        });
        continue;
      }
      if (
        resolution === "missing" &&
        isSpecificPointer(section, input.forgottenFile)
      ) {
        ambiguous.push({
          line: i + 1,
          text: raw,
          reason: `section "${section}" was not found in ${input.forgottenFile}; edit INDEX.md manually`,
        });
        continue;
      }
    }
    // A file-general line, or a section that still has content, is not stale.
  }

  return { status: "inspected", candidates, ambiguous };
}
```

- [ ] **Step 4: Run the unit tests**

```bash
npx vitest run test/index-pointers.test.ts
```

Expected: all 10 tests pass. If a test fails, fix the detector before moving on — do not weaken the test.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/index-pointers.ts test/index-pointers.test.ts
git commit -m "feat: add pure INDEX pointer detector for forget cleanup"
```

---

### Task 2: Attach the report to forget preview, result, and apply

**Files:**
- Modify: `src/forget.ts`
- Modify: `test/forget.test.ts`

- [ ] **Step 1: Add failing preview tests**

Append these tests to the `describe("forget archive and application", …)` block in `test/forget.test.ts`, and add this import at the top of the file:

```ts
import { emptyIndexPointerReport } from "../src/index-pointers.js";
```

```ts
  it("surfaces unambiguous INDEX cleanup candidates in the dry-run", async () => {
    await writeFile(
      join(root, "architecture.md"),
      "# Architecture\n## Queue\n- legacy queue adapter\n",
    );
    await writeFile(
      join(root, "INDEX.md"),
      "- Queue → architecture.md:Queue\n- architecture: contracts\n",
    );
    const preview = await previewForget({
      ...opts(),
      file: "architecture.md",
      selector: { kind: "line", line: 3 },
      reason: "remove old adapter",
    });
    expect(preview).toContain("INDEX.md candidate cleanup");
    expect(preview).toContain("INDEX.md line 1");
    expect(preview).toContain("section is now empty");
    expect(preview).toContain("/memory-forget INDEX.md --line 1 --confirm");
    expect(preview).toContain("never bulk-removes");
    expect(await readFile(join(root, "INDEX.md"), "utf8")).toBe(
      "- Queue → architecture.md:Queue\n- architecture: contracts\n",
    );
  });

  it("reports no INDEX pointer when the map line is file-general", async () => {
    await writeFile(
      join(root, "architecture.md"),
      "# Architecture\n- keep\n- drop\n",
    );
    await writeFile(
      join(root, "INDEX.md"),
      "- architecture: contracts, sibling implementations\n",
    );
    const preview = await previewForget({
      ...opts(),
      file: "architecture.md",
      selector: { kind: "line", line: 3 },
      reason: "remove one line",
    });
    expect(preview).toContain("No INDEX pointer found for this selection");
  });

  it("reports ambiguous INDEX pointers without offering removal", async () => {
    await writeFile(
      join(root, "architecture.md"),
      "# Architecture\n## Integrations\n- legacy queue adapter\n- keep\n",
    );
    await writeFile(
      join(root, "INDEX.md"),
      "- legacy queue adapter → architecture.md:Integrations\n",
    );
    const preview = await previewForget({
      ...opts(),
      file: "architecture.md",
      selector: { kind: "line", line: 3 },
      reason: "remove old adapter",
    });
    expect(preview).toContain("ambiguous pointers");
    expect(preview).toContain("section still has content");
    expect(preview).not.toContain(
      "/memory-forget INDEX.md --line 1 --confirm",
    );
  });

  it("returns INDEX cleanup candidates from applyForget without rewriting INDEX", async () => {
    await writeFile(
      join(root, "architecture.md"),
      "# Architecture\n## Queue\n- legacy queue adapter\n",
    );
    await writeFile(join(root, "INDEX.md"), "- Queue → architecture.md:Queue\n");
    const permission = new FakePermission();
    const result = await applyForget({
      ...opts(),
      file: "architecture.md",
      selector: { kind: "line", line: 3 },
      reason: "remove old adapter",
      permission,
      sessionID: "s",
    });
    expect(result.indexPointers.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
    expect(await readFile(join(root, "INDEX.md"), "utf8")).toBe(
      "- Queue → architecture.md:Queue\n",
    );
  });
```

- [ ] **Step 2: Run the new tests and confirm they fail**

```bash
npx vitest run test/forget.test.ts
```

Expected: FAIL — `previewForget` output has no “INDEX.md candidate cleanup”, and `result.indexPointers` does not exist. Do not change the tests.

- [ ] **Step 3: Modify `src/forget.ts`**

Add these imports to the existing import block:

```ts
import {
  countLines,
  getCapForFile,
  readContainedText,
  readRawContained,
  withCappedTransaction,
  type CappedFileOptions,
} from "./files.js";
import {
  detectIndexPointers,
  emptyIndexPointerReport,
  type IndexPointerReport,
} from "./index-pointers.js";
```

Add `indexPointers` to `ForgetResult`:

```ts
export interface ForgetResult {
  readonly file: string;
  readonly archiveFile: string;
  readonly removedLineCount: number;
  readonly units: number;
  readonly indexPointers: IndexPointerReport;
}
```

Add these helpers immediately before `renderForgetPreview`:

```ts
function pointerReasonLabel(
  reason: "literal" | "empty-section",
): string {
  return reason === "empty-section"
    ? "section is now empty"
    : "names removed content";
}

function renderIndexPointerSection(
  report: IndexPointerReport,
  targetIsIndex: boolean,
  indexTargetText: string,
): string[] {
  if (targetIsIndex) {
    return [indexTargetText];
  }
  if (report.status === "missing") {
    return ["No INDEX.md found; no pointer cleanup is needed."];
  }
  if (report.status === "truncated") {
    return [
      "INDEX.md is too large to inspect; no pointer detection was performed — review pointers manually.",
    ];
  }
  if (report.status === "unreadable") {
    return [
      "INDEX.md could not be read; no pointer detection was performed — review pointers manually.",
    ];
  }
  const lines: string[] = [];
  if (report.candidates.length === 0 && report.ambiguous.length === 0) {
    lines.push(
      "No INDEX pointer found for this selection; INDEX.md was not rewritten.",
    );
    return lines;
  }
  if (report.candidates.length > 0) {
    lines.push(
      "INDEX.md candidate cleanup (not applied; exact line numbers):",
    );
    for (const candidate of report.candidates.slice(0, 10)) {
      lines.push(
        `- INDEX.md line ${candidate.line} — ${pointerReasonLabel(candidate.reason)}: ${clip(candidate.text)}`,
      );
      lines.push(
        `  follow-up: /memory-forget INDEX.md --line ${candidate.line} --confirm`,
      );
    }
    if (report.candidates.length > 10) {
      lines.push(
        `- … ${report.candidates.length - 10} more candidate line(s); re-run the dry-run after editing INDEX.md`,
      );
    }
    lines.push(
      "Each INDEX line needs its own --confirm; the command never bulk-removes INDEX rows.",
    );
  }
  if (report.ambiguous.length > 0) {
    lines.push(
      "INDEX.md ambiguous pointers (left unchanged; review manually):",
    );
    for (const item of report.ambiguous.slice(0, 10)) {
      lines.push(
        `- INDEX.md line ${item.line}: ${redact(item.reason)} — ${clip(item.text)}`,
      );
    }
    if (report.ambiguous.length > 10) {
      lines.push(`- … ${report.ambiguous.length - 10} more ambiguous line(s)`);
    }
  }
  return lines;
}
```

Change the `renderForgetPreview` signature and replace its final INDEX paragraph:

```ts
export function renderForgetPreview(
  plan: ForgetPlan,
  reason: string,
  capWarning?: string,
  indexPointers?: IndexPointerReport,
): string {
```

Replace the existing block:

```ts
  lines.push(
    plan.file === "INDEX.md"
      ? "This forget targets INDEX.md itself; the file will be rewritten on confirm."
      : "INDEX.md is not rewritten automatically; remove stale pointers with `/memory-forget INDEX.md --line N --confirm`.",
  );
```

with:

```ts
  if (indexPointers === undefined) {
    lines.push(
      plan.file === "INDEX.md"
        ? "This forget targets INDEX.md itself; the file will be rewritten on confirm."
        : "INDEX.md is not rewritten automatically; remove stale pointers with `/memory-forget INDEX.md --line N --confirm`.",
    );
  } else {
    lines.push(
      ...renderIndexPointerSection(
        indexPointers,
        plan.file === "INDEX.md",
        "This forget targets INDEX.md itself; the file will be rewritten on confirm.",
      ),
    );
  }
```

Change `renderForgetResult` to use the new section:

```ts
export function renderForgetResult(result: ForgetResult): string {
  const lines = [
    "[memory] forget applied",
    `file: ${result.file}`,
    `removed: ${result.removedLineCount} line(s) in ${result.units} approval unit(s)`,
    `archive: ${result.archiveFile}`,
    "Warning: logical forget only; git history/backups may retain the text. Rotate any exposed secret.",
  ];
  lines.push(
    ...renderIndexPointerSection(
      result.indexPointers,
      result.file === "INDEX.md",
      "INDEX.md itself was rewritten; review any stale pointers in the new content.",
    ),
  );
  return lines.join("\n");
}
```

Add the INDEX inspection helper immediately after `transactionOptions`:

```ts
async function inspectIndexPointers(
  input: ForgetInput,
  current: string,
  plan: ForgetPlan,
): Promise<IndexPointerReport> {
  if (input.file === "INDEX.md") {
    return emptyIndexPointerReport("inspected");
  }
  try {
    const read = await readContainedText("INDEX.md", {
      memoryRoot: input.memoryRoot,
      onMissing: "skip",
    });
    if (read === undefined) return emptyIndexPointerReport("missing");
    if (read.truncated) return emptyIndexPointerReport("truncated");
    return detectIndexPointers({
      forgottenFile: input.file,
      currentFileText: current,
      nextFileText: plan.nextText,
      removedUnits: plan.units,
      indexText: read.text,
    });
  } catch {
    return emptyIndexPointerReport("unreadable");
  }
}
```

Update `previewForget` to compute and pass the report:

```ts
export async function previewForget(input: ForgetInput): Promise<string> {
  assertForgettable(input.file);
  // Read-only: do not take the write lock or create the memory root.
  const current = await readRawContained(input.file, {
    memoryRoot: input.memoryRoot,
  });
  const plan = planForget(input.file, current, input.selector);
  let capWarning: string | undefined;
  try {
    assertPostForgetCap(input, plan.nextText);
  } catch (error) {
    capWarning = error instanceof Error ? error.message : String(error);
  }
  const indexPointers = await inspectIndexPointers(input, current, plan);
  return renderForgetPreview(plan, input.reason, capWarning, indexPointers);
}
```

Update the `applyForget` return value (inside the second transaction, after the source `tx.write`):

```ts
    await tx.write(input.file, plan.nextText).catch((error: unknown) => {
      throw new Error(
        `[memory] forget incomplete: archive ${archiveFile} was created, but rewriting ${input.file} failed; inspect both before retrying`,
        { cause: error },
      );
    });
    const indexPointers = await inspectIndexPointers(input, current, plan);
    return {
      file: input.file,
      archiveFile,
      removedLineCount: plan.removedLineCount,
      units: plan.units.length,
      indexPointers,
    };
```

- [ ] **Step 4: Update the existing `renderForgetResult` test fixture**

In `test/forget.test.ts`, the test `"does not tell the user to remove stale pointers from a rewritten INDEX"` constructs a result. Add the new field:

```ts
    const result = renderForgetResult({
      file: "INDEX.md",
      archiveFile: "handoffs/archive/forgotten-x.md",
      removedLineCount: 1,
      units: 1,
      indexPointers: emptyIndexPointerReport("inspected"),
    });
```

- [ ] **Step 5: Run the forget tests**

```bash
npx vitest run test/forget.test.ts
```

Expected: all tests pass, including the four new ones.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0. If another test constructs `ForgetResult`, add `indexPointers` there too — search with:

```bash
grep -rn "renderForgetResult({" test/ src/
```

- [ ] **Step 7: Commit**

```bash
git add src/forget.ts test/forget.test.ts
git commit -m "feat: surface stale INDEX pointers in forget preview and result"
```

---

### Task 3: Emit and render the `indexStale` notice

**Files:**
- Modify: `src/capture.ts`
- Modify: `src/status.ts`
- Modify: `src/forget-command.ts`
- Modify: `test/hooks.test.ts`
- Modify: `test/lifecycle-commands.test.ts`

- [ ] **Step 1: Add the failing status-line test**

In `test/hooks.test.ts`, inside `describe("statusLine", …)`, add this test after the existing forget-notice test:

```ts
  it("reports stale INDEX pointers from a forget once, then clears the notice", async () => {
    await setNotice(storage, PROJECT, "indexStale", 2);
    expect(await hasStatusLine(storage, PROJECT)).toBe(true);
    const line = await statusLine(storage, PROJECT);
    expect(line).toContain("2 INDEX.md pointer(s) may be stale after a forget");
    expect(line).toContain("/memory-forget INDEX.md --line N --confirm");
    expect(await statusLine(storage, PROJECT)).toBeUndefined();
    expect(await hasStatusLine(storage, PROJECT)).toBe(false);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run test/hooks.test.ts -t "stale INDEX pointers"
```

Expected: FAIL — `"indexStale"` is not a valid `NoticeKind` (TypeScript) and `statusLine` does not report it. Do not change the test.

- [ ] **Step 3: Add the notice kind and atomic increment helper in `src/capture.ts`**

Change:

```ts
export type NoticeKind = "indexOverCap" | "captureFailed" | "forgotten";
```

to:

```ts
export type NoticeKind =
  | "indexOverCap"
  | "captureFailed"
  | "forgotten"
  | "indexStale";
```

Replace the existing `incNotice` function with:

```ts
/** Increment a notice counter by a positive delta under the mutex. */
export async function incNoticeBy(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
  delta: number,
): Promise<number> {
  if (!Number.isInteger(delta) || delta <= 0) {
    throw new Error("[memory] ledger notice delta must be a positive int");
  }
  return withWriteLock(async () => {
    const next = asCount(await storage.get(noticeKey(projectID, kind))) + delta;
    await storage.set(noticeKey(projectID, kind), next);
    return next;
  });
}

/** Increment a notice counter by one under the mutex. */
export function incNotice(
  storage: LedgerStorage,
  projectID: string,
  kind: NoticeKind,
): Promise<number> {
  return incNoticeBy(storage, projectID, kind, 1);
}
```

- [ ] **Step 4: Render the fact in `src/status.ts`**

Update the header comment “Five fixed-threshold facts” to “Six fixed-threshold facts” and add “the stale-INDEX-pointer notice” to the enumerated fact list in that comment.

Insert this block after the `forgotten` block and before the `pending` block:

```ts
    const indexStale = await takeNotice(storage, projectID, "indexStale");
    if (indexStale !== undefined) {
      facts.push(
        `${indexStale} INDEX.md pointer(s) may be stale after a forget; review the forget result and run /memory-forget INDEX.md --line N --confirm`,
      );
    }
```

In `hasStatusLine`, add this check after the `forgotten` check:

```ts
    if ((await getNotice(storage, projectID, "indexStale")) !== undefined) {
      return true;
    }
```

- [ ] **Step 5: Run the status-line test**

```bash
npx vitest run test/hooks.test.ts -t "stale INDEX pointers"
```

Expected: PASS.

- [ ] **Step 6: Add failing command-level tests**

Append these tests to the `describe("/memory-forget", …)` block in `test/lifecycle-commands.test.ts`:

```ts
  it("sets the indexStale notice and leaves INDEX.md unchanged when cleanup candidates exist", async () => {
    await writeFile(
      join(memory, "architecture.md"),
      "# Architecture\n## Queue\n- old adapter\n",
    );
    await writeFile(
      join(memory, "INDEX.md"),
      "- Queue → architecture.md:Queue\n",
    );
    await registerMemoryForget(ctx());
    await run("memory-forget", "architecture.md --line 3 --confirm");
    expect(permissionCalls).toBe(1);
    expect(store.get("proj/notice.forgotten")).toBe(1);
    expect(store.get("proj/notice.indexStale")).toBe(1);
    expect(await readFile(join(memory, "INDEX.md"), "utf8")).toBe(
      "- Queue → architecture.md:Queue\n",
    );
    expect(posts.join("\n")).toContain("INDEX.md candidate cleanup");
    expect(posts.join("\n")).toContain(
      "/memory-forget INDEX.md --line 1 --confirm",
    );
  });

  it("does not set the indexStale notice when no INDEX pointer matches", async () => {
    await writeFile(
      join(memory, "architecture.md"),
      "# Architecture\n- keep\n- drop\n",
    );
    await writeFile(
      join(memory, "INDEX.md"),
      "- architecture: contracts, sibling implementations\n",
    );
    await registerMemoryForget(ctx());
    await run("memory-forget", "architecture.md --line 3 --confirm");
    expect(store.get("proj/notice.forgotten")).toBe(1);
    expect(store.get("proj/notice.indexStale")).toBeUndefined();
    expect(await readFile(join(memory, "INDEX.md"), "utf8")).toBe(
      "- architecture: contracts, sibling implementations\n",
    );
  });
```

- [ ] **Step 7: Run the command tests and confirm they fail**

```bash
npx vitest run test/lifecycle-commands.test.ts -t "indexStale"
```

Expected: FAIL — `notice.indexStale` is never set.

- [ ] **Step 8: Wire the increment in `src/forget-command.ts`**

Change the import:

```ts
import { incNotice, incNoticeBy } from "./capture.js";
```

Replace the notice block:

```ts
          try {
            await incNotice(
              asLedger(ctx.storage),
              projectIDOf(ctx),
              "forgotten",
            );
          } catch (error) {
            // The write already happened; a notice failure must not undo it.
            logDiagnostic(error);
          }
```

with:

```ts
          try {
            const ledger = asLedger(ctx.storage);
            const projectID = projectIDOf(ctx);
            await incNotice(ledger, projectID, "forgotten");
            const stale = result.indexPointers.candidates.length;
            if (stale > 0) {
              await incNoticeBy(ledger, projectID, "indexStale", stale);
            }
          } catch (error) {
            // The write already happened; a notice failure must not undo it.
            logDiagnostic(error);
          }
```

- [ ] **Step 9: Run the command tests**

```bash
npx vitest run test/lifecycle-commands.test.ts
```

Expected: all tests pass.

- [ ] **Step 10: Run the hooks tests and typecheck**

```bash
npx vitest run test/hooks.test.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/capture.ts src/status.ts src/forget-command.ts test/hooks.test.ts test/lifecycle-commands.test.ts
git commit -m "feat: report stale INDEX pointer notices after forget"
```

---

### Task 4: Surface pending stale pointers in `/memory-status`

**Files:**
- Modify: `src/status-report.ts`
- Modify: `test/status-report.test.ts`

- [ ] **Step 1: Add the failing status-report test**

In `test/status-report.test.ts`, inside `describe("collectStatus + renderStatusReport", …)`, add this test after the deterministic-render test:

```ts
  it("surfaces pending stale INDEX pointers without consuming the notice", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const storage = new FakeStorage();
    await storage.set(`${PROJECT}/notice.indexStale`, 2);

    const report = await collectStatus({
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage,
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
      version: "2.0.29",
      agentNames: ["memory-manager"],
    });
    const text = renderStatusReport(report);
    expect(report.indexStalePointers).toBe(2);
    expect(text).toContain("| stale INDEX pointers | 2 |");
    expect(text).toContain("review 2 stale INDEX.md pointer(s)");
    expect(text).toContain("/memory-forget INDEX.md --line N --confirm");
    expect(await storage.get(`${PROJECT}/notice.indexStale`)).toBe(2);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run test/status-report.test.ts -t "stale INDEX pointers"
```

Expected: FAIL — `report.indexStalePointers` is undefined and the rendered row/action is missing.

- [ ] **Step 3: Modify `src/status-report.ts`**

Change the capture import:

```ts
import { getNotice, type LedgerStorage } from "./capture.js";
```

Add the field to `StatusReport`:

```ts
  readonly since?: string;
  readonly newestHandoff?: string;
  readonly indexStalePointers: number;
  readonly actions: readonly string[];
```

Add the action in `deriveActions` after the pending-captures action:

```ts
  if (report.indexStalePointers > 0) {
    actions.push(
      `review ${report.indexStalePointers} stale INDEX.md pointer(s) from a forget; run /memory-forget INDEX.md --line N --confirm with the line numbers from the forget result`,
    );
  }
```

Add the read to `collectStatus`:

```ts
  const [
    health,
    protocol,
    permission,
    since,
    totals,
    newestHandoff,
    exists,
    indexExists,
    indexStale,
  ] = await Promise.all([
    collectHealth(deps.memoryRoot, deps.storage, deps.projectID, deps.caps),
    protocolStatusOf(deps.projectRoot),
    permissionRuleOf(deps.projectRoot, home),
    readSince(deps.storage, deps.projectID),
    readTotals(deps.storage, deps.projectID),
    newestHandoffName(deps.memoryRoot),
    pathExists(deps.memoryRoot),
    pathExists(join(deps.memoryRoot, "INDEX.md")),
    getNotice(deps.storage, deps.projectID, "indexStale"),
  ]);
```

Add the field to `base`:

```ts
    since,
    newestHandoff,
    indexStalePointers: indexStale ?? 0,
  };
```

Add the Activity row in `renderStatusReport`, after the `seen entries` row:

```ts
  lines.push(`| stale INDEX pointers | ${report.indexStalePointers} |`);
```

- [ ] **Step 4: Run the status-report tests**

```bash
npx vitest run test/status-report.test.ts
```

Expected: all tests pass. Existing deterministic-render and read-only assertions must still pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0. If another test constructs a `StatusReport` literal, add `indexStalePointers: 0` — search with:

```bash
grep -rn "StatusReport = {\|as StatusReport\|satisfies StatusReport" src/ test/
```

- [ ] **Step 6: Commit**

```bash
git add src/status-report.ts test/status-report.test.ts
git commit -m "feat: show pending stale INDEX pointers in /memory-status"
```

---

### Task 5: Documentation and changelog

**Files:**
- Modify: `docs/adr/0009-forget-and-handoff-gc.md`
- Modify: `docs/design-spec-v2-production.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Revise ADR-0009**

Replace decision item 5 in `docs/adr/0009-forget-and-handoff-gc.md` with:

```md
5. **INDEX cleanup is detected, never inferred.** After a forget from `activeContext.md`, `architecture.md`, `style.md`, or `issues.md`, the planner detects INDEX lines that point at the forgotten content: an exact literal topic/section phrase that disappears from the file, or a `file:section` pointer whose section loses all remaining non-blank content. Unambiguous candidates are listed with exact line numbers and an explicit, separate follow-up `/memory-forget INDEX.md --line N --confirm`; every INDEX line is approved on its own and the source forget never rewrites INDEX. A file-general map line, an unresolvable section, a duplicate heading match, or a line that also points at remaining content is reported as ambiguous and left unchanged for manual editing. This keeps the conservative posture: no silent inference and no bulk removal.
```

Replace decision item 9 with:

```md
9. **Status notice.** A successful forget increments the transient `<projectID>/notice.forgotten` storage notice (not a metric). When the forget produced unambiguous INDEX cleanup candidates, it also adds their count to `<projectID>/notice.indexStale`; the next prompt status line reports both facts and consumes them atomically. GC does not add a notice.
```

Replace the consequence bullet about INDEX cleanup with:

```md
- `INDEX.md` cleanup is explicit, but stale candidates are surfaced with exact line numbers; ambiguous mappings remain manual. No INDEX row is removed without its own `--confirm`.
```

- [ ] **Step 2: Amend the design spec**

In `docs/design-spec-v2-production.md`, after the Tier-3 forget notice bullet in §5.7, add:

```md
  - **Tier-3 amendment (2026-11-02, INDEX cleanup):** a successful `/memory-forget` that produced unambiguous INDEX cleanup candidates adds their count to `<projectID>/notice.indexStale`; `statusLine()` emits
    `[memory] <n> INDEX.md pointer(s) may be stale after a forget; review the forget result and run /memory-forget INDEX.md --line N --confirm`
    and consumes it atomically. Count-only transient storage, not a metric; the source forget never rewrites INDEX.
```

In §5.13, after the fixed checks list (before “Renderer contract”), add:

```md
**Tier-3 amendment (2026-11-02, stale INDEX pointers).** `collectStatus` also reads the transient
`<projectID>/notice.indexStale` count with `getNotice` (it does not consume it). When > 0, the Activity
table renders `| stale INDEX pointers | <n> |` and the next actions include
“review <n> stale INDEX.md pointer(s) from a forget; run /memory-forget INDEX.md --line N --confirm
with the line numbers from the forget result.” This is read-only: the notice remains queued for the
prompt status line, and no counter or storage key is written.
```

In §6, after the lifecycle-commands table, add:

```md
INDEX cleanup is a second explicit step: the source forget lists unambiguous candidate lines with
exact numbers and a per-line `/memory-forget INDEX.md --line N --confirm`; ambiguous pointers stay
manual. The source forget never rewrites INDEX and never bulk-removes rows.
```

In §7 step 8, replace the step text with:

```md
8. **Forget/GC (explicit, user-invoked):** `/memory-forget` previews by default; `--confirm` requires
   per-unit approval and archives removed text before rewriting. A structural-file forget also detects
   INDEX pointers that the selection made stale, lists unambiguous candidates with exact line numbers,
   and offers a separate per-line `/memory-forget INDEX.md --line N --confirm`; ambiguous pointers
   remain a manual edit. `/memory-gc` previews root handoffs; `--confirm` takes one batch approval and
   re-plans under the lock. `decisions.md` and handoffs are rejected by forget; archive is never purged.
   No model-facing delete tool and no sixth option (ADR-0009).
```

- [ ] **Step 3: Update the README lifecycle section**

In `README.md`, after the paragraph that ends “If you are removing an exposed secret, rotate it as well.”, add:

```md
After forgetting from `activeContext.md`, `architecture.md`, `style.md`, or `issues.md`, the preview and result also check `INDEX.md` for lines that point at the removed content. Unambiguous pointers are listed with exact line numbers and a separate per-line follow-up:

```text
/memory-forget INDEX.md --line 7 --confirm
```

Nothing is bulk-removed, the source forget never rewrites `INDEX.md`, and pointers that are file-general or only partly related are reported as ambiguous for you to edit by hand. A successful forget with candidates leaves a status notice so the follow-up is not lost.
```

Replace the sentence “A successful forget leaves a short status notice on a later prompt, reminding you that the content was archived and may persist in git history or backups.” with:

```md
A successful forget leaves a short status notice on a later prompt, reminding you that the content was archived and may persist in git history or backups. If the forget left unambiguous INDEX pointers, the same status line says how many and points to the per-line cleanup command.
```

In “Things to know before you rely on it”, replace the forget bullet with:

```md
- **Forget is not secure erasure, and GC is irreversible.** Forgetting archives before rewriting, but old copies may survive in git, backups, or caches. GC deletes root handoffs outright and never touches `handoffs/archive/`. INDEX cleanup is suggested, not automatic: a forget lists stale pointer candidates, but you remove each one with its own `--confirm`.
```

- [ ] **Step 4: Update CONTRIBUTING**

In the repository layout, add this line after `forget-command.ts`:

```text
├── index-pointers.ts  # INDEX pointer detection for forget cleanup (pure)
```

In the testing acceptance list, after the forget/GC bullet, add:

```md
- Forget detects stale INDEX pointers, offers per-line follow-ups, and never rewrites INDEX.
```

In invariant #2, append this sentence:

```md
INDEX cleanup is suggested as a separate per-line command, never applied by the source forget.
```

- [ ] **Step 5: Add the CHANGELOG entry**

At the top of the `## Unreleased` section in `CHANGELOG.md`, add:

```md
- Issue #23 (E13 INDEX cleanup): after a successful `/memory-forget` from a structural file, the command detects `INDEX.md` lines that point at the forgotten content and lists unambiguous candidates with exact line numbers plus a per-line `/memory-forget INDEX.md --line N --confirm` follow-up. Literal topic/section pointers that disappear with the selection and `file:section` pointers whose section loses all content are candidates; file-general and unresolvable/partially-valid pointers are left unchanged and reported as ambiguous. INDEX is never rewritten by the source forget, no INDEX rows are bulk-removed, and the model-facing surface is unchanged. A successful forget with candidates increments the transient `notice.indexStale` count (not a metric), which the `[memory]` status line reports once and `/memory-status` shows as a pending next action. No new option, no new metric name, no model-callable delete tool.
```

- [ ] **Step 6: Check formatting for the hand-edited docs**

```bash
npx prettier --check README.md CONTRIBUTING.md
```

Expected: PASS. Do not run Prettier across the design spec or ADR; the repository has no repo-wide format gate and a broad rewrite would obscure the diff.

- [ ] **Step 7: Commit**

```bash
git add README.md CONTRIBUTING.md CHANGELOG.md docs/adr/0009-forget-and-handoff-gc.md docs/design-spec-v2-production.md
git commit -m "docs: document INDEX pointer cleanup after forget"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run the full suite**

```bash
npm test
```

Expected: all tests pass. Pay special attention to `test/acceptance.test.ts` (budgets, tool surface, forget/GC acceptance) and `test/cross-process.test.ts` (the new INDEX read must not introduce a write path).

- [ ] **Step 3: Run the CI coverage command**

```bash
npm run test:coverage
```

Expected: exit 0. Coverage should include `src/index-pointers.ts`; all branches of the candidate/ambiguous classifier are exercised by Task 1 tests.

- [ ] **Step 4: Verify the no-delete-tool invariant**

```bash
grep -R "memory_forget\|memory_delete\|memory_gc" src/tools.ts src/index.ts || true
```

Expected: no output. The forget/GC commands remain command-only; the only new storage key is the transient `notice.indexStale`, not a tool.

- [ ] **Step 5: Review the final diff**

```bash
git diff --stat main
git diff main
```

Check specifically:
- `applyForget` writes only `input.file` and the archive, never `INDEX.md`.
- `renderForgetPreview` with no `indexPointers` argument still produces the old caveat (backward-compatible tests).
- `permission.assert` is called once per source unit and never for INDEX candidates.
- The status line remains at most one line; `statusLine` and `hasStatusLine` list the same facts.
- No new config option, metric name, or model-callable tool appears.

- [ ] **Step 6: Commit any verification fixes**

If Step 1–5 required changes:

```bash
git add -u
git commit -m "test: finish INDEX pointer cleanup verification"
```

If no changes were needed, skip this step.

---

## Self-review against issue #23

Use this checklist before opening the PR.

**Spec coverage**

| Issue requirement | Where implemented / tested |
| --- | --- |
| Detect INDEX lines pointing at the forgotten file/content | Task 1 detector; Task 2 preview/result. |
| Surface candidates with exact line numbers in a dry-run preview | Task 2 tests assert `INDEX.md line 1` and the follow-up command. |
| Offer a follow-up `--confirm` step when unambiguous | Task 2 renders `/memory-forget INDEX.md --line N --confirm`; Task 3 command test verifies INDEX is unchanged. |
| Keep the manual follow-up when ambiguous, and say why | Task 1 ambiguous reasons; Task 2 preview test asserts “section still has content” and no removal offer. |
| Include candidates in the command result | `ForgetResult.indexPointers`; Task 2 apply test. |
| Include candidates in the `notice.forgotten` status fact where appropriate | Task 3 adds `notice.indexStale` alongside `notice.forgotten`; Task 4 surfaces it in `/memory-status`. |
| Update ADR-0009 | Task 5 Step 1. |
| Update spec §5.7/§5.13 | Task 5 Step 2. |
| Update README lifecycle docs | Task 5 Step 3. |
| Tests | Tasks 1–4. |
| Forgetting a structural line reports exact candidates or “no INDEX pointer found” | Task 1 + Task 2 no-pointer test. |
| Dry-run mutates nothing | Task 2 preview test reads INDEX before/after and asserts equality. |
| `--confirm` requires per-unit approval | Task 3 command test asserts `permissionCalls === 1` for one source unit and no INDEX write. |
| No false removal when INDEX points at the file generally | Task 1 file-general test; Task 2 no-pointer test. |
| `decisions.md`, handoffs, archive remain non-forgettable | Existing `assertForgettable` / `planForget` tests remain green; no code path changes them. |
| No model-facing delete tool | Task 6 Step 4 grep; no tool registration changes. |
| Stale-plan abort | Existing `applyForget` re-plan/compare test remains green; candidate follow-ups re-plan against the current INDEX when invoked. |
| Out of scope: TTL/decay, archive purge, model-initiated forget | Not touched. |

**Placeholder scan**

- No “TBD”, “implement later”, “add validation”, or “similar to Task N” steps.
- Every code step contains the exact code to write.
- Every command has an expected result.

**Type consistency**

- `IndexPointerReport` is defined once in `src/index-pointers.ts` and imported by `src/forget.ts`; `ForgetResult.indexPointers` uses the same type.
- `emptyIndexPointerReport(status)` is used with `"inspected"` in tests and `"missing"`/`"truncated"`/`"unreadable"` at the I/O boundary.
- `incNoticeBy` is defined in `src/capture.ts`, imported by `src/forget-command.ts`, and keeps `incNotice` as the one-argument wrapper.
- `notice.indexStale` is the only new storage key; `getNotice`/`takeNotice`/`incNoticeBy` all use the existing `noticeKey` shape.
- `StatusReport.indexStalePointers` is the exact field name used in `collectStatus`, `deriveActions`, `renderStatusReport`, and the status-report test.

**Known interpretation to state in the PR description**

- “Offer a follow-up `--confirm` step” is implemented as an **explicit second command invocation** (`/memory-forget INDEX.md --line N --confirm`), not a new flag and not an automatic INDEX rewrite. This preserves the per-line approval gate and avoids a single command mutating two files. If reviewers want same-invocation cleanup, that is a separate design change and should not be folded into this PR.
