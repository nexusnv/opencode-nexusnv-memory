import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import {
  MEMORY_STATUS_COMMAND_DESCRIPTION,
  STATUS_FALLBACK_ASK,
  buildStatusReport,
  collectStatus,
  registerStatusCommand,
  registerStatusTool,
  renderStatusReport,
} from "../src/status-report.js";
import { totalKey } from "../src/metrics.js";
import type { LedgerStorage } from "../src/capture.js";

const PROJECT = "status-project";
const SESSION = "session-status";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

class FakeStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.data.get(key);
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
    let keys = [...this.data.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort();
    if (options.after !== undefined) {
      keys = keys.filter((key) => key > options.after!);
    }
    const page = keys.slice(0, options.limit ?? 100);
    return {
      entries: page.map((key) => ({ key, value: this.data.get(key) })),
      next:
        page.length > 0 && keys.length > page.length
          ? page[page.length - 1]
          : undefined,
    };
  }
}

class ThrowingStorage extends FakeStorage {
  override async get(_key: string): Promise<unknown> {
    throw new Error("storage down");
  }
}

interface AddedCommand {
  name: string;
  description?: string;
  execute: (input: {
    sessionID: string;
    prompt?: {
      text?: string;
      files?: unknown[];
      agents?: unknown[];
      skills?: unknown[];
    };
    delivery?: string;
  }) => Promise<void>;
}

interface AddedTool {
  name: string;
  description: string;
  input: { required: readonly string[]; additionalProperties: boolean };
  execute: (input: unknown) => Promise<{ content: string }>;
}

function fakeCtx(params: {
  projectRoot: string;
  storage?: LedgerStorage;
  version?: string;
  synthetic?: (input: unknown) => Promise<unknown>;
  prompt?: (input: unknown) => Promise<unknown>;
  agentList?: () => Promise<unknown>;
}) {
  const commands: AddedCommand[] = [];
  const tools: AddedTool[] = [];
  const synthetic = vi.fn(params.synthetic ?? (async () => undefined));
  const prompt = vi.fn(params.prompt ?? (async () => undefined));
  const storage = params.storage ?? new FakeStorage();
  const ctx = {
    options: {},
    location: {
      directory: params.projectRoot,
      project: {
        id: PROJECT,
        directory: params.projectRoot,
        canonical: params.projectRoot,
      },
    },
    app: {
      name: "opencode",
      version: params.version ?? "2.0.29",
      channel: "stable",
    },
    agent: {
      list: async () =>
        params.agentList
          ? params.agentList()
          : {
              location: {},
              data: [{ id: "memory-manager", name: "memory-manager" }],
            },
    },
    storage,
    command: {
      transform: async (
        cb: (editor: { add: (def: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (def) => commands.push(def) });
        return { dispose: async () => undefined };
      },
    },
    tool: {
      transform: async (
        cb: (editor: { add: (tool: AddedTool) => void }) => void,
      ) => {
        cb({ add: (tool) => tools.push(tool) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      synthetic: (input: unknown) => synthetic(input),
      prompt: (input: unknown) => prompt(input),
    },
  };
  return {
    ctx: ctx as unknown as Plugin.Context,
    commands,
    tools,
    synthetic,
    prompt,
    storage,
  };
}

async function seedProject(projectRoot: string): Promise<string> {
  const memoryRoot = join(projectRoot, ".opencode", "memory");
  await mkdir(join(memoryRoot, "handoffs", "archive"), { recursive: true });
  await writeFile(join(memoryRoot, "INDEX.md"), "# INDEX\n- activeContext: map\n");
  await writeFile(
    join(memoryRoot, "activeContext.md"),
    "# Active context\n- none\n",
  );
  await writeFile(join(memoryRoot, "decisions.md"), "# Decisions\n");
  await writeFile(join(memoryRoot, "architecture.md"), "# Architecture\n");
  await writeFile(join(memoryRoot, "style.md"), "# Style\n");
  await writeFile(join(memoryRoot, "issues.md"), "# Issues\n");
  return memoryRoot;
}

async function seedHealthyInstall(
  projectRoot: string,
  home: string,
): Promise<void> {
  await seedProject(projectRoot);
  await writeFile(
    join(projectRoot, "AGENTS.md"),
    "## Project memory (.opencode/memory)\n- call memory_recall\n",
  );
  await writeFile(
    join(projectRoot, "opencode.jsonc"),
    '{ "permissions": [{ "action": "memory_write", "resource": "*", "effect": "ask" }] }',
  );
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
}

async function newProject(): Promise<{ projectRoot: string; home: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "memory-status-"));
  const home = await mkdtemp(join(tmpdir(), "memory-status-home-"));
  tempRoots.push(projectRoot, home);
  return { projectRoot, home };
}

describe("collectStatus + renderStatusReport", () => {
  it("renders a healthy install with no next actions", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const storage = new FakeStorage();
    await storage.set(totalKey(PROJECT, "snapshot.written"), 1);

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

    expect(text).toContain("# [memory] status (local-only)");
    expect(text).toContain(
      "Budgets: INDEX ≤ 30 lines, files ≤ 60, injected ≤ 120",
    );
    expect(text).toContain("| memory directory | present |");
    expect(text).toContain("| INDEX.md | 2/30 lines — within cap");
    expect(text).toContain("| AGENTS.md protocol block | present |");
    expect(text).toContain(
      "| memory_write -> ask rule | declared in opencode.jsonc |",
    );
    expect(text).toContain("| memory-manager agent | present |");
    expect(text).toContain(
      "| idle/compaction capture | 1 snapshot(s), 0 compaction capture(s) |",
    );
    expect(report.actions).toEqual(["(none — memory is healthy)"]);
    expect(text).toContain("(none — memory is healthy)");
  });

  it("flags a missing install and suggests the install steps", async () => {
    const { projectRoot, home } = await newProject();
    const report = await collectStatus({
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage: new FakeStorage(),
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
    });
    const text = renderStatusReport(report);

    expect(text).toContain("| memory directory | missing");
    expect(text).toContain("| AGENTS.md protocol block | no AGENTS.md found |");
    expect(text).toContain(
      "| memory_write -> ask rule | not found in readable configs (advisory) |",
    );
    expect(text).toContain("| memory-manager agent | unknown");
    expect(report.actions).toEqual(
      expect.arrayContaining([
        "restart/reload the plugin to scaffold .opencode/memory",
        "install the AGENTS.md protocol block (README install)",
        "declare the memory_write -> ask permission rule (README install; effective rules are unverifiable here)",
        "no idle/compaction captures observed yet — run the README deploy check",
      ]),
    );
  });

  it("flags over-cap INDEX and files with actionable trims", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const memoryRoot = join(projectRoot, ".opencode", "memory");
    await writeFile(
      join(memoryRoot, "INDEX.md"),
      Array.from({ length: 31 }, (_, i) => `index-${i + 1}`).join("\n"),
    );
    await writeFile(
      join(memoryRoot, "style.md"),
      Array.from({ length: 61 }, (_, i) => `style-${i + 1}`).join("\n"),
    );
    const storage = new FakeStorage();
    await storage.set(totalKey(PROJECT, "snapshot.written"), 1);

    const report = await collectStatus({
      memoryRoot,
      projectRoot,
      home,
      storage,
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
      version: "2.0.29",
      agentNames: ["memory-manager"],
    });
    const text = renderStatusReport(report);

    expect(text).toContain(
      "| INDEX.md | 31/30 lines — over cap, not attached |",
    );
    expect(text).toContain("| style.md | 61 | 60 | over |");
    expect(report.actions).toEqual([
      "trim INDEX.md (31/30 lines) — not attached until within cap",
      "trim style.md (61/60 lines)",
    ]);
  });

  it("finds the rule in the global config and displays a short path", async () => {
    const { projectRoot, home } = await newProject();
    await seedProject(projectRoot);
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(
      join(home, ".config", "opencode", "opencode.jsonc"),
      '{ "permissions": [{ "action": "memory_write", "effect": "ask" }] }',
    );
    const report = await collectStatus({
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage: new FakeStorage(),
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
      version: "2.0.29",
      agentNames: ["memory-manager"],
    });
    expect(report.permission).toBe("declared");
    expect(report.permissionEvidence).toEqual([
      "~/.config/opencode/opencode.jsonc",
    ]);
  });

  it("does not mistake a bare memory_write mention for the ask rule", async () => {
    const { projectRoot, home } = await newProject();
    await seedProject(projectRoot);
    await writeFile(
      join(projectRoot, "opencode.jsonc"),
      '{ "permissions": [{ "action": "memory_write", "effect": "allow" }] }',
    );
    const report = await collectStatus({
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage: new FakeStorage(),
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
    });
    expect(report.permission).toBe("not-found");
  });

  it("reports capture failures and unsupported versions", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const storage = new FakeStorage();
    await storage.set(totalKey(PROJECT, "snapshot.failed"), 2);
    await storage.set(totalKey(PROJECT, "compactionCapture.failed"), 1);

    const report = await collectStatus({
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage,
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
      version: "2.1.0",
      agentNames: ["memory-manager"],
    });
    const text = renderStatusReport(report);
    expect(text).toContain("OpenCode: 2.1.0 (outside supported 2.0.x)");
    expect(text).toContain("| snapshot failures | 2 |");
    expect(text).toContain("| compaction failures | 1 |");
    expect(report.actions).toContain(
      "upgrade or pin OpenCode to the supported 2.0.x range (running 2.1.0)",
    );
  });

  it("is deterministic and never writes storage", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const storage = new FakeStorage();
    await storage.set(totalKey(PROJECT, "snapshot.written"), 1);
    const deps = {
      memoryRoot: join(projectRoot, ".opencode", "memory"),
      projectRoot,
      home,
      storage,
      projectID: PROJECT,
      caps: { indexLines: 30, fileLines: 60, injectBudgetLines: 120 },
      version: "2.0.29",
      agentNames: ["memory-manager"],
    } as const;
    const before = new Map(storage.data);

    const first = await collectStatus(deps);
    const second = await collectStatus(deps);
    expect(second).toEqual(first);
    expect(renderStatusReport(second)).toBe(renderStatusReport(first));
    expect(storage.data).toEqual(before);
  });
});

describe("status command + tool", () => {
  it("posts the report once through synthetic and never calls the fallback", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const fake = fakeCtx({ projectRoot });
    const registration = await registerStatusCommand(fake.ctx);
    expect(fake.commands.map((c) => c.name)).toEqual(["memory-status"]);
    expect(fake.commands[0]!.description).toBe(
      MEMORY_STATUS_COMMAND_DESCRIPTION,
    );

    await fake.commands[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "", files: [], agents: [], skills: [] },
      delivery: "steer",
    });

    expect(fake.synthetic).toHaveBeenCalledTimes(1);
    const posted = fake.synthetic.mock.calls[0]![0] as {
      sessionID: string;
      text: string;
    };
    expect(posted.sessionID).toBe(SESSION);
    expect(posted.text).toContain("# [memory] status (local-only)");
    expect(fake.prompt).not.toHaveBeenCalled();
    await registration.dispose();
  });

  it("falls back to the §5.5 prompt when the synthetic post rejects", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const fake = fakeCtx({
      projectRoot,
      synthetic: async () => {
        throw new Error("synthetic unavailable");
      },
    });
    await registerStatusCommand(fake.ctx);
    await fake.commands[0]!.execute({
      sessionID: SESSION,
      prompt: { text: "", files: [], agents: [], skills: [] },
      delivery: "steer",
    });

    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect((fake.prompt.mock.calls[0]![0] as { text: string }).text).toBe(
      STATUS_FALLBACK_ASK,
    );
  });

  it("never throws when the report cannot be collected", async () => {
    const { projectRoot } = await newProject();
    const fake = fakeCtx({
      projectRoot,
      storage: new ThrowingStorage(),
    });
    await registerStatusCommand(fake.ctx);
    await expect(
      fake.commands[0]!.execute({
        sessionID: SESSION,
        prompt: { text: "", files: [], agents: [], skills: [] },
        delivery: "steer",
      }),
    ).resolves.toBeUndefined();
    expect(fake.synthetic).not.toHaveBeenCalled();
    expect(fake.prompt).not.toHaveBeenCalled();
  });

  it("returns the report through the tool envelope", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const fake = fakeCtx({ projectRoot });
    await registerStatusTool(fake.ctx);
    expect(fake.tools.map((t) => t.name)).toEqual(["memory_status"]);
    expect(fake.tools[0]!.input.required).toEqual([]);
    expect(fake.tools[0]!.input.additionalProperties).toBe(false);

    const out = await fake.tools[0]!.execute({});
    expect(out).toEqual({
      content: expect.stringContaining("# [memory] status (local-only)"),
    });
  });

  it("degrades an unavailable agent lookup to unknown, not a throw", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const fake = fakeCtx({
      projectRoot,
      agentList: async () => {
        throw new Error("agent registry unavailable");
      },
    });
    await registerStatusTool(fake.ctx);
    const out = await fake.tools[0]!.execute({});
    expect(out.content).toContain("| memory-manager agent | unknown");
  });

  it("exposes buildStatusReport with the live ctx deps", async () => {
    const { projectRoot, home } = await newProject();
    await seedHealthyInstall(projectRoot, home);
    const fake = fakeCtx({ projectRoot });
    const report = await buildStatusReport(fake.ctx);
    expect(report.health.files).toHaveLength(6);
    expect(report.memoryDirExists).toBe(true);
    expect(report.agent).toBe("present");
  });
});
