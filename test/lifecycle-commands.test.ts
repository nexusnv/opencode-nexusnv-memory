import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { registerMemoryForget } from "../src/forget-command.js";
import { registerMemoryGc } from "../src/gc-command.js";

let root: string;
let memory: string;
let store: Map<string, unknown>;
let permissionCalls: number;
let permissionDeny: boolean;
let syntheticFails: boolean;
let promptFails: boolean;
let posts: string[];
let prompts: string[];
let definitions: Array<{
  name: string;
  execute: (input: unknown) => Promise<void>;
}>;

class FakeStorage {
  async get(key: string): Promise<unknown> {
    return store.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    store.set(key, value);
  }
  async remove(key: string): Promise<void> {
    store.delete(key);
  }
  async scan(): Promise<unknown[]> {
    return [];
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-cmd-"));
  memory = join(root, ".opencode", "memory");
  await mkdir(memory, { recursive: true });
  store = new Map();
  permissionCalls = 0;
  permissionDeny = false;
  syntheticFails = false;
  promptFails = false;
  posts = [];
  prompts = [];
  definitions = [];
});

function ctx(): Plugin.Context {
  const storage = new FakeStorage();
  return {
    options: {},
    location: {
      directory: root,
      project: { id: "proj", canonical: root },
    },
    storage,
    permission: {
      assert: async () => {
        permissionCalls += 1;
        if (permissionDeny) throw new Error("denied");
      },
    },
    session: {
      synthetic: async ({ text }: { text: string }) => {
        if (syntheticFails) throw new Error("synthetic unavailable");
        posts.push(text);
      },
      prompt: async ({ text }: { text: string }) => {
        if (promptFails) throw new Error("prompt unavailable");
        prompts.push(text);
        return undefined;
      },
    },
    command: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({
          add: (definition: {
            name: string;
            execute: (input: unknown) => Promise<void>;
          }) => definitions.push(definition),
        });
        return { dispose: async () => undefined };
      },
    },
  } as unknown as Plugin.Context;
}

async function run(name: string, text: string): Promise<void> {
  const definition = definitions.find((item) => item.name === name)!;
  await definition.execute({
    sessionID: "session-abcdef123456",
    prompt: { text },
    delivery: "none",
  });
}

describe("/memory-forget", () => {
  it("dry-runs by default and never writes", async () => {
    await writeFile(join(memory, "activeContext.md"), "# Active\n- keep\n");
    await registerMemoryForget(ctx());
    await run("memory-forget", "activeContext.md --line 2");
    expect(posts.join("\n")).toContain("forget dry-run");
    expect(posts.join("\n")).toContain("--confirm");
    expect(await readFile(join(memory, "activeContext.md"), "utf8")).toBe(
      "# Active\n- keep\n",
    );
  });

  it("falls back to a prompt when synthetic delivery is unavailable", async () => {
    await writeFile(join(memory, "activeContext.md"), "# Active\n- keep\n");
    syntheticFails = true;
    await registerMemoryForget(ctx());
    await run("memory-forget", "activeContext.md --line 2");
    expect(prompts.join("\n")).toContain("forget dry-run");
  });

  it("does not report operation failure when a completed forget cannot be delivered", async () => {
    await writeFile(join(memory, "style.md"), "- keep\n- drop\n");
    syntheticFails = true;
    promptFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await registerMemoryForget(ctx());
      await run("memory-forget", "style.md --line 2 --confirm");
      expect(await readFile(join(memory, "style.md"), "utf8")).toBe("- keep\n");
      const logged = warn.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
      expect(logged).toContain(
        "forget completed but its result could not be delivered",
      );
      expect(logged).not.toContain("forget failed");
      expect(posts.join("\n")).not.toContain("forget failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("confirms per unit, archives, writes, and sets the status notice", async () => {
    await writeFile(join(memory, "style.md"), "- keep\n- drop\n");
    await registerMemoryForget(ctx());
    await run("memory-forget", "style.md --line 2 --confirm");
    expect(permissionCalls).toBe(1);
    expect(await readFile(join(memory, "style.md"), "utf8")).toBe("- keep\n");
    const notice = store.get("proj/notice.forgotten");
    expect(notice).toBe(1);
    expect(posts.join("\n")).toContain("forget applied");
  });

  it("does not write when permission is denied", async () => {
    await writeFile(join(memory, "style.md"), "- drop\n");
    permissionDeny = true;
    await registerMemoryForget(ctx());
    await run("memory-forget", "style.md --line 1 --confirm");
    expect(await readFile(join(memory, "style.md"), "utf8")).toBe("- drop\n");
    expect(posts.join("\n")).toContain("forget failed");
  });

  it("rejects decisions.md with an append-only explanation", async () => {
    await writeFile(join(memory, "decisions.md"), "- d\n");
    await registerMemoryForget(ctx());
    await run("memory-forget", "decisions.md --all --confirm");
    expect(posts.join("\n")).toMatch(/append-only/);
    expect(await readFile(join(memory, "decisions.md"), "utf8")).toBe("- d\n");
  });
});

describe("/memory-gc", () => {
  it("dry-runs by default and leaves handoffs in place", async () => {
    await mkdir(join(memory, "handoffs"), { recursive: true });
    await writeFile(
      join(memory, "handoffs", "2026-01-01-000000-abcdef.md"),
      "old",
    );
    await registerMemoryGc(ctx());
    await run("memory-gc", "--older-than 0 --keep 0");
    expect(posts.join("\n")).toContain("handoff GC dry-run");
    expect(posts.join("\n")).toContain("untracked");
    expect(
      await readFile(
        join(memory, "handoffs", "2026-01-01-000000-abcdef.md"),
        "utf8",
      ),
    ).toBe("old");
  });

  it("fails closed when handoffs is an alias, not a real empty directory", async () => {
    await symlink(root, join(memory, "handoffs"), "dir");
    await registerMemoryGc(ctx());
    await run("memory-gc", "--older-than 0");
    expect(posts.join("\n")).toContain("gc failed");
    expect(posts.join("\n")).toContain("handoff directory alias");
    expect(posts.join("\n")).not.toContain("nothing to delete");
  });

  it("deletes only after --confirm and one batch approval", async () => {
    await mkdir(join(memory, "handoffs"), { recursive: true });
    await writeFile(
      join(memory, "handoffs", "2026-01-01-000000-abcdef.md"),
      "old",
    );
    await registerMemoryGc(ctx());
    await run("memory-gc", "--older-than 0 --keep 0 --confirm");
    expect(permissionCalls).toBe(1);
    expect(posts.join("\n")).toContain("GC applied");
  });
});
