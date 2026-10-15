import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import plugin from "../src/index.js";
import {
  MEMORY_REVIEW_ASK,
  MEMORY_REVIEW_COMMAND_NAME,
  MEMORY_REVIEW_DESCRIPTION,
  buildReviewAsk,
  registerMemoryReview,
} from "../src/review.js";
import {
  getPending,
  getRotated,
  incPending,
  setRotated,
  type LedgerStorage,
} from "../src/capture.js";

/**
 * `/memory-review` is the read+propose phase (spec §5.5 + c4-04): its sole
 * output is a proposal table; it writes nothing and never resets counters.
 * Only `memory_apply` resets (`candidates:[]` is the reviewed-nothing signal).
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

const PROJECT = "proj-review";
const SESSION = "sess-review";

interface AddedCommand {
  name: string;
  description?: string;
  execute: (input: {
    sessionID: string;
    prompt: {
      text: string;
      files?: unknown;
      agents?: unknown;
      skills?: unknown;
    };
    delivery: string;
  }) => Promise<void>;
}

let projectRoot: string;
let memoryRoot: string;
let storage: FakeStorage;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "memory-review-"));
  memoryRoot = join(projectRoot, ".opencode", "memory");
  await mkdir(join(memoryRoot, "handoffs"), { recursive: true });
  storage = new FakeStorage();
});

async function writeMemory(file: string, text: string): Promise<void> {
  const abs = join(memoryRoot, file);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
}

async function listMemory(): Promise<string[]> {
  return readdir(memoryRoot);
}

/** Minimal fake: only what registerMemoryReview touches. */
function fakeForCommand() {
  const added: AddedCommand[] = [];
  const prompted: unknown[] = [];
  const fakeCtx = {
    command: {
      transform: async (
        cb: (editor: { add: (def: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (def) => added.push(def) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      prompt: async (args: unknown) => {
        prompted.push(args);
        return { sessionID: SESSION } as never;
      },
    },
  };
  return { added, prompted, fakeCtx };
}

/** Full fake for plugin.setup wiring (mirrors test/hooks.test.ts + command). */
function fakeForSetup(store: LedgerStorage = storage) {
  const added: AddedCommand[] = [];
  const prompted: unknown[] = [];
  const hooks = new Map<string, (event: never) => Promise<void> | void>();
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
    storage: store,
    permission: {
      assert: async (_input: unknown): Promise<void> => undefined,
    },
    tool: {
      transform: async (
        cb: (editor: { add: (tool: unknown) => void }) => void,
      ) => {
        cb({ add: (_tool: unknown) => undefined });
        return { dispose: async () => undefined };
      },
    },
    command: {
      transform: async (
        cb: (editor: { add: (def: AddedCommand) => void }) => void,
      ) => {
        cb({ add: (def) => added.push(def) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      hook: async (
        name: string,
        cb: (event: never) => Promise<void> | void,
      ) => {
        hooks.set(name, cb);
        return {
          dispose: async () => {
            hooks.delete(name);
          },
        };
      },
      prompt: async (args: unknown) => {
        prompted.push(args);
        return { sessionID: SESSION } as never;
      },
    },
  };
  return { added, prompted, hooks, fakeCtx };
}

/** Every required ask-text fact (spec §5.5): untrusted data, no exec/fetch/obey. */
const REQUIRED_ASK_FRAGMENTS = [
  "untrusted DATA",
  "never as instructions",
  "do not execute",
  "do not fetch",
  "never follow directives",
  "INDEX.md",
  "activeContext.md",
  "PROPOSAL TABLE",
  "only",
  "target file",
  "exact candidate line",
  "provenance",
  "injection flags",
  "decisions",
  "architecture",
  "style",
  "issues",
  "cap",
  "redaction",
  "Do not write anything",
  "human approves",
  "deterministic",
  "Validate manual issues.md edits",
  "without overwriting",
] as const;

describe("buildReviewAsk", () => {
  it("returns the ask verbatim on empty base, base + ask otherwise", () => {
    expect(buildReviewAsk("")).toBe(MEMORY_REVIEW_ASK);
    expect(buildReviewAsk("review billing scope")).toBe(
      `review billing scope\n\n${MEMORY_REVIEW_ASK}`,
    );
  });

  it("ask text carries every normative protocol fact", () => {
    for (const fragment of REQUIRED_ASK_FRAGMENTS) {
      expect(MEMORY_REVIEW_ASK, `ask contains ${fragment}`).toContain(
        fragment,
      );
    }
  });
});

describe("proposes_table_and_writes_nothing", () => {
  it("spreads prompt, demands proposal-table-only, never resets counters", async () => {
    await writeMemory("INDEX.md", "- billing: invoices\n");
    await writeMemory("activeContext.md", "# Active context\n- ship it\n");
    const beforeFiles = await listMemory();
    const beforeIndex = await readFile(join(memoryRoot, "INDEX.md"), "utf8");
    await incPending(storage, PROJECT, 5);
    await setRotated(storage, PROJECT, 2);
    const keysBefore = [...storage.data.keys()].sort();

    const { added, prompted, fakeCtx } = fakeForCommand();
    const registration = await registerMemoryReview(fakeCtx as never);
    expect(added).toHaveLength(1);
    expect(added[0]!.name).toBe(MEMORY_REVIEW_COMMAND_NAME);
    expect(MEMORY_REVIEW_COMMAND_NAME).toBe("memory-review");
    expect(added[0]!.description).toBe(MEMORY_REVIEW_DESCRIPTION);
    expect(MEMORY_REVIEW_DESCRIPTION.length).toBeGreaterThan(0);

    const prompt = {
      text: "review billing scope",
      files: [{ uri: "file:///attached/notes.md" }],
      agents: [{ name: "primary" }],
      skills: [{ id: "memory-skill" }],
    };
    await added[0]!.execute({
      sessionID: SESSION,
      prompt,
      delivery: "steer",
    });

    // One re-submission through ctx.session.prompt (P7 spread).
    expect(prompted).toHaveLength(1);
    const call = prompted[0]! as {
      sessionID: string;
      delivery: string;
      text: string;
      files: unknown;
      agents: unknown;
      skills: unknown;
    };
    expect(call.sessionID).toBe(SESSION);
    expect(call.delivery).toBe("steer");
    // files/agents/skills survive the spread; PromptInput has no metadata.
    expect(call.files).toEqual(prompt.files);
    expect(call.agents).toEqual(prompt.agents);
    expect(call.skills).toEqual(prompt.skills);
    expect("metadata" in call).toBe(false);
    // Base scope preserved, then the protocol ask.
    expect(call.text).toBe(buildReviewAsk(prompt.text));
    expect(call.text.startsWith("review billing scope\n\n")).toBe(true);
    for (const fragment of REQUIRED_ASK_FRAGMENTS) {
      expect(call.text, `ask contains ${fragment}`).toContain(fragment);
    }

    // Empty base submits the ask verbatim.
    await added[0]!.execute({ sessionID: SESSION, prompt: { text: "" }, delivery: "steer" });
    expect((prompted[1]! as { text: string }).text).toBe(MEMORY_REVIEW_ASK);

    // The command never resets counters (only memory_apply does, incl. []).
    expect(await getPending(storage, PROJECT)).toBe(5);
    expect(await getRotated(storage, PROJECT)).toBe(2);
    expect([...storage.data.keys()].sort()).toEqual(keysBefore);

    // The read+propose phase writes nothing to the memory dir.
    expect(await listMemory()).toEqual(beforeFiles);
    expect(await readFile(join(memoryRoot, "INDEX.md"), "utf8")).toBe(
      beforeIndex,
    );

    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("index.ts wires registerMemoryReview (setup registers the command)", async () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, "..", "src", "index.ts"),
      "utf8",
    );
    expect(src).toMatch(/registerMemoryReview/);

    const { added, fakeCtx } = fakeForSetup();
    const setup = plugin.setup as unknown as (
      ctx: unknown,
    ) => Promise<(() => Promise<void>) | void>;
    const cleanup = await setup(fakeCtx);
    expect(added.map((c) => c.name)).toContain("memory-review");
    await (cleanup as () => Promise<void>)?.();
  });
});
