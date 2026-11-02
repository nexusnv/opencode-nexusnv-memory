import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import {
  MEMORY_INIT_COMMAND_DESCRIPTION,
  MEMORY_INIT_COMMAND_NAME,
  MEMORY_INIT_USAGE,
  initializeMemory,
  isInitialized,
  registerMemoryInit,
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
    await expect(
      readFile(join(root, "handoffs", "archive"), "utf8"),
    ).rejects.toThrow();
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
    expect(await readFile(join(root, "decisions.md"), "utf8")).toBe(
      "- keep me\n",
    );
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
    expect(
      result.failures.some((f) => f.startsWith("activeContext.md:")),
    ).toBe(true);
    expect(await isInitialized(root)).toBe(false);
  });

  it("warns that a recreated INDEX is the default map when other files survived", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "decisions.md"), "- survive\n");

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(true);
    expect(result.lostMapWarning).toBe(true);
    expect(renderInitResult(result)).toContain(
      "warning: INDEX.md was missing while other memory files were present",
    );
    expect(await readFile(join(root, "decisions.md"), "utf8")).toBe(
      "- survive\n",
    );
  });

  it("keeps reporting an existing INDEX when a repair target fails", async () => {
    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "INDEX.md"), "# existing\n");
    await mkdir(join(root, "activeContext.md"));

    const result = await initializeMemory({ memoryRoot: root });

    expect(result.firstInit).toBe(false);
    expect(result.initialized).toBe(true);
    expect(result.present).toContain("INDEX.md");
    expect(
      result.failures.some((failure) => failure.startsWith("activeContext.md:")),
    ).toBe(true);
    expect(renderInitResult(result)).toContain(
      "memory is initialized, but repair did not complete",
    );
  });

  it("is safe when two init calls race", async () => {
    const root = await tempRoot();
    const [first, second] = await Promise.all([
      initializeMemory({ memoryRoot: root }),
      initializeMemory({ memoryRoot: root }),
    ]);
    // The in-process init mutex makes the second call enter after the first
    // publishes INDEX. Without it both would observe an absent INDEX.
    expect(first.firstInit).toBe(true);
    expect(second.firstInit).toBe(false);
    expect(first.initialized).toBe(true);
    expect(second.initialized).toBe(true);
    expect(await isInitialized(root)).toBe(true);
    expect([...first.created, ...second.created].sort()).toEqual(
      [...MEMORY_FILES].sort(),
    );
    // Exactly one call published INDEX, so exactly one prints the first-init
    // checklist; neither may claim a lost map it did not observe at entry.
    const texts = [renderInitResult(first), renderInitResult(second)];
    expect(texts.filter((text) => text.includes("Next steps:"))).toHaveLength(
      1,
    );
    expect(first.lostMapWarning).toBe(false);
    expect(second.lostMapWarning).toBe(false);
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
    expect(text).toContain(
      "[memory] memory already initialized; repair complete.",
    );
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

    expect(await isInitialized(join(projectRoot, ".opencode", "memory"))).toBe(
      true,
    );
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
    expect(await isInitialized(join(projectRoot, ".opencode", "memory"))).toBe(
      false,
    );
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
