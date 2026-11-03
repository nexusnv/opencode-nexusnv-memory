import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import {
  collectSidebarStatus,
  registerSidebarRpc,
  type SidebarStatusDeps,
} from "../src/sidebar-status.js";
import {
  noticeKey,
  pendingKey,
  rotatedKey,
  type LedgerStorage,
} from "../src/capture.js";

const PROJECT = "sidebar-project";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

class FakeStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  readonly sets: Array<[string, unknown]> = [];
  readonly removes: string[] = [];
  reads = 0;

  async get(key: string): Promise<unknown> {
    this.reads += 1;
    return this.data.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.sets.push([key, value]);
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.removes.push(key);
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

async function newProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-sidebar-"));
  tempRoots.push(root);
  return root;
}

async function projectWithIndex(
  lines: number,
): Promise<{ projectRoot: string; memoryRoot: string }> {
  const projectRoot = await newProjectRoot();
  const memoryRoot = join(projectRoot, ".opencode", "memory");
  await mkdir(memoryRoot, { recursive: true });
  const body =
    lines === 0
      ? ""
      : `${Array.from({ length: lines }, (_, i) => `- row ${i + 1}`).join("\n")}\n`;
  await writeFile(join(memoryRoot, "INDEX.md"), body);
  return { projectRoot, memoryRoot };
}

function input(memoryRoot: string, storage: LedgerStorage, indexLines = 30) {
  return { memoryRoot, storage, projectID: PROJECT, indexLines };
}

describe("collectSidebarStatus", () => {
  it("returns the pre-init reminder without reading storage", async () => {
    const projectRoot = await newProjectRoot();
    const memoryRoot = join(projectRoot, ".opencode", "memory");
    const storage = new ThrowingStorage();

    await expect(
      collectSidebarStatus(input(memoryRoot, storage)),
    ).resolves.toEqual({ state: "not-initialized", pending: 0 });
    expect(storage.reads).toBe(0);
  });

  it("is healthy when INDEX is inspectable, pending is zero, and no notice is set", async () => {
    const { memoryRoot } = await projectWithIndex(2);
    const storage = new FakeStorage();

    await expect(
      collectSidebarStatus(input(memoryRoot, storage)),
    ).resolves.toEqual({ state: "healthy", pending: 0 });
  });

  it("reports the pending counter unchanged", async () => {
    const { memoryRoot } = await projectWithIndex(1);
    const storage = new FakeStorage();
    storage.data.set(pendingKey(PROJECT), 3);

    await expect(
      collectSidebarStatus(input(memoryRoot, storage)),
    ).resolves.toEqual({ state: "pending", pending: 3 });
  });

  it("coerces an invalid pending value to zero", async () => {
    const { memoryRoot } = await projectWithIndex(1);
    const storage = new FakeStorage();
    storage.data.set(pendingKey(PROJECT), "3");

    await expect(
      collectSidebarStatus(input(memoryRoot, storage)),
    ).resolves.toEqual({ state: "healthy", pending: 0 });
  });

  it("treats an over-cap INDEX as attention", async () => {
    const { memoryRoot } = await projectWithIndex(3);
    const storage = new FakeStorage();
    storage.data.set(pendingKey(PROJECT), 2);

    await expect(
      collectSidebarStatus(input(memoryRoot, storage, 2)),
    ).resolves.toEqual({ state: "attention", pending: 2 });
  });

  it("treats a missing or unreadable INDEX after initialization as attention", async () => {
    const deps: SidebarStatusDeps = {
      isInitialized: async () => true,
      indexLineCount: async () => undefined,
      getPending: async () => 0,
      getNotice: async () => undefined,
    };

    await expect(
      collectSidebarStatus(input("/virtual/memory", new FakeStorage()), deps),
    ).resolves.toEqual({ state: "attention", pending: 0 });
  });

  it("treats each unconsumed actionable notice as attention", async () => {
    for (const kind of [
      "indexOverCap",
      "indexStale",
      "captureFailed",
    ] as const) {
      const { memoryRoot } = await projectWithIndex(1);
      const storage = new FakeStorage();
      storage.data.set(noticeKey(PROJECT, kind), 1);

      await expect(
        collectSidebarStatus(input(memoryRoot, storage)),
      ).resolves.toEqual({ state: "attention", pending: 0 });
    }
  });

  it("ignores rotated and forgotten notices", async () => {
    const { memoryRoot } = await projectWithIndex(1);
    const storage = new FakeStorage();
    storage.data.set(rotatedKey(PROJECT), 1);
    storage.data.set(noticeKey(PROJECT, "forgotten"), 4);

    await expect(
      collectSidebarStatus(input(memoryRoot, storage)),
    ).resolves.toEqual({ state: "healthy", pending: 0 });
  });

  it("never consumes or writes notices and pending", async () => {
    const { memoryRoot } = await projectWithIndex(1);
    const storage = new FakeStorage();
    storage.data.set(noticeKey(PROJECT, "indexOverCap"), 2);
    storage.data.set(pendingKey(PROJECT), 1);

    await collectSidebarStatus(input(memoryRoot, storage));

    expect(storage.data.get(noticeKey(PROJECT, "indexOverCap"))).toBe(2);
    expect(storage.data.get(pendingKey(PROJECT))).toBe(1);
    expect(storage.sets).toEqual([]);
    expect(storage.removes).toEqual([]);
  });

  it("propagates a storage rejection for an initialized project", async () => {
    const { memoryRoot } = await projectWithIndex(1);

    await expect(
      collectSidebarStatus(input(memoryRoot, new ThrowingStorage())),
    ).rejects.toThrow("storage down");
  });
});

interface CapturedRpc {
  readonly definition: { readonly id: string };
  readonly handlers: Record<string, unknown>;
}

function fakeRpcCtx(projectRoot: string, storage: LedgerStorage) {
  const captured: CapturedRpc[] = [];
  let disposed = 0;
  const ctx = {
    location: {
      directory: projectRoot,
      project: {
        id: PROJECT,
        directory: projectRoot,
        canonical: projectRoot,
      },
    },
    storage,
    rpc: {
      register: async (
        definition: { readonly id: string },
        handlers: Record<string, unknown>,
      ) => {
        captured.push({ definition, handlers });
        return {
          dispose: async () => {
            disposed += 1;
          },
          events: { emit: async () => undefined },
        };
      },
    },
  };
  return { ctx, captured, disposals: () => disposed };
}

type Handler = (
  input: Record<string, never>,
  call: { signal: AbortSignal },
) => Promise<unknown>;

describe("registerSidebarRpc", () => {
  it("registers the sidebarStatus handler and returns its snapshot", async () => {
    const { projectRoot, memoryRoot } = await projectWithIndex(1);
    const storage = new FakeStorage();
    const fake = fakeRpcCtx(projectRoot, storage);

    const registration = await registerSidebarRpc(
      fake.ctx as unknown as Plugin.Context,
      30,
    );

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0]!.definition.id).toBe("nexusnv.memory");
    const handler = fake.captured[0]!.handlers["sidebarStatus"] as Handler;
    await expect(
      handler({}, { signal: new AbortController().signal }),
    ).resolves.toEqual({ state: "healthy", pending: 0 });

    await registration.dispose();
    expect(fake.disposals()).toBe(1);
    // Prove the collector resolved the project's memory root, not the project
    // root, by writing INDEX only under `.opencode/memory`.
    expect(memoryRoot.endsWith(join(".opencode", "memory"))).toBe(true);
  });

  it("registers unconditionally and answers not-initialized before init", async () => {
    const projectRoot = await newProjectRoot();
    const fake = fakeRpcCtx(projectRoot, new FakeStorage());

    const registration = await registerSidebarRpc(
      fake.ctx as unknown as Plugin.Context,
      30,
    );

    expect(fake.captured).toHaveLength(1);
    const handler = fake.captured[0]!.handlers["sidebarStatus"] as Handler;
    await expect(
      handler({}, { signal: new AbortController().signal }),
    ).resolves.toEqual({ state: "not-initialized", pending: 0 });
    await registration.dispose();
  });
});
