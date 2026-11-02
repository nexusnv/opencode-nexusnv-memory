# E15 — Explicit memory initialization gate (Issue #20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the memory plugin inert for a project until the user explicitly runs `/memory-init`. A project is initialized when `.opencode/memory/INDEX.md` exists as a regular file. Before that, setup creates nothing, hooks inject and capture nothing, no metrics counter is bumped, and every memory tool/command except `/memory-init`, `/memory-status`, and `memory_status` returns one fixed message. `/memory-init` is idempotent repair: it creates only missing directories/templates, never overwrites, and creates `INDEX.md` last so a partial scaffold never activates the plugin.

**Architecture:** A new `src/init.ts` owns the `isInitialized()` probe, the idempotent `initializeMemory()` repair, the deterministic `renderInitResult()`, and the `/memory-init` command registration. `src/index.ts` stops scaffolding, registers the init command, and guards every hook and the event loop before any metric bump or event mutation. `src/tools.ts`, `src/review.ts`, `src/forget-command.ts`, `src/gc-command.ts`, and `src/metrics.ts` guard at their executors; `src/status-report.ts` stays available and reports the initialization state. `src/files.ts` and `src/capture.ts` are deliberately unchanged: the gate lives at the production surfaces, not the writers.

**Tech Stack:** TypeScript 5.9 strict, Node.js 20+, Vitest 5, existing `writeNewCapped()` exclusive-create path, `ctx.command.transform`, `ctx.session.synthetic` + `postCommandOutput` fallback. No new dependency, no new config option, no new metric name, no new storage key, no model-facing init tool.

**Design:** `docs/superpowers/specs/2026-11-02-explicit-memory-init-design.md`

---

## Scope and locked decisions

Do not re-litigate these during implementation.

1. **Full gate.** No INDEX attach, brief injection, priors, prompt notices, `remember:` writes, failure capture, idle/compaction snapshots, or memory tool/command work before initialization. No metrics counters are bumped, including `hook.*`.
2. **`INDEX.md` presence is the signal.** A regular file at `.opencode/memory/INDEX.md` means initialized. Existing installs activate automatically. Deleting it re-inerts the plugin without a restart. A directory/symlink/special file named `INDEX.md` is **not** initialized (use `lstat().isFile()`).
3. **Only `/memory-init`, `/memory-status`, and `memory_status` work pre-init.** Every other memory command/tool returns exactly:

   ```text
   [memory] not initialized; run /memory-init to create .opencode/memory
   ```

   Blocked commands may still render `--help` usage; no operation runs.
4. **`/memory-init` is the only init affordance.** Plugin-registered, user-invoked, never a model-facing tool, never a file-based command stub.
5. **`/memory-init` is idempotent repair.** It creates only missing directories/files and never overwrites. `INDEX.md` is created last. If `INDEX.md` was absent and any earlier target failed, `INDEX.md` is not created and the project stays uninitialized.
6. **First init prints the consolidated checklist.** A repair run prints only a created/already-present summary. If `INDEX.md` was absent while other templates existed, warn that the new INDEX is the default map and does not reconstruct a lost custom map.
7. **Setup is silent pre-init.** No scaffold, no checklist, no permission warning, no AGENTS.md nudge. Config-option warnings from `parseMemoryOptions` remain. Initialized projects keep the existing permission warning and once-per-process AGENTS.md nudge.
8. **Status is always a full doctor.** Add an `initialization` row and a `/memory-init` next action. Keep the existing checks and counts. Suppress only the “no captures observed yet” advice while uninitialized.
9. **Pre-init `remember:` is silently ignored.** No write, no notice, no buffer.
10. **No new option, metric name, storage key, or model-facing tool.** The five-option contract and ADR-0008 vocabulary stay frozen.

---

## File map

**Create**

| File | Responsibility |
| --- | --- |
| `src/init.ts` | `isInitialized`, `initializeMemory`, `renderInitResult`, `/memory-init` registration, fixed pre-init message. |
| `test/init.test.ts` | Unit and command coverage for the init module. |
| `docs/adr/0011-explicit-memory-initialization.md` | Normative decision record. |

**Modify**

| File | Change |
| --- | --- |
| `src/templates.ts` | Rename `firstRunInstallText()` → `initInstallText()`; remove the “first run: scaffolded” leading line; checklist starts at `Next steps:`. |
| `src/index.ts` | Remove `scaffoldMemoryDir()`; register `/memory-init`; guard four hooks and the event loop; print setup messages only when initialized. |
| `src/status-report.ts` | `initialized` field; `initialization` row; explicit-init directory/INDEX wording; `/memory-init` actions; suppress capture advice pre-init. |
| `src/tools.ts` | Gate all four tool executors. |
| `src/review.ts` | Gate `/memory-review` after no help path exists (it has none); fixed message via `postCommandOutput`. |
| `src/forget-command.ts` | Gate after `--help`, before parse errors/reads/writes. |
| `src/gc-command.ts` | Gate after `--help`, before parse errors/reads/writes. |
| `src/metrics.ts` | Gate `/memory-metrics` before bump/reset/render. |
| `commands/memory-review.md` | Preflight: missing INDEX → stop and ask for `/memory-init`. |
| `agents/memory-manager.md` | Same preflight. |
| `test/scaffold.test.ts` | Setup no longer scaffolds; `memory-init` registered; `initInstallText()` checklist. |
| `test/hooks.test.ts` | Seed scaffold in `beforeEach`; adjust missing-INDEX capture expectation. |
| `test/tools.test.ts` | Registration tests already seed INDEX; add pre-init gate test. |
| `test/review.test.ts` | Seed scaffold in `beforeEach`; add pre-init gate test. |
| `test/lifecycle-commands.test.ts` | Seed INDEX in `beforeEach`; add forget/GC gate tests. |
| `test/metrics.test.ts` | Seed a per-test command project with INDEX; add pre-init gate test. |
| `test/status-report.test.ts` | Initialization row/actions/wording assertions. |
| `test/acceptance-metrics.test.ts` | Seed scaffold before the real setup; expect `memory-init` command. |
| `test/isolation.test.ts` | Seed INDEX in `beforeEach`; setup wiring still dispatches events. |
| `docs/design-spec-v2-production.md` | §§4.4, 5.7, 5.13, 7 step 0, 10, and the E15 roadmap entry. |
| `docs/user-stories.md` | US-04 and US-30. |
| `docs/adr/0006-fixed-memory-location.md` | Replace “on first run it scaffolds” with explicit init. |
| `README.md` | Quickstart step 3, daily-use commands, privacy/status, troubleshooting, uninstall. |
| `CONTRIBUTING.md` | Layout entry, invariants, manual P0 parity. |
| `docs/c4-03-components.md`, `docs/c4-04-interfaces.md`, `docs/c4-06-code.md` | Initialization gate and new module. |
| `CHANGELOG.md` | Unreleased entry. |

---

## Before you start

- [ ] **Confirm the branch**

```bash
git branch --show-current
git status --short
```

Expected: `feat/explicit-memory-init`; only `docs/superpowers/specs/2026-11-02-explicit-memory-init-design.md` was committed in the preceding commit. If the branch is wrong, create it from `main` before proceeding.

- [ ] **Confirm the baseline is green**

```bash
npm run typecheck
npm test
```

Expected: both exit 0. Do not start implementation if the baseline fails; record and fix it separately first.

---

## Task 1: Add the init core module

**Files:**
- Create: `test/init.test.ts`
- Create: `src/init.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `test/init.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeMemory,
  isInitialized,
  renderInitResult,
} from "../src/init.js";
import { MEMORY_FILES, getScaffoldFiles } from "../src/templates.js";

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-init-"));
  return join(root, ".opencode", "memory");
}

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-init-project-"));
}

describe("isInitialized", () => {
  it("is false for a missing root or missing INDEX.md", async () => {
    const root = await tempRoot();
    expect(await isInitialized(root)).toBe(false);
    await mkdir(root, { recursive: true });
    expect(await isInitialized(root)).toBe(false);
  });

  it("is true only for a regular INDEX.md", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "INDEX.md"), "# INDEX\n");
    expect(await isInitialized(root)).toBe(true);

    await rm(join(root, "INDEX.md"));
    await mkdir(join(root, "INDEX.md"));
    expect(await isInitialized(root)).toBe(false);

    await rm(join(root, "INDEX.md"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "memory-init-link-"));
    const target = join(outside, "INDEX.md");
    await writeFile(target, "# INDEX\n");
    await symlink(target, join(root, "INDEX.md"));
    expect(await isInitialized(root)).toBe(false);
  });
});

describe("initializeMemory", () => {
  it("creates six templates and both handoff directories on first init", async () => {
    const root = await tempRoot();
    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(true);
    expect(result.initialized).toBe(true);
    // INDEX is deliberately created last.
    expect(result.created).toEqual([
      ...MEMORY_FILES.filter((name) => name !== "INDEX.md"),
      "INDEX.md",
    ]);
    expect(result.present).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.lostMapWarning).toBe(false);
    expect(await isInitialized(root)).toBe(true);
    for (const name of MEMORY_FILES) {
      expect(await readFile(join(root, name), "utf8")).toBe(
        getScaffoldFiles()[name],
      );
    }
    // The archive dir is empty but must be present; reading it as a file
    // must fail rather than fall through to a missing-path error.
    await expect(readFile(join(root, "handoffs", "archive"), "utf8")).rejects.toThrow();
  });

  it("never overwrites and reports existing files", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "INDEX.md"), "# custom map\n");
    await writeFile(join(root, "decisions.md"), "- keep me\n");

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(false);
    expect(result.initialized).toBe(true);
    expect(result.created).not.toContain("INDEX.md");
    expect(result.created).not.toContain("decisions.md");
    expect(result.present).toContain("INDEX.md");
    expect(result.present).toContain("decisions.md");
    expect(await readFile(join(root, "INDEX.md"), "utf8")).toBe("# custom map\n");
    expect(await readFile(join(root, "decisions.md"), "utf8")).toBe("- keep me\n");
  });

  it("repairs only the missing template", async () => {
    const root = await tempRoot();
    await initializeMemory({ memoryRoot: root });
    await rm(join(root, "style.md"));

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(false);
    expect(result.created).toEqual(["style.md"]);
    expect(result.present).toContain("INDEX.md");
    expect(result.failures).toEqual([]);
    expect(await readFile(join(root, "style.md"), "utf8")).toBe(
      getScaffoldFiles()["style.md"],
    );
  });

  it("does not create INDEX when an earlier target fails", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    // A directory at a template path makes the exclusive create fail.
    await mkdir(join(root, "activeContext.md"));

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(true);
    expect(result.initialized).toBe(false);
    expect(result.created).not.toContain("INDEX.md");
    expect(result.failures.some((f) => f.startsWith("activeContext.md:"))).toBe(
      true,
    );
    expect(await isInitialized(root)).toBe(false);
  });

  it("warns that a recreated INDEX is the default map when other files survived", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "decisions.md"), "- survive\n");

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(true);
    expect(result.lostMapWarning).toBe(true);
    expect(await readFile(join(root, "decisions.md"), "utf8")).toBe("- survive\n");
  });

  it("is safe when two init calls race", async () => {
    const root = await tempRoot();
    const [first, second] = await Promise.all([
      initializeMemory({ memoryRoot: root }),
      initializeMemory({ memoryRoot: root }),
    ]);
    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(true);
    expect(await isInitialized(root)).toBe(true);
    expect(
      [...first.created, ...second.created].sort(),
    ).toEqual([...MEMORY_FILES].sort());
  });
});

describe("renderInitResult", () => {
  it("prints the checklist only on first init", async () => {
    const root = await tempRoot();
    const result = await initializeMemory({ memoryRoot: root });
    const text = renderInitResult(result);
    expect(text).toContain("[memory] initialized .opencode/memory");
    expect(text).toContain("Created: ");
    expect(text).toContain("activeContext.md");
    expect(text).toContain("INDEX.md");
    expect(text).toContain("Next steps:");
    expect(text).toContain("memory_write");
    expect(text).toContain("Verify the install anytime with /memory-status");
  });

  it("prints a repair summary without the checklist", async () => {
    const root = await tempRoot();
    await initializeMemory({ memoryRoot: root });
    await rm(join(root, "issues.md"));
    const text = renderInitResult(await initializeMemory({ memoryRoot: root }));
    expect(text).toContain("[memory] memory already initialized; repair complete.");
    expect(text).toContain("Created: issues.md");
    expect(text).not.toContain("Next steps:");
  });

  it("states that the project remains uninitialized on failure", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "activeContext.md"));
    const text = renderInitResult(await initializeMemory({ memoryRoot: root }));
    expect(text).toContain("initialization did not complete");
    expect(text).toContain("not initialized");
    expect(text).toContain("Fix the failure and re-run /memory-init");
  });
});
```

- [ ] **Step 2: Run the new tests; expect a module-resolution failure**

```bash
npx vitest run test/init.test.ts
```

Expected: FAIL because `src/init.ts` does not exist.

- [ ] **Step 3: Create `src/init.ts`**

```ts
/**
 * Explicit initialization gate (E15, issue #20; ADR-0011).
 *
 * A project is initialized when `.opencode/memory/INDEX.md` exists as a
 * regular file. Until then every production surface is inert; `/memory-init`
 * is the only writer, and it creates INDEX last so a partial scaffold never
 * activates the plugin.
 */
import type { Plugin } from "@opencode/plugin";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  memoryRootOf,
  postCommandOutput,
} from "./command-context.js";
import { parseMemoryOptions } from "./config.js";
import { writeNewCapped } from "./files.js";
import {
  ARCHIVE_DIR,
  HANDOFFS_DIR,
  MEMORY_FILES,
  getScaffoldFiles,
  initInstallText,
} from "./templates.js";

export const MEMORY_INIT_COMMAND_NAME = "memory-init";
export const MEMORY_INIT_COMMAND_DESCRIPTION =
  "Initialize the memory store on demand (creates .opencode/memory; never overwrites)";
export const MEMORY_NOT_INITIALIZED =
  "[memory] not initialized; run /memory-init to create .opencode/memory";
export const MEMORY_INIT_USAGE = [
  "Usage: /memory-init",
  "Creates .opencode/memory/ with the six starter files plus handoffs/ and handoffs/archive/.",
  "Idempotent: only missing paths are created; existing files are never overwritten.",
  "INDEX.md is created last; until it exists the plugin stays inert.",
].join("\n");

export interface MemoryInitInput {
  readonly memoryRoot: string;
  readonly indexLines?: number;
  readonly fileLines?: number;
}

export interface MemoryInitResult {
  readonly firstInit: boolean;
  readonly created: readonly string[];
  readonly present: readonly string[];
  readonly failures: readonly string[];
  readonly initialized: boolean;
  readonly lostMapWarning: boolean;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Fail closed: every probe error means “not initialized”. Never throws. */
export async function isInitialized(memoryRoot: string): Promise<boolean> {
  return isRegularFile(join(resolve(memoryRoot), "INDEX.md"));
}

function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Idempotent create/repair. Creates `INDEX.md` last; when `INDEX.md` was
 * absent and any earlier target failed, INDEX is never attempted, so the
 * project remains uninitialized.
 */
export async function initializeMemory(
  input: MemoryInitInput,
): Promise<MemoryInitResult> {
  const root = resolve(input.memoryRoot);
  const firstInit = !(await isInitialized(root));
  const created: string[] = [];
  const present: string[] = [];
  const preexisting: string[] = [];
  const failures: string[] = [];
  const opts = {
    memoryRoot: root,
    indexLines: input.indexLines,
    fileLines: input.fileLines,
  };

  for (const dir of [HANDOFFS_DIR, ARCHIVE_DIR]) {
    try {
      await mkdir(join(root, dir), { recursive: true });
    } catch (error) {
      failures.push(`${dir}/: ${errorLine(error)}`);
    }
  }

  const templates = getScaffoldFiles();
  for (const name of MEMORY_FILES) {
    if (name === "INDEX.md") continue;
    if (await isRegularFile(join(root, name))) {
      present.push(name);
      preexisting.push(name);
      continue;
    }
    try {
      const outcome = await writeNewCapped(name, templates[name] ?? "", opts);
      if (outcome === "created") {
        created.push(name);
      } else if (await isRegularFile(join(root, name))) {
        present.push(name);
      } else {
        failures.push(`${name}: existing path is not a regular file`);
      }
    } catch (error) {
      failures.push(`${name}: ${errorLine(error)}`);
    }
  }

  if (failures.length === 0) {
    if (await isRegularFile(join(root, "INDEX.md"))) {
      present.push("INDEX.md");
    } else {
      try {
        const outcome = await writeNewCapped(
          "INDEX.md",
          templates["INDEX.md"] ?? "",
          opts,
        );
        if (outcome === "created") {
          created.push("INDEX.md");
        } else if (await isRegularFile(join(root, "INDEX.md"))) {
          present.push("INDEX.md");
        } else {
          failures.push("INDEX.md: existing path is not a regular file");
        }
      } catch (error) {
        failures.push(`INDEX.md: ${errorLine(error)}`);
      }
    }
  }

  const initialized = await isInitialized(root);
  if (!initialized && failures.length === 0) {
    failures.push("INDEX.md: not a regular readable file");
  }

  return {
    firstInit,
    created,
    present,
    failures,
    initialized,
    lostMapWarning: firstInit && initialized && preexisting.length > 0,
  };
}

/** Deterministic command output. No memory body, no captured content. */
export function renderInitResult(result: MemoryInitResult): string {
  const lines: string[] = [];
  if (result.initialized) {
    lines.push(
      result.failures.length > 0
        ? "[memory] memory is initialized, but repair did not complete."
        : result.firstInit
          ? "[memory] initialized .opencode/memory (+ handoffs/)."
          : "[memory] memory already initialized; repair complete.",
    );
  } else {
    lines.push(
      "[memory] initialization did not complete; .opencode/memory is not initialized.",
    );
  }
  lines.push(
    `Created: ${result.created.length > 0 ? result.created.join(", ") : "(none)"}`,
  );
  lines.push(
    `Already present: ${result.present.length > 0 ? result.present.join(", ") : "(none)"}`,
  );
  if (result.failures.length > 0) {
    lines.push("Failed:");
    for (const failure of result.failures) lines.push(`- ${failure}`);
  }
  if (result.lostMapWarning) {
    lines.push("");
    lines.push(
      "[memory] warning: INDEX.md was missing while other memory files were present. The new INDEX.md is the default map; it does not reconstruct a lost custom map. Existing files were left untouched.",
    );
  }
  if (result.firstInit && result.initialized) {
    lines.push("");
    lines.push(initInstallText());
  }
  if (!result.initialized) {
    lines.push(
      "Fix the failure and re-run /memory-init. No memory is read or written until initialization completes.",
    );
  }
  return lines.join("\n");
}

/**
 * `/memory-init` — user-invoked only. Accepts no arguments except help.
 * Never throws; output is required (synthetic, then the §5.5 fallback).
 */
export function registerMemoryInit(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_INIT_COMMAND_NAME,
      description: MEMORY_INIT_COMMAND_DESCRIPTION,
      execute: async (invocation) => {
        try {
          const arg =
            typeof invocation.prompt?.text === "string"
              ? invocation.prompt.text.trim()
              : "";
          if (arg === "--help" || arg === "-h") {
            await postCommandOutput(ctx, invocation, MEMORY_INIT_USAGE, true);
            return;
          }
          if (arg.length > 0) {
            await postCommandOutput(
              ctx,
              invocation,
              `[memory] init: unexpected argument\n\n${MEMORY_INIT_USAGE}`,
              true,
            );
            return;
          }
          const options = parseMemoryOptions(ctx.options);
          const result = await initializeMemory({
            memoryRoot: memoryRootOf(ctx),
            indexLines: options.indexLines,
            fileLines: options.fileLines,
          });
          await postCommandOutput(ctx, invocation, renderInitResult(result), true);
        } catch (error) {
          await postCommandOutput(
            ctx,
            invocation,
            `[memory] init failed: ${errorLine(error)}`,
            true,
          );
        }
      },
    });
  });
}
```

- [ ] **Step 4: Add `initInstallText()` to `src/templates.ts`**

Rename `firstRunInstallText()` to `initInstallText()` and replace its body with the checklist only. The outcome line belongs to `renderInitResult()` so the command does not print two headings.

```ts
/**
 * One consolidated install checklist (E12; emitted after the first successful
 * `/memory-init`, E15). Required permission rule, protocol block, optional
 * options snippet, and the status-doctor pointer. Fixed prose + the existing
 * snippets only; no content channel.
 */
export function initInstallText(): string {
  return `Next steps:
1. Required — add the memory_write → ask rule to opencode.jsonc (without it, per-line approval fails open):
${permissionsSnippet()}
2. Paste this protocol block into root AGENTS.md (hand-owned, never auto-written):
${AGENTS_PROTOCOL_BLOCK}
3. Optional — paste the commented options into the same plugin entry:
${optionsSnippet()}
Verify the install anytime with /memory-status. The plugin never edits opencode.jsonc or AGENTS.md.`;
}
```

Then update the existing import/call sites so the tree stays type-clean before Task 3:

- `src/index.ts`: change the `firstRunInstallText` import and the `console.warn(firstRunInstallText())` call to `initInstallText`.
- `test/scaffold.test.ts`: change the import to `initInstallText`; in the existing `first_run_install_checklist` test, replace `firstRunInstallText()` with `initInstallText()` and replace `expect(text).toContain("scaffolded .opencode/memory/")` with `expect(text).toContain("Next steps:")`. In the setup tests, replace the `String(c[0]).includes("first run")` filters with `.includes("Next steps:")`. Task 3 rewrites this describe.

- [ ] **Step 5: Run the unit tests**

```bash
npx vitest run test/init.test.ts
npm run typecheck
```

Expected: PASS. If the `created` order differs from `MEMORY_FILES`, keep the implementation order (`INDEX.md` last) and assert the set instead of the exact array; the plan’s test should be written as a set if the implementation intentionally orders INDEX last.

- [ ] **Step 6: Commit the core**

```bash
git add src/init.ts src/templates.ts src/index.ts test/init.test.ts test/scaffold.test.ts
git commit -m "feat: add explicit memory initialization core"
```

---

## Task 2: Add `/memory-init` command tests and registration

**Files:**
- Modify: `test/init.test.ts`
- Modify: `src/index.ts` (registration only; full setup cleanup is Task 3)

- [ ] **Step 1: Add command-level tests**

Append to `test/init.test.ts`:

```ts
import type { Plugin } from "@opencode/plugin";
import {
  MEMORY_INIT_COMMAND_DESCRIPTION,
  MEMORY_INIT_COMMAND_NAME,
  MEMORY_INIT_USAGE,
  registerMemoryInit,
} from "../src/init.js";

interface AddedCommand {
  readonly name: string;
  readonly description: string;
  execute: (invocation: unknown) => Promise<void>;
}

function fakeInitContext(params: {
  readonly projectRoot: string;
  readonly synthetic?: (input: unknown) => Promise<unknown>;
}) {
  const added: AddedCommand[] = [];
  const syntheticCalls: unknown[] = [];
  const promptCalls: unknown[] = [];
  const ctx = {
    options: {},
    location: {
      directory: params.projectRoot,
      project: {
        id: "init-project",
        directory: params.projectRoot,
        canonical: params.projectRoot,
      },
    },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      remove: async () => undefined,
      scan: async () => ({ entries: [] }),
    },
    command: {
      transform: async (
        cb: (editor: { add: (definition: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (definition) => added.push(definition) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      synthetic: async (input: unknown) => {
        syntheticCalls.push(input);
        return params.synthetic ? params.synthetic(input) : undefined;
      },
      prompt: async (input: unknown) => {
        promptCalls.push(input);
        return undefined;
      },
    },
  };
  return {
    ctx: ctx as unknown as Plugin.Context,
    added,
    syntheticCalls,
    promptCalls,
  };
}

function invocationOf(text: string) {
  return {
    sessionID: "init-session",
    prompt: { text, files: [], agents: [], skills: [] },
    delivery: "steer",
  };
}

describe("/memory-init command", () => {
  it("registers with the exact name and description", async () => {
    const fake = fakeInitContext({ projectRoot: await tempProject() });
    const registration = await registerMemoryInit(fake.ctx);
    expect(fake.added).toHaveLength(1);
    expect(fake.added[0]!.name).toBe(MEMORY_INIT_COMMAND_NAME);
    expect(fake.added[0]!.description).toBe(MEMORY_INIT_COMMAND_DESCRIPTION);
    await registration.dispose();
  });

  it("creates the scaffold and posts the first-init checklist", async () => {
    const projectRoot = await tempProject();
    const fake = fakeInitContext({ projectRoot });
    await registerMemoryInit(fake.ctx);
    await fake.added[0]!.execute(invocationOf(""));

    expect(
      await isInitialized(join(projectRoot, ".opencode", "memory")),
    ).toBe(true);
    const initText = (fake.syntheticCalls[0] as { text: string }).text;
    expect(initText).toContain("[memory] initialized .opencode/memory");
    expect(initText).toContain("Next steps:");
    expect(fake.promptCalls).toEqual([]);
  });

  it("renders help and rejects unexpected arguments without creating files", async () => {
    const projectRoot = await tempProject();
    const fake = fakeInitContext({ projectRoot });
    await registerMemoryInit(fake.ctx);
    await fake.added[0]!.execute(invocationOf("--help"));
    expect((fake.syntheticCalls[0] as { text: string }).text).toContain(
      MEMORY_INIT_USAGE,
    );
    await fake.added[0]!.execute(invocationOf("extra"));
    expect((fake.syntheticCalls[1] as { text: string }).text).toContain(
      "unexpected argument",
    );
    expect(
      await isInitialized(join(projectRoot, ".opencode", "memory")),
    ).toBe(false);
  });

  it("falls back to the prompt when the synthetic post rejects", async () => {
    const projectRoot = await tempProject();
    const fake = fakeInitContext({
      projectRoot,
      synthetic: async () => {
        throw new Error("synthetic unavailable");
      },
    });
    await registerMemoryInit(fake.ctx);
    await fake.added[0]!.execute(invocationOf(""));
    expect(fake.promptCalls).toHaveLength(1);
    expect(String((fake.promptCalls[0] as { text: string }).text)).toContain(
      "[memory] initialized .opencode/memory",
    );
  });

  it("never throws when the root cannot be created", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memory-init-blocked-"));
    const root = join(parent, "not-a-directory");
    await writeFile(root, "x");
    const fake = fakeInitContext({ projectRoot: root });
    await registerMemoryInit(fake.ctx);
    await expect(
      fake.added[0]!.execute(invocationOf("")),
    ).resolves.toBeUndefined();
    expect((fake.syntheticCalls[0] as { text: string }).text).toContain(
      "initialization did not complete",
    );
  });
});
```

All imports for this block (`Plugin`, `mkdtemp`, `tmpdir`, `writeFile`, `join`) already exist in the file’s top import list; merge the new imports there rather than adding a second import statement mid-file.

- [ ] **Step 2: Register the command in `src/index.ts`**

Add the import:

```ts
import { registerMemoryInit } from "./init.js";
```

Register it before `/memory-review`:

```ts
// /memory-init: explicit, user-invoked scaffold. It is the only write path
// available before initialization and it creates INDEX.md last.
registrations.push(await registerMemoryInit(ctx));
```

Keep the rest of setup unchanged until Task 3.

- [ ] **Step 3: Run the tests**

```bash
npx vitest run test/init.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/init.ts src/index.ts test/init.test.ts
git commit -m "feat: register the memory-init command"
```

---

## Task 3: Stop setup scaffolding; guard hooks and the event loop; guard setup messages

**Files:**
- Modify: `src/index.ts`
- Modify: `test/scaffold.test.ts`
- Modify: `test/hooks.test.ts`
- Modify: `test/isolation.test.ts`

- [ ] **Step 1: Rewrite setup scaffolding tests in `test/scaffold.test.ts`**

Replace the `first_run_install_checklist` describe with `init_install_checklist` and add setup-silence tests. The file already imports `existsSync`; add `initInstallText` to the existing `../src/templates.js` import list and `MEMORY_INIT_COMMAND_DESCRIPTION` to a new `../src/init.js` import:

```ts
import { MEMORY_INIT_COMMAND_DESCRIPTION } from "../src/init.js";

describe("init_install_checklist", () => {
  it("is one checklist with all install actions", () => {
    const text = initInstallText();
    expect(text).toContain("Next steps:");
    expect(text).toContain("memory_write");
    expect(text).toContain('"effect": "ask"');
    expect(text).toContain(AGENTS_PROTOCOL_BLOCK);
    expect(text).toContain("indexLines");
    expect(text).toContain("snapshotThrottleMinutes");
    expect(text).toContain("/memory-status");
    expect(text).toContain("never edits");
    expect(text.split(permissionsSnippet()).length - 1).toBe(1);
    expect(text.split(AGENTS_PROTOCOL_BLOCK).length - 1).toBe(1);
    expect(text.split(optionsSnippet()).length - 1).toBe(1);
  });

  it("setup creates nothing and prints no memory message on a fresh project", async () => {
    resetInstallNudgesForTests();
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-no-scaffold-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const setup = plugin.setup as unknown as (
        ctx: unknown,
      ) => Promise<(() => Promise<void>) | void>;
      await setup(installCtx(projectRoot));
      expect(existsSync(join(projectRoot, ".opencode", "memory"))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("an initialized project keeps the unconditional permission warning", async () => {
    resetInstallNudgesForTests();
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-initialized-"));
    await preScaffold(projectRoot);
    await writeFile(
      join(projectRoot, "AGENTS.md"),
      "## Project memory (.opencode/memory)\n- call memory_recall before editing contracts\n",
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const setup = plugin.setup as unknown as (
        ctx: unknown,
      ) => Promise<(() => Promise<void>) | void>;
      await setup(installCtx(projectRoot));
      const permissionWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes("install the memory_write"),
      );
      expect(permissionWarnings).toHaveLength(1);
      expect(String(permissionWarnings[0]![0])).toContain(permissionsSnippet());
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("Next steps:")),
      ).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
```

Update `registers_memory_metrics_and_review_commands` (around line 214):

```ts
expect([...commands.keys()]).toEqual([
  "memory-init",
  "memory-review",
  "memory-forget",
  "memory-gc",
  "memory-metrics",
  "memory-status",
]);
expect(commands.get("memory-init")).toBe(MEMORY_INIT_COMMAND_DESCRIPTION);
```

Update `firstRunInstallText` imports to `initInstallText`.

Update `install_surface_P0_parity`: it currently asserts `src/index.ts` contains `HANDOFFS_DIR`, `ARCHIVE_DIR`, and `writeNewCapped`. After the move those assertions must read `const init = read("src/init.ts");` and check `init`. Keep the template/snippet assertions unchanged.

Inside `init_install_checklist`:
- keep the old “is one checklist with all install actions” test, renamed/rewritten as shown;
- delete the old “first run emits the consolidated checklist once and no separate log” test (setup no longer prints it; the new “setup creates nothing…” test covers the fresh project);
- rename “non-first-run keeps the unconditional permission warning” to “an initialized project keeps the unconditional permission warning” and assert the checklist is not printed by filtering for `"Next steps:"`.

Update the `agents_protocol_nudge` describe:
- “warns once when an initialized project lacks the block” keeps `preScaffold`.
- Replace “stays quiet on the first run even when AGENTS.md lacks the block” with “stays quiet on an uninitialized project”: fresh project, `setup`, assert no nudge.
- “stays quiet when AGENTS.md has the block or is absent” keeps `preScaffold` for both.

- [ ] **Step 2: Seed the scaffold in `test/hooks.test.ts`**

Replace the `beforeEach` body after creating `memoryRoot` with:

```ts
await mkdir(join(memoryRoot, "handoffs", "archive"), { recursive: true });
for (const [name, content] of Object.entries(getScaffoldFiles())) {
  await writeFile(join(memoryRoot, name), content, "utf8");
}
```

Change the one test that removes INDEX to test the empty-brief path without de-initializing:

```ts
// Remove activeContext only: INDEX stays present so the project remains
// initialized; an empty brief is still brief.empty.
await rm(join(memoryRoot, "activeContext.md"));
```

The test at “does not attach an over-cap or missing INDEX” may still remove INDEX; it only asserts that no files are attached, which remains true. Add a comment that removing INDEX also proves the plugin is inert.

- [ ] **Step 3: Seed INDEX in `test/isolation.test.ts`**

In the file-level `beforeEach` (around line 177, shared by the setup-wiring test and the rest of the file), add:

```ts
await writeFile(join(memoryRoot, "INDEX.md"), "# INDEX\n", "utf8");
```

Add `writeFile` to the existing `node:fs/promises` import list. This keeps the event-loop seam test dispatching idle/compaction events after the guard lands.

- [ ] **Step 4: Add the pre-init hook gate test**

Append to `test/hooks.test.ts`:

```ts
describe("initialization gate", () => {
  it("leaves every hook event untouched and bumps no counter before init", async () => {
    await rm(join(memoryRoot, "INDEX.md"));
    const store = new FakeStorage();
    const { hooks, toolHooks } = await setupHooks({}, store);

    const prompt = promptEvent("remember: deploy on Fridays");
    await runHook(hooks, "prompt", prompt);
    expect(prompt.prompt.files).toHaveLength(0);
    expect(prompt.prompt.text).toBe("remember: deploy on Fridays");

    const context = contextEvent([userMessage("hello")]);
    await runHook(hooks, "context", context);
    expect(context.system).toHaveLength(0);

    const compaction = contextEvent([userMessage("summarize")]);
    await runHook(hooks, "compaction", compaction);
    expect(compaction.system).toHaveLength(0);

    const failure = {
      status: "error",
      message: "boom",
      input: { command: "npm test" },
    };
    await toolHooks.get("execute.after")!(failure as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readTotals(store, PROJECT)).toEqual({});
    expect(
      await readFile(join(memoryRoot, "activeContext.md"), "utf8"),
    ).toBe(getScaffoldFiles()["activeContext.md"]);
  });

  it("re-inerts without a restart when INDEX.md is deleted", async () => {
    await writeMemory("INDEX.md", "- auth: login\n");
    const { hooks } = await setupHooks();
    const first = promptEvent("hello");
    await runHook(hooks, "prompt", first);
    expect(first.prompt.files).toHaveLength(1);

    await rm(join(memoryRoot, "INDEX.md"));
    const afterDelete = promptEvent("hello again");
    await runHook(hooks, "prompt", afterDelete);
    expect(afterDelete.prompt.files).toHaveLength(0);
    expect(afterDelete.prompt.text).toBe("hello again");
  });
});
```

For the event-loop guard, extend the existing `setup wiring: single controller + dispose()` test in `test/isolation.test.ts` with a second small test that removes `INDEX.md` before `plugin.setup`, emits one local `session.idle` event through the fake subscribe, waits one macrotask, and asserts `await handoffFiles()` is still empty and no metrics keys were written. Reuse that test’s fake context construction; do not duplicate the whole fake if a local helper can be extracted.

- [ ] **Step 5: Modify `src/index.ts`**

Remove `scaffoldMemoryDir()` and these imports: `access`, `mkdir`, `ARCHIVE_DIR`, `HANDOFFS_DIR`, `getScaffoldFiles`, `initInstallText`, `writeNewCapped`. Keep `readFile`, `join`, `permissionsSnippet`, `hasMemoryProtocolBlock`.

Add the guard import:

```ts
import { isInitialized, registerMemoryInit } from "./init.js";
```

At the top of each hook body, inside `try` and **before** `bump(...)`:

```ts
if (!(await isInitialized(memoryRootOf(ctx)))) return;
```

Add `memoryRootOf` to the existing `./command-context.js` import list. Use the same guard line in the `prompt`, `context`, `compaction`, and `execute.after` hooks.

Wrap the event-loop callback:

```ts
handleEvent: async (event) => {
  if (!(await isInitialized(memoryRoot))) return;
  await dispatchEvent(event, {
    vcs: ctx.vcs as unknown as VcsPort,
    storage: ledger,
    projectID,
    directory: projectDir,
    memoryRoot,
    fileLines: options.fileLines,
    log: logDiagnostic,
    bump,
  });
},
```

Replace the post-registration scaffold/message block with:

```ts
const projectRoot = projectRootOf(ctx);
const initialized = await isInitialized(memoryRootOf(ctx));

if (initialized) {
  // Unconditional loud warning: effective rules are unverifiable at setup
  // (no acting agent), so installed projects keep the spec §4.4 warning.
  try {
    console.warn(
      "[memory] install the memory_write → ask rule or per-line approval fails open:\n" +
        permissionsSnippet(),
    );
  } catch {
    // Logging must never break plugin load.
  }

  // Once-per-process nudge for a hand-owned AGENTS.md without the block.
  try {
    const agentsText = await readFile(
      join(projectRoot, "AGENTS.md"),
      "utf8",
    );
    if (!agentsProtocolNudgeLogged && !hasMemoryProtocolBlock(agentsText)) {
      agentsProtocolNudgeLogged = true;
      console.warn(
        "[memory] root AGENTS.md has no memory protocol block; the agent will not read memory. Paste the block printed by /memory-init (or in the README install section).",
      );
    }
  } catch {
    // Missing/unreadable AGENTS.md: nothing to check.
  }
}
```

- [ ] **Step 6: Run the affected suites**

```bash
npx vitest run test/scaffold.test.ts test/hooks.test.ts test/isolation.test.ts test/init.test.ts
npm run typecheck
```

Expected: PASS. If `hooks.test.ts` still reads `decisions.md` without writing it, the scaffold seed must be present; do not remove the seed.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/scaffold.test.ts test/hooks.test.ts test/isolation.test.ts
git commit -m "feat: gate setup, hooks, and events on explicit initialization"
```

---

## Task 4: Gate the four memory tools

**Files:**
- Modify: `src/tools.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Add the guard in `src/tools.ts`**

Import:

```ts
import { MEMORY_NOT_INITIALIZED, isInitialized } from "./init.js";
```

At the start of each of the four `execute` bodies:

```ts
if (!(await isInitialized(memoryRootOf(ctx)))) {
  return toolResult(MEMORY_NOT_INITIALIZED);
}
```

Keep the guard before `createMemoryRecallExecute` / `createMemoryApplyExecute` / `collectAndRender` / `createMemorySearchExecute`, so no read, write, or metric happens. The `memory_status` tool lives in `status-report.ts` and is intentionally **not** gated.

- [ ] **Step 2: Add the pre-init tool test**

Append to `test/tools.test.ts`:

```ts
import { MEMORY_NOT_INITIALIZED } from "../src/init.js";

describe("initialization gate", () => {
  it("returns one fixed message from every tool and writes no counter", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-tools-gate-"));
    await mkdir(join(projectRoot, ".opencode", "memory"), { recursive: true });
    const storage = new FakeStorage();
    const added: Array<{
      name: string;
      execute: (input: unknown, context: ApplyToolContext) => Promise<unknown>;
    }> = [];
    const fakeCtx = {
      options: {},
      location: {
        directory: projectRoot,
        project: {
          id: PROJECT,
          directory: projectRoot,
          canonical: projectRoot,
        },
      },
      storage,
      permission: new FakePermission(),
      tool: {
        transform: async (
          cb: (editor: { add: (tool: (typeof added)[number]) => void }) => void,
        ) => {
          cb({ add: (tool) => added.push(tool) });
          return { dispose: async () => undefined };
        },
      },
    };
    await registerMemoryTools(fakeCtx as never);

    const inputs: Record<string, unknown> = {
      memory_recall: { file: "INDEX.md" },
      memory_apply: { candidates: [] },
      memory_metrics: undefined,
      memory_search: { query: "anything" },
    };
    for (const tool of added) {
      await expect(
        tool.execute(inputs[tool.name], TOOL_CTX),
      ).resolves.toEqual({ content: MEMORY_NOT_INITIALIZED });
    }
    expect(storage.data.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run**

```bash
npx vitest run test/tools.test.ts test/init.test.ts
npm run typecheck
```

Expected: PASS. Existing registration tests already write `INDEX.md`; keep those seeds.

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: gate memory tools on explicit initialization"
```

---

## Task 5: Gate `/memory-review`, `/memory-forget`, `/memory-gc`, and `/memory-metrics`

**Files:**
- Modify: `src/review.ts`
- Modify: `src/forget-command.ts`
- Modify: `src/gc-command.ts`
- Modify: `src/metrics.ts`
- Modify: `test/review.test.ts`
- Modify: `test/lifecycle-commands.test.ts`
- Modify: `test/metrics.test.ts`

- [ ] **Step 1: Guard `/memory-review`**

In `src/review.ts`, import:

```ts
import { memoryRootOf, postCommandOutput } from "./command-context.js";
import { MEMORY_NOT_INITIALIZED, isInitialized } from "./init.js";
```

Change the executor signature from destructuring to the invocation, then guard before the `review.invoked` bump:

```ts
execute: async (invocation) => {
  const { sessionID, prompt, delivery } = invocation;
  if (!(await isInitialized(memoryRootOf(ctx)))) {
    await postCommandOutput(ctx, invocation, MEMORY_NOT_INITIALIZED, true);
    return;
  }
  const base = typeof prompt?.text === "string" ? prompt.text : "";
  // ... existing body unchanged
},
```

- [ ] **Step 2: Guard `/memory-forget` and `/memory-gc`**

In each command executor, after the `"help" in parsed` branch and before the `"error" in parsed` branch:

```ts
if (!(await isInitialized(memoryRootOf(ctx)))) {
  await postCommandOutput(ctx, invocation, MEMORY_NOT_INITIALIZED, true);
  return;
}
```

Imports: add `MEMORY_NOT_INITIALIZED, isInitialized` from `./init.js`. `memoryRootOf` and `postCommandOutput` are already imported in both files.

- [ ] **Step 3: Guard `/memory-metrics`**

In `src/metrics.ts`, import:

```ts
import { postCommandOutput } from "./command-context.js";
import { MEMORY_NOT_INITIALIZED, isInitialized } from "./init.js";
```

Use the file’s existing local `memoryRootOf(ctx)` (defined near `projectIDOf`). Change the executor to receive the invocation (it currently destructures):

```ts
execute: async (invocation) => {
  const { sessionID, prompt, delivery } = invocation;
  if (!(await isInitialized(memoryRootOf(ctx)))) {
    await postCommandOutput(ctx, invocation, MEMORY_NOT_INITIALIZED, true);
    return;
  }
  try {
    // existing body unchanged
  }
},
```

The guard must run before `metricsBumpOf`, reset handling, and `collectAndRender`. `postCommandOutput` is outside the existing try/catch; it never throws by contract.

- [ ] **Step 4: Seed initialized projects in the command tests**

`test/review.test.ts`: in `beforeEach`, after `mkdir(join(memoryRoot, "handoffs"))`, add the six templates:

```ts
for (const [name, content] of Object.entries(getScaffoldFiles())) {
  await writeFile(join(memoryRoot, name), content, "utf8");
}
```

Import `getScaffoldFiles` from `../src/templates.js`.

`test/lifecycle-commands.test.ts`: in `beforeEach`, after `mkdir(memory, { recursive: true })`, write:

```ts
await writeFile(join(memory, "INDEX.md"), "# INDEX\n", "utf8");
```

`test/metrics.test.ts`: create a per-test command project. Add `let cmdRoot: string;` near `healthRoots`, import `mkdirSync, mkdtempSync, writeFileSync` from `node:fs`, and change the global `beforeEach`:

```ts
beforeEach(() => {
  resetMetricsStateForTests();
  cmdRoot = trackRoot(mkdtempSync(join(tmpdir(), "memory-metrics-cmd-")));
  const memoryRoot = join(cmdRoot, ".opencode", "memory");
  mkdirSync(join(memoryRoot, "handoffs"), { recursive: true });
  writeFileSync(join(memoryRoot, "INDEX.md"), "# INDEX\n", "utf8");
});
```

In `fakeForMetricsCommand`, add an optional `projectRoot` parameter and replace the fixed `/tmp/metrics-cmd` with `params?.projectRoot ?? cmdRoot` in both `directory` and `project.canonical`. The command gate test then passes a fresh uninitialized root.

- [ ] **Step 5: Add gate tests**

`test/review.test.ts`:

First extend `fakeForCommand` so it always carries a live context and captures both delivery channels:

```ts
function fakeForCommand(metrics?: {
  storage: LedgerStorage;
  location: Record<string, unknown>;
}) {
  const added: AddedCommand[] = [];
  const prompted: unknown[] = [];
  const synthetics: unknown[] = [];
  const fakeCtx = {
    options: {},
    location: metrics?.location ?? {
      directory: projectRoot,
      project: {
        id: PROJECT,
        directory: projectRoot,
        canonical: projectRoot,
      },
    },
    storage: metrics?.storage ?? storage,
    command: {
      transform: async (
        cb: (editor: { add: (def: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (def) => added.push(def) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      synthetic: async (args: unknown) => {
        synthetics.push(args);
        return undefined;
      },
      prompt: async (args: unknown) => {
        prompted.push(args);
        return { sessionID: SESSION } as never;
      },
    },
  };
  return { added, prompted, synthetics, fakeCtx };
}
```

Then add:

```ts
it("returns the fixed pre-init message and bumps no counter", async () => {
  await rm(join(memoryRoot, "INDEX.md"));
  const { added, synthetics, fakeCtx } = fakeForCommand();
  await registerMemoryReview(fakeCtx);
  await added[0]!.execute({
    sessionID: SESSION,
    prompt: { text: "review", files: [], agents: [], skills: [] },
    delivery: "steer",
  });
  expect(String(synthetics[0])).toContain(MEMORY_NOT_INITIALIZED);
  expect(await getPending(storage, PROJECT)).toBe(0);
});
```

`PROJECT`, `SESSION`, `storage`, `memoryRoot`, and `rm` already exist in the file; add `MEMORY_NOT_INITIALIZED` from `../src/init.js`.

`test/lifecycle-commands.test.ts`:

```ts
describe("initialization gate", () => {
  it("keeps --help available and blocks forget/GC operations", async () => {
    await rm(join(memory, "INDEX.md"));
    await registerMemoryForget(ctx());
    await run("memory-forget", "--help");
    expect(posts.at(-1)).toContain("Usage: /memory-forget");

    await run("memory-forget", "INDEX.md --line 1");
    expect(posts.at(-1)).toBe(MEMORY_NOT_INITIALIZED);

    await registerMemoryGc(ctx());
    await run("memory-gc", "--keep 1");
    expect(posts.at(-1)).toBe(MEMORY_NOT_INITIALIZED);
  });
});
```

Import `MEMORY_NOT_INITIALIZED` from `../src/init.js`; the file’s existing `run(name, text)` helper is the executor.

`test/metrics.test.ts`:

```ts
it("returns the fixed pre-init message and resets nothing", async () => {
  const gateRoot = await mkdtemp(join(tmpdir(), "memory-metrics-gate-"));
  trackRoot(gateRoot);
  const { added, fakeCtx, synthetic, storage } = fakeForMetricsCommand({
    projectRoot: gateRoot,
  });
  await registerMetricsCommand(fakeCtx);
  await invokeOf(added[0]!)("reset confirm");
  expect(String(synthetic.mock.calls[0]![0])).toContain(MEMORY_NOT_INITIALIZED);
  expect(storage.data.size).toBe(0);
});
```

Import `MEMORY_NOT_INITIALIZED` from `../src/init.js`.

- [ ] **Step 6: Run**

```bash
npx vitest run test/review.test.ts test/lifecycle-commands.test.ts test/metrics.test.ts
npm run typecheck
```

Expected: PASS. If the metrics command still uses `/tmp/metrics-cmd`, fix the fake before adding gate coverage.

- [ ] **Step 7: Commit**

```bash
git add src/review.ts src/forget-command.ts src/gc-command.ts src/metrics.ts test/review.test.ts test/lifecycle-commands.test.ts test/metrics.test.ts
git commit -m "feat: gate lifecycle commands on explicit initialization"
```

---

## Task 6: Add the initialization state to the status report

**Files:**
- Modify: `src/status-report.ts`
- Modify: `test/status-report.test.ts`
- Modify: `test/acceptance-metrics.test.ts`

- [ ] **Step 1: Add the field and probe**

In `src/status-report.ts`, import `isInitialized` from `./init.js`.

Add to `StatusReport`:

```ts
readonly initialized: boolean;
```

In `collectStatus`, replace the `pathExists(join(deps.memoryRoot, "INDEX.md"))` promise with `isInitialized(deps.memoryRoot)` and add:

```ts
initialized: indexExists,
```

to the returned base. Keep `indexExists` for compatibility and rendering.

- [ ] **Step 2: Render the row and actions**

In `renderStatusReport`, insert the initialization row after the memory-directory row:

```ts
lines.push(
  `| memory directory | ${
    !report.memoryDirExists
      ? "missing — run /memory-init"
      : report.initialized
        ? "present"
        : "present (not initialized)"
  } |`,
);
lines.push(
  `| initialization | ${
    report.initialized ? "initialized" : "not initialized — run /memory-init"
  } |`,
);
```

In `deriveActions`, replace the old directory/INDEX branch with:

```ts
if (!report.initialized) {
  actions.push("run /memory-init to create .opencode/memory");
}
```

Delete the now-unreachable `else if (!report.indexExists)` branch. Keep the protocol, permission, trim, pending, and stale actions.

Change the capture-activity action condition:

```ts
if (
  report.initialized &&
  report.snapshotsWritten + report.compactionCaptures === 0
) {
  actions.push(
    "no idle/compaction captures observed yet — use the session normally, then re-check",
  );
}
```

Update `MEMORY_STATUS_DESCRIPTION` from “scaffold presence” to “initialization state”:

```ts
"Read-only install/health report for the memory plugin: initialization state, INDEX attachability, AGENTS.md protocol block, memory_write ask rule, optional memory-manager agent, capture activity, and next actions. Use for onboarding, troubleshooting, or after changing memory config. Writes nothing.";
```

- [ ] **Step 3: Update `test/status-report.test.ts`**

Healthy install:

```ts
expect(text).toContain("| initialization | initialized |");
expect(text).toContain("| memory directory | present |");
```

Missing install:

```ts
expect(text).toContain("| memory directory | missing — run /memory-init |");
expect(text).toContain(
  "| initialization | not initialized — run /memory-init |",
);
expect(report.initialized).toBe(false);
expect(report.actions).toContain(
  "run /memory-init to create .opencode/memory",
);
expect(report.actions).not.toContain(
  "restart/reload the plugin to scaffold .opencode/memory",
);
expect(report.actions).not.toContain(
  "no idle/compaction captures observed yet — use the session normally, then re-check",
);
```

Delete the old `expect.arrayContaining([... "restart/reload ...", ... "no idle/compaction captures ..."])` expectations from the missing-install test. Replace them with the assertions above; keep the protocol and permission assertions.

Missing INDEX after `seedHealthyInstall`:

```ts
expect(report.initialized).toBe(false);
expect(text).toContain("| memory directory | present (not initialized) |");
expect(text).toContain(
  "| initialization | not initialized — run /memory-init |",
);
expect(report.actions).toContain(
  "run /memory-init to create .opencode/memory",
);
```

Also assert the healthy report’s `initialized` is `true`. The existing deterministic test must still pass; `initialized` is derived from the filesystem and stable for one fixture.

- [ ] **Step 4: Seed the acceptance driver**

`test/acceptance-metrics.test.ts` starts with a fresh project and a real `plugin.setup`. Seed the full scaffold **before** setup so phase 1 has an INDEX to attach:

```ts
import { getScaffoldFiles } from "../src/templates.js";

// inside the driver, immediately after
// `const memoryRoot = join(projectRoot, MEMORY_DIR);`
await mkdir(join(memoryRoot, "handoffs", "archive"), { recursive: true });
for (const [name, content] of Object.entries(getScaffoldFiles())) {
  await writeFile(join(memoryRoot, name), content, "utf8");
}
```

The seed must run **before** `setupAccHarness(...)`: both harnesses register against the same project, and an uninitialized project would register commands but stay inert. Change the expected command list to:

```ts
expect([...harnessA.commands.keys()]).toEqual([
  "memory-init",
  "memory-review",
  "memory-forget",
  "memory-gc",
  "memory-metrics",
  "memory-status",
]);
```

Also change the phase-1 comment from “scaffolded INDEX” to “seeded INDEX”, and add `memory-init` to any assertion that enumerates registered commands.

- [ ] **Step 5: Run**

```bash
npx vitest run test/status-report.test.ts test/acceptance-metrics.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/status-report.ts test/status-report.test.ts test/acceptance-metrics.test.ts
git commit -m "feat: report initialization state in memory status"
```

---

## Task 7: Update the secondary command/agent surfaces

**Files:**
- Modify: `commands/memory-review.md`
- Modify: `agents/memory-manager.md`

- [ ] **Step 1: Add the preflight to the review stub**

Insert after the frontmatter:

```md
Preflight: if `.opencode/memory/INDEX.md` does not exist, stop immediately. Do not read memory files and do not produce a proposal; tell the user memory is not initialized and to run `/memory-init`.
```

- [ ] **Step 2: Add the same preflight to the manager agent**

Append to the body:

```md
Preflight: if `.opencode/memory/INDEX.md` does not exist, stop immediately. Do not read memory files and do not produce a proposal; report that memory is not initialized and that the user must run `/memory-init`.
```

Do **not** create `commands/memory-init.md`: a prompt-only file command cannot create the scaffold, and the plugin command is normative.

- [ ] **Step 3: Commit**

```bash
git add commands/memory-review.md agents/memory-manager.md
git commit -m "docs: add initialization preflight to review surfaces"
```

---

## Task 8: Documentation and ADR

**Files:**
- Create: `docs/adr/0011-explicit-memory-initialization.md`
- Modify: `docs/adr/0006-fixed-memory-location.md`
- Modify: `docs/design-spec-v2-production.md`
- Modify: `docs/user-stories.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/c4-03-components.md`
- Modify: `docs/c4-04-interfaces.md`
- Modify: `docs/c4-06-code.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write ADR-0011**

Create `docs/adr/0011-explicit-memory-initialization.md`:

```md
# ADR-0011 — Explicit memory initialization gate

**Status:** accepted. **Date:** 2026-11-02. **Supersedes:** the first-run scaffold contract in ADR-0006 and design-spec §§4.4/7 step 0.

## Context

The plugin used to create `.opencode/memory/` during `setup()`. That made the
plugin a writer before the user asked for a memory store, and it meant a
partial or unwanted scaffold could activate indexing, capture, and metrics.
A project should be inert until the user explicitly initializes it.

## Decision

- A project is initialized when `.opencode/memory/INDEX.md` exists as a
  regular file (`lstat().isFile()`). Existing installs activate with no
  migration; deleting INDEX deactivates the plugin without a restart.
- `setup()` never creates the memory directory, prints no first-run checklist,
  and stays silent for an uninitialized project. It keeps the existing
  `memory_write → ask` warning and AGENTS.md nudge only after initialization.
- `/memory-init` is the only init affordance. It is plugin-registered,
  user-invoked, accepts no arguments except `--help`, and never appears as a
  model-facing tool.
- `/memory-init` is idempotent repair: create only missing directories and
  templates, never overwrite, create `INDEX.md` last. If INDEX was absent and
  any earlier target failed, INDEX is not created and the project remains
  uninitialized.
- Before initialization, only `/memory-init`, `/memory-status`, and
  `memory_status` work. Every other memory tool/command returns
  `[memory] not initialized; run /memory-init to create .opencode/memory`.
  No hook injects, captures, snapshots, remembers, or bumps a metric.
- `/memory-status` always renders the full doctor, including an
  `initialization` row and a `/memory-init` next action.
- Pre-init `remember:` is silently ignored. The AGENTS.md protocol block is
  not installed until the first-init checklist is printed.

## Consequences

- Positive: no writes or model-visible injection before explicit consent; a
  partial scaffold cannot activate the plugin; existing installs need no
  migration; INDEX deletion is a safe deactivation.
- Negative: a new user must discover `/memory-init` from the README or
  `/memory-status`; a pre-init `remember:` is lost; deleting INDEX
  accidentally deactivates the plugin. These are accepted under the
  fully-inert choice.
- The five-option contract, metric vocabulary, storage keys, and permission
  behavior are unchanged. `src/files.ts` and `src/capture.ts` gain no gate;
  the gate lives at the production surfaces.

## Alternatives considered

- **Dedicated marker file or storage flag:** rejected because INDEX presence
  already distinguishes an installed store, and a marker adds a legacy
  adoption rule for every existing install.
- **Scaffold-only gate:** rejected because hooks could still create files and
  bump counters before the user asked for memory.
- **Lazy dynamic registration:** rejected because it depends on hook/tool
  registration being safe after setup and complicates cleanup; per-surface
  guards are simpler to test.
```

- [ ] **Step 2: Amend ADR-0006**

Replace the decision sentence:

```md
- The plugin registers **no** `references` entry and never edits `opencode.jsonc` or `AGENTS.md`; on
  first run it scaffolds memory files and emits the commented options snippet and protocol block for
  the user to paste.
```

with:

```md
- The plugin registers **no** `references` entry and never edits `opencode.jsonc` or `AGENTS.md`.
  Memory files are created only by the explicit `/memory-init` command (ADR-0011); the command emits
  the commented options snippet and protocol block for the user to paste.
```

- [ ] **Step 3: Update the design spec**

- §3 “On first run it scaffolds…” → `/memory-init` creates the directory; setup writes nothing.
- §4.4 permission prose: replace “first run prints it” and “scaffold + first-run print remain the channel” with “`/memory-init` prints it once” and “the first-init checklist remains the channel”; initialized projects keep the unconditional setup warning.
- §5.7 lifecycle: setup registers `/memory-init`; no scaffold; add the pre-init gate.
- §5.13 status: add the `initialization` row, `/memory-init` actions, and remove “scaffolds on first run”.
- §7 step 0: `/memory-init` creates six templates + `handoffs/` + `handoffs/archive/`, INDEX last, prints the checklist; note that every hook/tool except init/status is inert before INDEX.
- §8 roadmap: add E15 (explicit initialization gate) to the shipped tier; do not renumber existing entries.
- §10 open questions: remove any “first-run scaffold” language; note the TUI sidebar indicator as a separate future issue, not part of E15.

- [ ] **Step 4: Update user stories**

Replace US-04:

```md
- **US-04 Explicit `/memory-init` scaffolds memory (+ emits one install checklist).** As a user, I want to run `/memory-init` when I choose to create memory, and get six memory files + `handoffs/` plus **one consolidated checklist**: the mandatory `{action:"memory_write",resource:"*",effect:"ask"}` permissions snippet, the `AGENTS.md` protocol block, the commented ≤5-option snippet, and a `/memory-status` verification pointer — so setup never writes on my behalf and the plugin never edits my config or `AGENTS.md`. Acceptance: before init, setup/hooks/tools/commands create nothing and bump no metric; `/memory-init` is idempotent and creates `INDEX.md` last; one checklist contains each snippet/block exactly once; existing files are never overwritten; an existing `INDEX.md` activates without init (ADR-0006/0011, `c4-06`, design-spec §4.4).
```

In US-30, replace “scaffold presence” with “initialization state” and add the `/memory-init` next action.

- [ ] **Step 5: Update README**

- Quickstart step 3: “Run `/memory-init` in OpenCode. It creates `.opencode/memory/` with the six starter files and the `handoffs/` folders, then prints one consolidated install checklist…”. Add: “Until you run it, the plugin is inert: it does not scaffold, inject, capture, or write.”
- Step 5 verify: mention `initialization | initialized` and `initialization | not initialized — run /memory-init`.
- Daily use: add `/memory-init` to the command list, described as idempotent and repair-capable.
- Troubleshooting: add “The agent does not know the project / memory is missing” → run `/memory-status`; if it says not initialized, run `/memory-init`. Remove/replace any “restart to scaffold” wording.
- Uninstall: unchanged, but note that deleting `.opencode/memory/` is enough to deactivate; removing INDEX makes the plugin inert.
- Keep the existing note that the plugin never edits `opencode.jsonc` or `AGENTS.md`.

- [ ] **Step 6: Update CONTRIBUTING and C4 docs**

- `CONTRIBUTING.md`: change the `index.ts` layout comment to “entrypoint: setup, hook guards, cleanup”; add `src/init.ts  # explicit init gate + /memory-init`; change “It scaffolds memory files” to “`/memory-init` creates memory files”; update the manual P0 step to say hand-create the six files or run `/memory-init`.
- `docs/c4-03-components.md`: add an init row (`isInitialized`, `initializeMemory`, `/memory-init`) and update the status row to “initialization state”.
- `docs/c4-04-interfaces.md`: add the pre-init fixed message to the tool/command contract; update the status output line to include `initialization`.
- `docs/c4-06-code.md`: add `src/init.ts` to the tree; replace the first-run scaffold invariant with the `/memory-init` guarantee.

- [ ] **Step 7: Update CHANGELOG**

Add under `## Unreleased`:

```md
- Explicit initialization (E15, issue #20): the plugin no longer scaffolds `.opencode/memory/` during setup. A project is inert until `/memory-init` creates `INDEX.md` (last, after the five other templates and both handoff directories); the command is idempotent, never overwrites, and prints the consolidated install checklist on first init. Before initialization, only `/memory-init`, `/memory-status`, and `memory_status` work; every other memory tool/command returns one fixed message, and no hook injects, captures, snapshots, remembers, or bumps a metric. Existing installs with a regular `INDEX.md` activate automatically. `/memory-status` gains an `initialization` row and `/memory-init` actions. No new option, metric name, storage key, or model-facing tool.
```

- [ ] **Step 8: Check for stale first-run wording**

```bash
grep -rn -i -E "first run|first-run|scaffolds on first run|restart/reload the plugin to scaffold" README.md CONTRIBUTING.md CHANGELOG.md docs src test commands agents
```

Expected: only historical CHANGELOG entries and the design/plan documents may mention first run. Every normative/current sentence must describe `/memory-init`.

- [ ] **Step 9: Commit**

```bash
git add docs README.md CONTRIBUTING.md CHANGELOG.md commands agents
git commit -m "docs: document the explicit memory initialization gate"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the full suite**

```bash
npm run typecheck
npm test
```

Expected: both exit 0.

- [ ] **Step 2: Run the coverage suite**

```bash
npm run test:coverage
```

Expected: PASS. Check that `src/init.ts` is covered by `test/init.test.ts`; if coverage thresholds fail, add the missing branch (particularly the failure-before-INDEX path and the `lstat` catch).

- [ ] **Step 3: Run the stale-wording and scaffold checks**

```bash
grep -rn "scaffoldMemoryDir\|firstRunInstallText\|scaffolds on first run" src test docs README.md CONTRIBUTING.md CHANGELOG.md
```

Expected: no matches in `src`/`test`; historical docs may mention the old behavior only in an explicitly historical section.

- [ ] **Step 4: Review the diff**

```bash
git diff --stat main...HEAD
git diff main...HEAD -- src/init.ts src/index.ts src/status-report.ts
```

Confirm:

- setup never calls `mkdir`/`writeNewCapped`;
- every hook and the event-loop callback guard before `bump`;
- the four tools and four commands guard before reads/writes;
- `/memory-init` and `/memory-status`/`memory_status` remain available;
- no new config option, metric name, or storage key;
- `src/files.ts` and `src/capture.ts` are unchanged.

- [ ] **Step 5: Commit any final test/doc fixes**

```bash
git status --short
git add -A
git commit -m "test: cover the explicit initialization gate"
```

If there is nothing to commit, skip this step.

---

## Acceptance checklist

- [ ] A fresh project: setup, hooks, event loop, tools, and commands create no `.opencode/memory` files and bump no metrics before init.
- [ ] Before init, only `/memory-init`, `/memory-status`, and `memory_status` work; every other surface returns the fixed message.
- [ ] `/memory-init` creates the six templates plus `handoffs/` and `handoffs/archive/`, with `INDEX.md` last, and prints the consolidated checklist on first init.
- [ ] `/memory-init` is idempotent, never overwrites, and reports partial failures without publishing INDEX.
- [ ] An existing regular `INDEX.md` activates the plugin without running init.
- [ ] Deleting `INDEX.md` re-inerts the plugin without a restart.
- [ ] `/memory-status` and `memory_status` render the full report with an `initialization` row and `/memory-init` actions.
- [ ] Post-init behavior is unchanged.
- [ ] No new option, metric name, storage key, or model-facing tool.
- [ ] ADR-0011, spec, user stories, README, CONTRIBUTING, C4 docs, command/agent preflights, and CHANGELOG are updated; tests and doc gates pass.
