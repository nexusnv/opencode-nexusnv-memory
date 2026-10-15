import { describe, expect, it, beforeEach } from "vitest";
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
import { readCapped } from "../src/files.js";

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

  it("registers recall and apply via ctx.tool.transform", async () => {
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

  it("index.ts wires registerMemoryTools", () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, "..", "src", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/registerMemoryTools/);
  });
});
