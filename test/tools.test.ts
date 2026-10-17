import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Tool } from "@opencode/schema/tool";
import {
  MEMORY_APPLY_DESCRIPTION,
  MEMORY_RECALL_DESCRIPTION,
  createMemoryApplyExecute,
  createMemoryRecallExecute,
  registerMemoryTools,
  toolResult,
  type ApplyToolContext,
  type PermissionAsserter,
} from "../src/tools.js";
import {
  getPending,
  getRotated,
  incPending,
  setRotated,
  type LedgerStorage,
} from "../src/capture.js";
import {
  armKey,
  consumeArm,
  createBump,
  readArmed,
  readDays,
  readTotals,
  setArm,
} from "../src/metrics.js";
import { readCapped, withWriteLock } from "../src/files.js";

/**
 * Shipped-gate note (spec §4.4): `memory_apply` prompts per line only when
 * the user installs `{ "action": "memory_write", "resource": "*", "effect": "ask" }`.
 * Without it the request matches only the base star/star allow wildcard and
 * per-line approval gate fails open. The scaffold + first-run print remain the
 * channel; these tests prove the per-line `assert` calls that the rule gates.
 */

/** Persisted fake storage (same contract as test/ledger.test.ts). */
class FakeStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? this.data.get(key) : undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async scan(options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .sort();
    return { entries: keys.map((key) => ({ key, value: this.data.get(key) })) };
  }
}

type AssertCall = Parameters<PermissionAsserter["assert"]>[0];

/** Fake permission: records every assert; handler decides allow vs deny. */
class FakePermission implements PermissionAsserter {
  readonly calls: AssertCall[] = [];
  constructor(
    readonly verdict: (call: AssertCall) => Promise<void> = async () => undefined,
  ) {}
  async assert(input: AssertCall): Promise<void> {
    this.calls.push(input);
    await this.verdict(input);
  }
}

const PROJECT = "proj-tools";
const TOOL_CTX: ApplyToolContext = {
  sessionID: "sess-tools",
  agent: "primary",
  messageID: "msg-1",
  id: "call-1",
};

let root: string;
let storage: FakeStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-tools-"));
  storage = new FakeStorage();
});

async function writeMemory(file: string, text: string): Promise<void> {
  const abs = join(root, file);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
}

/** Fresh isolated memory root for blocks that must not see other writes. */
async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-tools-"));
}

/**
 * Drain every queued fire-and-forget metrics write before asserting on
 * counter totals: `bump` schedules its locked body at call time, so one
 * extra lock body rides the chain strictly after every pending bump of
 * this test process. This drains the bump WRITE bodies only — it does NOT
 * drain a piggyback prune whose removal phase enters the lock after its
 * scan has resolved (the prune's scan runs outside the lock, so a prune
 * scheduled from an earlier bump can still be mid-scan when this body
 * riders past it; see the two-step `settle()` in metrics/hooks tests for
 * the fuller drain pattern when prunes are in flight).
 */
async function flushMetrics(): Promise<void> {
  await withWriteLock(async () => undefined);
}

describe("tools", () => {
  it("recall_envelope_and_traversal_reject", async () => {
    await writeMemory("INDEX.md", "# INDEX-MARKER-UNIQUE- echoed\n- x: y\n");
    const execute = createMemoryRecallExecute({ memoryRoot: root });

    // G2 contract: the executor envelope is Tool.Result; the single
    // toolResult adapter proves it at compile time (assignable to
    // Tool.Result) and here at runtime.
    const contract: Tool.Result = toolResult("hello");
    expect(contract).toEqual({ content: "hello" });

    // Envelope + adapter identity: recall routes readCapped via toolResult.
    const out = await execute({ file: "INDEX.md" }, TOOL_CTX);
    expect(out).toEqual({ content: expect.stringContaining("INDEX-MARKER") });
    expect(out).toEqual(
      toolResult(await readCapped("INDEX.md", { memoryRoot: root })),
    );

    // Description doubles as the retrieval policy (spec §5.4, normative).
    expect(MEMORY_RECALL_DESCRIPTION).toContain(
      "Do not use for fresh implementation from current code alone.",
    );

    // Unknown/traversal paths throw; the tool never lists the filesystem.
    await expect(execute({ file: "random.md" }, TOOL_CTX)).rejects.toThrow();
    await expect(execute({ file: "../INDEX.md" }, TOOL_CTX)).rejects.toThrow();
    await expect(
      execute({ file: "handoffs/../../etc/passwd" }, TOOL_CTX),
    ).rejects.toThrow();
    await expect(
      execute({ file: "/absolute.md" }, TOOL_CTX),
    ).rejects.toThrow();

    // Archive paths are recallable on demand (never auto-injected elsewhere).
    await writeMemory("handoffs/archive/rotated-abc123.md", "archived-line");
    await expect(
      execute({ file: "handoffs/archive/rotated-abc123.md" }, TOOL_CTX),
    ).resolves.toEqual({ content: expect.stringContaining("archived-line") });
  });

  it("apply_per_line_assert_deny_propagates_and_empty_resets", async () => {
    // --- All-allowed path: per-line asserts, verbatim writes, reset. ---
    {
      const permission = new FakePermission();
      const execute = createMemoryApplyExecute({
        memoryRoot: root,
        projectID: PROJECT,
        storage,
        permission,
      });
      await incPending(storage, PROJECT, 5);
      await setRotated(storage, PROJECT, 2);

      const out = await execute(
        {
          candidates: [
            { file: "style.md", line: "- rule one source:user", source: "user" },
            {
              file: "issues.md",
              line: "- [todo] fix x (#1) source:user",
              source: "user",
            },
          ],
        },
        TOOL_CTX,
      );

      // One assert per candidate (untrusted lines cannot be bulk-approved).
      expect(permission.calls).toHaveLength(2);
      expect(permission.calls[0]).toEqual({
        sessionID: TOOL_CTX.sessionID,
        agent: TOOL_CTX.agent,
        action: "memory_write",
        resources: ["style.md"],
        metadata: { line: "- rule one source:user", source: "user" },
        source: {
          type: "tool",
          messageID: TOOL_CTX.messageID,
          id: TOOL_CTX.id,
        },
        save: [],
      });
      expect(permission.calls[1]?.resources).toEqual(["issues.md"]);

      // Verbatim durable writes through the choke point (never paraphrased).
      expect(await readFile(join(root, "style.md"), "utf8")).toBe(
        "- rule one source:user",
      );
      expect(await readFile(join(root, "issues.md"), "utf8")).toBe(
        "- [todo] fix x (#1) source:user",
      );

      // All-allowed output goes through the single adapter.
      expect(out).toEqual(toolResult(expect.any(String) as unknown as string));
      expect((out as { content: string }).content).toContain("2");

      // Completion resets pending → 0 and clears the rotated marker.
      expect(await getPending(storage, PROJECT)).toBe(0);
      expect(await getRotated(storage, PROJECT)).toBeUndefined();
    }

    // --- First deny: propagate immediately, remainder stays pending. ---
    {
      const denied = new Tool.Error({
        message: "User denied memory_write for style.md",
      });
      let n = 0;
      const permission = new FakePermission(async () => {
        n += 1;
        if (n === 1) throw denied;
      });
      const store = new FakeStorage();
      const denyRoot = await freshRoot();
      const execute = createMemoryApplyExecute({
        memoryRoot: denyRoot,
        projectID: PROJECT,
        storage: store,
        permission,
      });
      await incPending(store, PROJECT, 3);

      await expect(
        execute(
          {
            candidates: [
              { file: "style.md", line: "- blocked source:tool", source: "tool" },
              { file: "issues.md", line: "- never attempted", source: "tool" },
            ],
          },
          TOOL_CTX,
        ),
      ).rejects.toBe(denied);

      // No second assert, no second write, no summary, no counter reset.
      expect(permission.calls).toHaveLength(1);
      await expect(
        readFile(join(denyRoot, "issues.md"), "utf8"),
      ).rejects.toThrow();
      expect(await getPending(store, PROJECT)).toBe(3);
    }

    // --- Reviewed-nothing signal: no asserts, still resets counters. ---
    {
      const permission = new FakePermission();
      const store = new FakeStorage();
      const execute = createMemoryApplyExecute({
        memoryRoot: root,
        projectID: PROJECT,
        storage: store,
        permission,
      });
      await incPending(store, PROJECT, 4);
      await setRotated(store, PROJECT, 1);

      const out = await execute({ candidates: [] }, TOOL_CTX);
      expect(permission.calls).toHaveLength(0);
      expect(out).toEqual({ content: expect.any(String) });
      expect(await getPending(store, PROJECT)).toBe(0);
      expect(await getRotated(store, PROJECT)).toBeUndefined();
    }

    expect(MEMORY_APPLY_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it("apply_appends_same_file_candidates_in_order", async () => {
    const permission = new FakePermission();
    const execute = createMemoryApplyExecute({
      memoryRoot: root,
      projectID: PROJECT,
      storage,
      permission,
    });
    // Pre-seeded content (with trailing newline) must survive.
    await writeMemory("issues.md", "- seed line source:user\n");

    const out = await execute(
      {
        candidates: [
          { file: "issues.md", line: "- first line source:user", source: "user" },
          { file: "issues.md", line: "- second line source:user", source: "user" },
        ],
      },
      TOOL_CTX,
    );

    // Both lines present verbatim, in order — no clobbering.
    const text = await readFile(join(root, "issues.md"), "utf8");
    expect(text).toBe(
      "- seed line source:user\n- first line source:user\n- second line source:user",
    );
    expect(text.indexOf("first line")).toBeLessThan(
      text.indexOf("second line"),
    );
    expect(permission.calls).toHaveLength(2);
    expect(out).toEqual(toolResult(expect.any(String) as unknown as string));
    expect(await getPending(storage, PROJECT)).toBe(0);
  });

  it("apply_joins_without_trailing_newline", async () => {
    const permission = new FakePermission();
    const execute = createMemoryApplyExecute({
      memoryRoot: root,
      projectID: PROJECT,
      storage,
      permission,
    });
    await writeMemory("issues.md", "- seed line source:user");

    await execute(
      {
        candidates: [
          { file: "issues.md", line: "- appended source:user", source: "user" },
        ],
      },
      TOOL_CTX,
    );
    expect(await readFile(join(root, "issues.md"), "utf8")).toBe(
      "- seed line source:user\n- appended source:user",
    );
  });

  it("apply_rejects_disallowed_path_before_prompting", async () => {
    const permission = new FakePermission();
    const execute = createMemoryApplyExecute({
      memoryRoot: root,
      projectID: PROJECT,
      storage,
      permission,
    });
    await expect(
      execute(
        {
          candidates: [
            { file: "../INDEX.md", line: "- evil", source: "tool" },
          ],
        },
        TOOL_CTX,
      ),
    ).rejects.toThrow();
    // No approval prompt for a path outside the allowlist.
    expect(permission.calls).toHaveLength(0);
  });

  it("apply_rejects_overcap_batch_before_any_prompt_or_write", async () => {
    const permission = new FakePermission();
    const execute = createMemoryApplyExecute({
      memoryRoot: root,
      projectID: PROJECT,
      storage,
      permission,
    });
    // style.md cap is 60 lines; seed 59 so two more lines cannot all fit.
    const seed = Array.from({ length: 59 }, (_, i) => `- rule-${i + 1}`);
    await writeMemory("style.md", `${seed.join("\n")}\n`);
    await expect(
      execute(
        {
          candidates: [
            { file: "style.md", line: "- new-a", source: "user" },
            { file: "style.md", line: "- new-b", source: "user" },
          ],
        },
        TOOL_CTX,
      ),
    ).rejects.toThrow(/over its .* cap/);
    // No approval was requested and the file is untouched (no partial batch).
    expect(permission.calls).toHaveLength(0);
    const text = await readFile(join(root, "style.md"), "utf8");
    expect(text.split("\n").filter((l) => l.length > 0)).toHaveLength(59);
    expect(await getPending(storage, PROJECT)).toBe(0);
  });

  it("registers recall apply and metrics via ctx.tool.transform", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-tools-wire-"));
    const memoryDir = join(projectRoot, ".opencode", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, "INDEX.md"), "- wired: yes\n", "utf8");

    const added: Array<{
      name: string;
      description: string;
      input: { required?: unknown; additionalProperties?: unknown };
      execute: (input: unknown, context: ApplyToolContext) => Promise<unknown>;
    }> = [];
    const fakeCtx = {
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
          cb: (editor: {
            add: (tool: (typeof added)[number]) => void;
          }) => void,
        ) => {
          cb({ add: (tool) => added.push(tool) });
          return { dispose: async () => undefined };
        },
      },
    };

    const registration = await registerMemoryTools(fakeCtx as never);
    expect(added.map((t) => t.name).sort()).toEqual([
      "memory_apply",
      "memory_metrics",
      "memory_recall",
    ]);
    for (const tool of added) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input.required).toBeDefined();
      expect(tool.input.additionalProperties).toBe(false);
    }
    const recall = added.find((t) => t.name === "memory_recall")!;
    await expect(
      recall.execute({ file: "INDEX.md" }, TOOL_CTX),
    ).resolves.toEqual({ content: expect.stringContaining("wired: yes") });
    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("recall_bumps_file_or_handoff_and_error_keeps_thrown", async () => {
    // --- Six structural names classify to their literal counter. ---
    const bump = createBump(storage, PROJECT);
    const execute = createMemoryRecallExecute({ memoryRoot: root, bump });
    await writeMemory("style.md", "- style marker");
    await execute({ file: "style.md" }, TOOL_CTX);
    await writeMemory("decisions.md", "- decision marker");
    await execute({ file: "decisions.md" }, TOOL_CTX);

    // Any other successful read (handoffs/… paths) is the handoff aggregate.
    await writeMemory("handoffs/h-abc123.md", "- handoff marker");
    await execute({ file: "handoffs/h-abc123.md" }, TOOL_CTX);
    await flushMetrics();

    const totals = await readTotals(storage, PROJECT);
    // Literal names (templated names would be dropped fail-closed).
    expect(totals["recall.style.md"]).toBe(1);
    expect(totals["recall.decisions.md"]).toBe(1);
    expect(totals["recall.handoff"]).toBe(1);
    expect(totals["recall.error"]).toBeUndefined();
    // No arm wired → no hint conversion anywhere.
    expect(totals["hint.recall"]).toBeUndefined();

    // --- Failure: `recall.error` bumps AND the ORIGINAL error identity
    // propagates unchanged (metrics never mask a failure). readCapped's
    // internal throws are created fresh per call, so identity is proven
    // against a controlled throw object injected behind `readCapped`. ---
    const controlled = new Error("[memory] controlled recall failure");
    vi.resetModules();
    vi.doMock("../src/files.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/files.js")>();
      return {
        ...actual,
        readCapped: (): Promise<never> => Promise.reject(controlled),
      };
    });
    const tools = await import("../src/tools.js");
    const armConsumes: string[] = [];
    const failing = tools.createMemoryRecallExecute({
      memoryRoot: root,
      bump,
      arm: {
        consumeArm: async (sessionID: string) => {
          armConsumes.push(sessionID);
          return true;
        },
      },
    });
    await expect(
      failing({ file: "INDEX.md" }, TOOL_CTX),
    ).rejects.toBe(controlled);
    await flushMetrics();
    const errTotals = await readTotals(storage, PROJECT);
    expect(errTotals["recall.error"]).toBe(1);
    // The arm is consulted only AFTER a successful read — a failed recall
    // consumes nothing.
    expect(armConsumes).toEqual([]);
  });

  it("recall_consumes_arm_for_hint_conversion", async () => {
    // --- Armed session: the first successful recall bumps hint.recall and
    // consumes the arm flag exactly once. ---
    const bump = createBump(storage, PROJECT);
    await setArm(storage, PROJECT, TOOL_CTX.sessionID);
    const execute = createMemoryRecallExecute({
      memoryRoot: root,
      bump,
      arm: {
        consumeArm: (sessionID) => consumeArm(storage, PROJECT, sessionID),
      },
    });
    await writeMemory("INDEX.md", "- index marker");
    await execute({ file: "INDEX.md" }, TOOL_CTX);
    await flushMetrics();
    const totals = await readTotals(storage, PROJECT);
    expect(totals["recall.INDEX.md"]).toBe(1);
    expect(totals["hint.recall"]).toBe(1);
    // The flag is consumed: gone after use (cleared, not merely ignored).
    expect(
      await storage.get(armKey(PROJECT, TOOL_CTX.sessionID)),
    ).toBeUndefined();
    // A second recall in the same (now unarmed) session does not re-bump.
    await execute({ file: "INDEX.md" }, TOOL_CTX);
    await flushMetrics();
    const after = await readTotals(storage, PROJECT);
    expect(after["hint.recall"]).toBe(1);
    expect(after["recall.INDEX.md"]).toBe(2);

    // --- Unarmed session: the transport may still be consulted, but no
    // hint conversion fires and nothing is cleared. ---
    const unarmedStore = new FakeStorage();
    let unarmedReads = 0;
    const unarmed = createMemoryRecallExecute({
      memoryRoot: root,
      bump: createBump(unarmedStore, PROJECT),
      arm: {
        consumeArm: async () => {
          unarmedReads += 1;
          return false;
        },
      },
    });
    await unarmed({ file: "INDEX.md" }, TOOL_CTX);
    await flushMetrics();
    const unarmedTotals = await readTotals(unarmedStore, PROJECT);
    expect(unarmedReads).toBe(1);
    expect(unarmedTotals["hint.recall"]).toBeUndefined();
    expect(unarmedTotals["recall.INDEX.md"]).toBe(1);

    // --- Decision-4 order: recall counts first, then the one-shot atomic
    // consume, then the fire-and-forget conversion bump (the flag is
    // already gone when the count lands — a crash between the two replays
    // uncounted, never doubled). ---
    const order: string[] = [];
    const ordered = createMemoryRecallExecute({
      memoryRoot: root,
      bump: (name) => {
        order.push(`bump:${name}`);
      },
      arm: {
        consumeArm: async (sessionID) => {
          order.push(`consume:${sessionID}`);
          return true;
        },
      },
    });
    await ordered({ file: "INDEX.md" }, TOOL_CTX);
    order.push("resolved");
    expect(order).toEqual([
      "bump:recall.INDEX.md",
      `consume:${TOOL_CTX.sessionID}`,
      "bump:hint.recall",
      "resolved",
    ]);
  });

  it("recall_conversions_are_at_most_once_under_concurrent_recalls", async () => {
    // Two recalls racing the SAME armed flag: the conversion counter is
    // at-most-once — exactly one of the two consumes wins the locked
    // read+clear, and `hint.recall` counts 1, never 2 (the fix's contract).
    const bump = createBump(storage, PROJECT);
    await setArm(storage, PROJECT, TOOL_CTX.sessionID);
    await writeMemory("INDEX.md", "- index marker");
    const execute = createMemoryRecallExecute({
      memoryRoot: root,
      bump,
      arm: {
        consumeArm: (sessionID) => consumeArm(storage, PROJECT, sessionID),
      },
    });
    await Promise.all([
      execute({ file: "INDEX.md" }, TOOL_CTX),
      execute({ file: "INDEX.md" }, TOOL_CTX),
    ]);
    await flushMetrics();
    const totals = await readTotals(storage, PROJECT);
    expect(totals["recall.INDEX.md"]).toBe(2);
    expect(totals["hint.recall"]).toBe(1);
    expect(
      await storage.get(armKey(PROJECT, TOOL_CTX.sessionID)),
    ).toBeUndefined();
  });

  it("apply_bumps_batch_lines_denied_partial_and_reset", async () => {
    // (a) Successful batch: apply.batch=1 + apply.lines=n; the full
    // completion reset counts as `apply.reset` (§5.12: "on the completion
    // reset incl. candidates: []").
    {
      const bump = createBump(storage, PROJECT);
      const permission = new FakePermission();
      const execute = createMemoryApplyExecute({
        memoryRoot: root,
        projectID: PROJECT,
        storage,
        permission,
        bump,
      });
      await incPending(storage, PROJECT, 2);
      const out = await execute(
        {
          candidates: [
            { file: "style.md", line: "- rule a", source: "user" },
            { file: "issues.md", line: "- [todo] b", source: "user" },
          ],
        },
        TOOL_CTX,
      );
      expect((out as { content: string }).content).toContain("Applied 2");
      await flushMetrics();
      const totals = await readTotals(storage, PROJECT);
      expect(totals["apply.batch"]).toBe(1);
      expect(totals["apply.lines"]).toBe(2);
      expect(totals["apply.reset"]).toBe(1);
      expect(totals["apply.denied"]).toBeUndefined();
      expect(totals["apply.partialError"]).toBeUndefined();
    }

    // (b) First-line deny: denied=1, zero writes, NO reset (no completion
    // reached → no apply.reset, despite batch+lines counting the call).
    {
      const store = new FakeStorage();
      const bump = createBump(store, PROJECT);
      const denyRoot = await freshRoot();
      const denied = new Tool.Error({
        message: "User denied memory_write for style.md",
      });
      let n = 0;
      const permission = new FakePermission(async () => {
        n += 1;
        if (n === 1) throw denied;
      });
      const execute = createMemoryApplyExecute({
        memoryRoot: denyRoot,
        projectID: PROJECT,
        storage: store,
        permission,
        bump,
      });
      await incPending(store, PROJECT, 2);
      await expect(
        execute(
          {
            candidates: [
              { file: "style.md", line: "- blocked", source: "user" },
              { file: "issues.md", line: "- never attempted", source: "user" },
            ],
          },
          TOOL_CTX,
        ),
      ).rejects.toBe(denied);
      await flushMetrics();
      const totals = await readTotals(store, PROJECT);
      expect(totals["apply.batch"]).toBe(1);
      expect(totals["apply.lines"]).toBe(2);
      expect(totals["apply.denied"]).toBe(1);
      expect(totals["apply.partialError"]).toBeUndefined();
      expect(totals["apply.reset"]).toBeUndefined();
      // Zero writes; correctness counters untouched.
      await expect(
        readFile(join(denyRoot, "style.md"), "utf8"),
      ).rejects.toThrow();
      expect(await getPending(store, PROJECT)).toBe(2);
    }

    // (c) Mid-batch write failure AFTER ≥1 applied → apply.partialError.
    // Forcing the documented failure cause (concurrent grow between the
    // preflight projection and the per-line write): seed 58 lines so the
    // two-candidate batch passes preflight at 60, then hand-grow during the
    // second verdict so the second write overflows the 60-line cap.
    {
      const store = new FakeStorage();
      const bump = createBump(store, PROJECT);
      const pRoot = await freshRoot();
      const seed = Array.from({ length: 58 }, (_, i) => `- seed-${i + 1}`);
      await mkdir(pRoot, { recursive: true });
      await writeFile(join(pRoot, "style.md"), `${seed.join("\n")}\n`, "utf8");
      let n = 0;
      const permission = new FakePermission(async () => {
        n += 1;
        if (n === 2) {
          const current = await readFile(join(pRoot, "style.md"), "utf8");
          await writeFile(
            join(pRoot, "style.md"),
            `${current}\n- grown-1\n- grown-2\n- grown-3`,
            "utf8",
          );
        }
      });
      const execute = createMemoryApplyExecute({
        memoryRoot: pRoot,
        projectID: PROJECT,
        storage: store,
        permission,
        bump,
      });
      await incPending(store, PROJECT, 2);
      await expect(
        execute(
          {
            candidates: [
              { file: "style.md", line: "- new-a", source: "user" },
              { file: "style.md", line: "- new-b", source: "user" },
            ],
          },
          TOOL_CTX,
        ),
      ).rejects.toThrow(/failed at candidate 1 after 1 applied/);
      await flushMetrics();
      const totals = await readTotals(store, PROJECT);
      expect(totals["apply.batch"]).toBe(1);
      expect(totals["apply.lines"]).toBe(2);
      expect(totals["apply.partialError"]).toBe(1);
      expect(totals["apply.denied"]).toBeUndefined();
      // Mid-batch failure aborted before the completion reset.
      expect(totals["apply.reset"]).toBeUndefined();
      expect(await getPending(store, PROJECT)).toBe(2);
      // The durable prefix survives; the failed line must not re-land.
      const text = await readFile(join(pRoot, "style.md"), "utf8");
      expect(text).toContain("- new-a");
      expect(text).not.toContain("- new-b");
    }

    // (d) Reviewed-nothing signal `candidates: []`: still ONE call
    // (apply.batch) completing into the reset (apply.reset); no lines.
    {
      const store = new FakeStorage();
      const bump = createBump(store, PROJECT);
      const permission = new FakePermission();
      const execute = createMemoryApplyExecute({
        memoryRoot: root,
        projectID: PROJECT,
        storage: store,
        permission,
        bump,
      });
      await incPending(store, PROJECT, 4);
      await setRotated(store, PROJECT, 1);
      await execute({ candidates: [] }, TOOL_CTX);
      await flushMetrics();
      const totals = await readTotals(store, PROJECT);
      expect(totals["apply.batch"]).toBe(1);
      expect(totals["apply.reset"]).toBe(1);
      // A zero delta is dropped by the fail-closed guard — never fed it.
      expect(totals["apply.lines"]).toBeUndefined();
      expect(await getPending(store, PROJECT)).toBe(0);
      expect(await getRotated(store, PROJECT)).toBeUndefined();
    }

    // (e) Write failure with applied=0: batch+lines still count the call,
    // but partialError does NOT fire (§5.12 defines it as "after ≥1
    // applied") — nothing partial landed.
    {
      const store = new FakeStorage();
      const bump = createBump(store, PROJECT);
      const zRoot = await freshRoot();
      const seed = Array.from({ length: 58 }, (_, i) => `- seed-${i + 1}`);
      await mkdir(zRoot, { recursive: true });
      await writeFile(join(zRoot, "style.md"), `${seed.join("\n")}\n`, "utf8");
      const permission = new FakePermission(async () => {
        const current = await readFile(join(zRoot, "style.md"), "utf8");
        await writeFile(
          join(zRoot, "style.md"),
          `${current}\n- grown-1\n- grown-2\n- grown-3`,
          "utf8",
        );
      });
      const execute = createMemoryApplyExecute({
        memoryRoot: zRoot,
        projectID: PROJECT,
        storage: store,
        permission,
        bump,
      });
      await expect(
        execute(
          {
            candidates: [
              { file: "style.md", line: "- first fails instead", source: "user" },
            ],
          },
          TOOL_CTX,
        ),
      ).rejects.toThrow(/failed at candidate 0 after 0 applied/);
      await flushMetrics();
      const totals = await readTotals(store, PROJECT);
      expect(totals["apply.batch"]).toBe(1);
      expect(totals["apply.lines"]).toBe(1);
      expect(totals["apply.partialError"]).toBeUndefined();
      expect(totals["apply.reset"]).toBeUndefined();
    }
  });

  it("memory_metrics_tool_registered_and_envelope", async () => {
    const store = new FakeStorage();
    const bump = createBump(store, PROJECT);
    bump("hook.prompt");
    bump("recall.style.md");
    bump("apply.lines", 3);
    await incPending(store, PROJECT, 3);
    await flushMetrics();

    const projectRoot = await mkdtemp(join(tmpdir(), "memory-metrics-wire-"));
    const memoryDir = join(projectRoot, ".opencode", "memory");
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      join(memoryDir, "INDEX.md"),
      "- wired\n- two lines more\n- third line\n",
      "utf8",
    );

    const added: Array<{
      name: string;
      description: string;
      input: { required?: unknown; additionalProperties?: unknown };
      execute: (input: unknown, context: ApplyToolContext) => Promise<unknown>;
    }> = [];
    const fakeCtx = {
      location: {
        directory: projectRoot,
        project: {
          id: PROJECT,
          directory: projectRoot,
          canonical: projectRoot,
        },
      },
      storage: store,
      permission: new FakePermission(),
      options: { indexLines: 12 },
      tool: {
        transform: async (
          cb: (editor: {
            add: (tool: (typeof added)[number]) => void;
          }) => void,
        ) => {
          cb({ add: (tool) => added.push(tool) });
          return { dispose: async () => undefined };
        },
      },
    };

    await registerMemoryTools(fakeCtx as never);
    const metrics = added.find((t) => t.name === "memory_metrics")!;
    expect(metrics).toBeDefined();
    // §5.12 tool row: empty input schema — the tool takes no arguments.
    expect(metrics.input).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });

    // Read-only proof, deep: the executor must not add any storage key AND
    // must not mutate an existing key's value — so snapshot the whole
    // serialized store before and after and assert full equality (an
    // added-or-changed key would fail the compare).
    const dump = (): string =>
      JSON.stringify(
        [...store.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    const before = dump();
    const out = (await metrics.execute(undefined, TOOL_CTX)) as {
      content: string;
    };
    expect(dump()).toBe(before);

    // Envelope via the single toolResult adapter; the render reads the
    // live per-call deps (P22): primed counters surface in the table.
    expect(out).toEqual({
      content: expect.stringContaining("# [memory] metrics (local-only)"),
    });
    const table = out.content;
    expect(table).toContain("| hook.prompt | 1 |");
    expect(table).toContain("| recall.style.md | 1 |");
    // Health from the on-disk memory root, with the OPERATIVE cap from
    // parseMemoryOptions(ctx.options) (12, not the 30 default).
    expect(table).toContain("| INDEX.md | 3 | 12 |");
    expect(table).toContain("| pending | 3 |");
    expect(table).toMatch(/Since: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Budget-pressure row from the primed day bucket. The expected stamp is
    // derived from the data (readDays), never from a re-read clock: a UTC
    // midnight crossing between the prime bump and this assertion could
    // otherwise desync the two and flake.
    const stamp = Object.keys(await readDays(store, PROJECT))[0] ?? "";
    expect(stamp).toMatch(/^\d{8}$/);
    expect(table).toContain(`| ${stamp} | apply.lines | 3 |`);
  });

  it("index.ts wires registerMemoryTools", () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, "..", "src", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/registerMemoryTools/);
  });
});
