import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/index.js";
import {
  captureCompactionOutcome,
  dispatchEvent,
  getSnapshotHash,
  getThrottle,
  isKnownDiagnostic,
  isThisLocation,
  readVcsSnapshot,
  resetLedgerSingleFlightForTests,
  SEEN_LIMIT,
  setSnapshotHash,
  setThrottle,
  snapshotHandoffIfChanged,
  snapshotIfDue,
  startEventLoop,
  type LedgerStorage,
  type VcsPort,
} from "../src/capture.js";
import { resetWriteChainForTests } from "../src/files.js";

/**
 * Task 8 (spec §§5.7, 5.9 + c4-06): idle/compaction capture with survival
 * and isolation guarantees — foreign locations dropped before any write,
 * location-less unknown-session idle dropped, per-dispatch survival, ended
 * replay dedupe, VCS envelope unwrap + branch.list compat + diff
 * normalization, single controller + dispose().
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

/** Every method rejects: capture paths must still resolve, never throw. */
class ThrowingStorage implements LedgerStorage {
  async get(_key: string): Promise<unknown> {
    throw new Error("storage down");
  }
  async set(_key: string, _value: unknown): Promise<void> {
    throw new Error("storage down");
  }
  async remove(_key: string): Promise<void> {
    throw new Error("storage down");
  }
  async scan(_options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }> {
    throw new Error("storage down");
  }
}

/** Fake VCS speaking envelopes (`{ location, data }`), like the real API. */
class FakeVcs implements VcsPort {
  getCalls = 0;
  statusCalls = 0;
  branchListCalls = 0;
  branchesCalls = 0;
  diffCalls = 0;
  lastDiffInput: unknown;
  readonly branch?: { list: () => Promise<unknown> };
  readonly branches?: () => Promise<unknown>;
  constructor(
    public opts: {
      readonly current?: string;
      readonly files?: string[];
      readonly list?: string[];
      readonly legacyList?: string[];
      readonly diff?: string[];
      readonly failGet?: boolean;
      readonly failStatus?: boolean;
      readonly noBranchList?: boolean;
    } = {},
  ) {
    if (!opts.noBranchList) {
      const list = opts.list ?? ["main"];
      this.branch = {
        list: async () => {
          this.branchListCalls += 1;
          return { location: { directory: "/repo" }, data: list };
        },
      };
    }
    if (opts.legacyList !== undefined) {
      const list = opts.legacyList;
      this.branches = async () => {
        this.branchesCalls += 1;
        return { location: { directory: "/repo" }, data: list };
      };
    }
  }
  async get(): Promise<unknown> {
    this.getCalls += 1;
    if (this.opts.failGet) throw new Error("vcs get down");
    return {
      location: { directory: "/repo" },
      data: {
        branch:
          this.opts.current !== undefined
            ? { current: this.opts.current, default: "main" }
            : {},
      },
    };
  }
  async status(): Promise<unknown> {
    this.statusCalls += 1;
    if (this.opts.failStatus) throw new Error("vcs status down");
    return {
      location: { directory: "/repo" },
      data: (this.opts.files ?? []).map((file) => ({
        file,
        additions: 1,
        deletions: 0,
        status: "modified",
      })),
    };
  }
  async diff(input: {
    readonly mode: string;
    readonly context?: number;
  }): Promise<unknown> {
    this.diffCalls += 1;
    this.lastDiffInput = input;
    return {
      location: { directory: "/repo" },
      data: (this.opts.diff ?? []).map((file) => ({
        file,
        patch: "@@ mock @@",
        additions: 1,
        deletions: 0,
        status: "modified",
      })),
    };
  }
}

const PROJECT = "proj-isolation";
const T0 = 1_700_000_000_000;

let projectRoot: string;
let memoryRoot: string;
let storage: FakeStorage;
let evtSeq: number;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "memory-isolation-"));
  memoryRoot = join(projectRoot, ".opencode", "memory");
  await mkdir(join(memoryRoot, "handoffs"), { recursive: true });
  storage = new FakeStorage();
  evtSeq = 0;
  resetWriteChainForTests();
  resetLedgerSingleFlightForTests();
});

function idleEvent(sessionID: string, dir: string | undefined) {
  evtSeq += 1;
  return {
    id: `evt-idle-${evtSeq}`,
    type: "session.idle",
    ...(dir === undefined ? {} : { location: { directory: dir } }),
    data: { sessionID },
    created: T0,
  };
}

function endedEvent(
  sessionID: string,
  dir: string | undefined,
  text: string,
  recent: string,
) {
  evtSeq += 1;
  return {
    id: `evt-ended-${evtSeq}`,
    type: "session.compaction.ended",
    ...(dir === undefined ? {} : { location: { directory: dir } }),
    data: { sessionID, reason: "auto", text, recent },
    created: T0,
  };
}

async function handoffFiles(): Promise<string[]> {
  try {
    const entries = await readdir(join(memoryRoot, "handoffs"), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readHandoff(name: string): Promise<string> {
  const rel = name.startsWith("handoffs/") ? name : `handoffs/${name}`;
  return readFile(join(memoryRoot, rel), "utf8");
}

describe("isThisLocation", () => {
  const plugin = () => ({ directory: projectRoot, projectID: PROJECT });
  it("drops foreign directories before any write", () => {
    expect(
      isThisLocation(idleEvent("s1", "/elsewhere"), plugin()),
    ).toBe(false);
    expect(isThisLocation(idleEvent("s1", projectRoot), plugin())).toBe(true);
  });
  it("tolerates trailing slashes on either side", () => {
    expect(isThisLocation(idleEvent("s1", `${projectRoot}/`), plugin())).toBe(
      true,
    );
  });
  it("passes location-less events through (ledger judges known-ness)", () => {
    expect(isThisLocation(idleEvent("s1", undefined), plugin())).toBe(true);
  });
  it("drops mismatched data.projectID", () => {
    const event = {
      ...idleEvent("s1", projectRoot),
      data: { sessionID: "s1", projectID: "other-proj" },
    };
    expect(isThisLocation(event, plugin())).toBe(false);
    expect(
      isThisLocation(
        { ...event, data: { sessionID: "s1", projectID: PROJECT } },
        plugin(),
      ),
    ).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isThisLocation(null, plugin())).toBe(false);
    expect(isThisLocation("session.idle", plugin())).toBe(false);
    expect(isThisLocation({}, plugin())).toBe(true);
  });
});

describe("isKnownDiagnostic", () => {
  it("samples session lifecycle, drops TUI and unknown noise", () => {
    expect(
      isKnownDiagnostic({ type: "session.status.updated", data: {} }),
    ).toBe(true);
    expect(
      isKnownDiagnostic({ type: "session.compaction.started", data: {} }),
    ).toBe(true);
    expect(isKnownDiagnostic({ type: "tui.prompt.append", data: {} })).toBe(
      false,
    );
    expect(isKnownDiagnostic({ type: "tui.toast.show", data: {} })).toBe(
      false,
    );
    expect(isKnownDiagnostic({ type: "vendor.noise", data: {} })).toBe(false);
    expect(isKnownDiagnostic(null)).toBe(false);
    expect(isKnownDiagnostic({})).toBe(false);
  });
});

describe("readVcsSnapshot (VCS adapter)", () => {
  it("unwraps .data envelopes for get + status", async () => {
    const warnings: unknown[] = [];
    const snap = await readVcsSnapshot(
      new FakeVcs({ current: "feat-x", files: ["b.ts", "a.ts"] }),
      (e) => warnings.push(e),
    );
    expect(snap.branch).toBe("feat-x");
    expect(snap.changes).toEqual(["a.ts", "b.ts"]);
    expect(warnings).toHaveLength(0);
  });
  it("prefers branch.list, falls back to branches() compat", async () => {
    const warnings: unknown[] = [];
    const vcs = new FakeVcs({
      // get() carries no current branch; no branch.list; legacy only.
      noBranchList: true,
      legacyList: ["compat-branch", "main"],
    });
    const snap = await readVcsSnapshot(vcs, (e) => warnings.push(e));
    expect(snap.branch).toBe("compat-branch");
    expect(vcs.branchesCalls).toBe(1);
    expect(vcs.branchListCalls).toBe(0);
    expect(warnings).toHaveLength(0);
  });
  it("falls back to diff({mode:working,context:3}) normalizing FileDiff[]", async () => {
    const vcs = new FakeVcs({
      current: "main",
      failStatus: true,
      diff: ["z.ts", "m.ts"],
    });
    const snap = await readVcsSnapshot(vcs);
    expect(vcs.statusCalls).toBe(1);
    expect(vcs.diffCalls).toBe(1);
    expect(vcs.lastDiffInput).toEqual({ mode: "working", context: 3 });
    // FileDiff[] normalized to sorted file strings before hashing.
    expect(snap.changes).toEqual(["m.ts", "z.ts"]);
  });
  it("is warn-only and never throws on total VCS failure", async () => {
    const warnings: unknown[] = [];
    const failing: VcsPort = {
      get: async () => {
        throw new Error("down");
      },
      status: async () => {
        throw new Error("down");
      },
      diff: async () => {
        throw new Error("down");
      },
    };
    await expect(readVcsSnapshot(failing, (e) => warnings.push(e))).resolves
      .toEqual({ branch: "unknown", changes: [] });
    expect(warnings.length).toBeGreaterThan(0);
    await expect(readVcsSnapshot(undefined, (e) => warnings.push(e))).resolves
      .toEqual({ branch: "unknown", changes: [] });
  });
});

describe("snapshotHandoffIfChanged", () => {
  it("writes an immutable hash-guarded handoff, then no-ops", async () => {
    const vcs = new FakeVcs({ current: "feat-x", files: ["a.ts"] });
    const first = await snapshotHandoffIfChanged(idleEvent("sess-a1", projectRoot), {
      vcs,
      storage,
      projectID: PROJECT,
      memoryRoot,
    });
    expect(first.reason).toBe("written");
    expect(first.file).toMatch(/^handoffs\/\d{4}-\d{2}-\d{2}-\d{6}-.+\.md$/);
    expect(first.file!.endsWith(`-${"sess-a1".slice(-6)}.md`)).toBe(true);
    const body = await readHandoff(first.file!);
    expect(body).toContain("feat-x");
    expect(body).toContain("a.ts");
    expect(body).toContain("source:snapshot");
    expect(await getSnapshotHash(storage, PROJECT, "sess-a1")).toBeDefined();

    const second = await snapshotHandoffIfChanged(
      idleEvent("sess-a1", projectRoot),
      { vcs, storage, projectID: PROJECT, memoryRoot },
    );
    expect(second.reason).toBe("unchanged");
    expect(await handoffFiles()).toHaveLength(1);
  });
  it("resolves the root from the event location, never the cached root", async () => {
    const vcs = new FakeVcs({ current: "main" });
    const outcome = await snapshotHandoffIfChanged(idleEvent("sess-b1", projectRoot), {
      vcs,
      storage,
      projectID: PROJECT,
      memoryRoot: "/stale/fallback",
    });
    expect(outcome.reason).toBe("written");
    expect(await handoffFiles()).toHaveLength(1);
  });
  it("drops location-less idle for unknown sessions", async () => {
    const outcome = await snapshotHandoffIfChanged(idleEvent("ghost", undefined), {
      vcs: new FakeVcs({ current: "main" }),
      storage,
      projectID: PROJECT,
      memoryRoot,
    });
    expect(outcome.reason).toBe("dropped");
    expect(await handoffFiles()).toHaveLength(0);
  });
  it("snapshots location-less idle for known sessions", async () => {
    await setThrottle(storage, PROJECT, "known-sess", T0);
    const outcome = await snapshotHandoffIfChanged(
      idleEvent("known-sess", undefined),
      {
        vcs: new FakeVcs({ current: "main" }),
        storage,
        projectID: PROJECT,
        memoryRoot,
      },
    );
    expect(outcome.reason).toBe("written");
    expect(await handoffFiles()).toHaveLength(1);
  });
  it("skips non-idle events and session-less events", async () => {
    const deps = {
      vcs: new FakeVcs(),
      storage,
      projectID: PROJECT,
      memoryRoot,
    };
    await expect(
      snapshotHandoffIfChanged(endedEvent("s", projectRoot, "t", "r"), deps),
    ).resolves.toMatchObject({ reason: "skipped" });
    await expect(
      snapshotHandoffIfChanged({ type: "session.idle", data: {} }, deps),
    ).resolves.toMatchObject({ reason: "skipped" });
    expect(await handoffFiles()).toHaveLength(0);
  });
  it("never throws with hostile storage", async () => {
    await expect(
      snapshotHandoffIfChanged(idleEvent("s", projectRoot), {
        vcs: new FakeVcs({ current: "main" }),
        storage: new ThrowingStorage(),
        projectID: PROJECT,
        memoryRoot,
      }),
    ).resolves.toMatchObject({ reason: "failed" });
  });
});

describe("captureCompactionOutcome", () => {
  it("persists text+recent and dedupes ended replays via seen/<event.id>", async () => {
    const deps = {
      vcs: new FakeVcs({ current: "main" }),
      storage,
      projectID: PROJECT,
      memoryRoot,
    };
    const event = endedEvent("sess-c1", projectRoot, "COMPACTION-TEXT-1", "recent tail");
    const first = await captureCompactionOutcome(event, deps);
    expect(first.reason).toBe("captured");
    const body = await readHandoff(first.file!);
    expect(body).toContain("COMPACTION-TEXT-1");
    expect(body).toContain("recent tail");
    expect(body).toContain("source:snapshot");
    // Durable `ended` redelivered: replay is a deduped no-op.
    await expect(captureCompactionOutcome(event, deps)).resolves.toMatchObject({
      reason: "duplicate",
    });
    expect(await handoffFiles()).toHaveLength(1);
  });
  it("writes a pointer-only handoff when the produced text is missing", async () => {
    const outcome = await captureCompactionOutcome(
      endedEvent("sess-c2", projectRoot, "", ""),
      {
        vcs: new FakeVcs({ current: "ptr-branch" }),
        storage,
        projectID: PROJECT,
        memoryRoot,
      },
    );
    expect(outcome.reason).toBe("captured");
    const body = await readHandoff(outcome.file!);
    expect(body).toContain("compaction occurred");
    expect(body).toContain("ptr-branch");
  });
  it("skips non-ended events and id-less events", async () => {
    const deps = {
      vcs: new FakeVcs(),
      storage,
      projectID: PROJECT,
      memoryRoot,
    };
    await expect(
      captureCompactionOutcome(idleEvent("s", projectRoot), deps),
    ).resolves.toMatchObject({ reason: "skipped" });
    await expect(
      captureCompactionOutcome(
        { type: "session.compaction.ended", data: { sessionID: "s" } },
        deps,
      ),
    ).resolves.toMatchObject({ reason: "skipped" });
    expect(await handoffFiles()).toHaveLength(0);
  });
  it("prunes the seen set after capture (bounded keys)", async () => {
    for (let i = 0; i < SEEN_LIMIT + 5; i += 1) {
      await storage.set(`${PROJECT}/seen/pre-${i}`, i);
    }
    const outcome = await captureCompactionOutcome(
      endedEvent("sess-prune", projectRoot, "PRUNE-TEXT-UNIQUE", "recent"),
      {
        vcs: new FakeVcs({ current: "main" }),
        storage,
        projectID: PROJECT,
        memoryRoot,
      },
    );
    expect(outcome.reason).toBe("captured");
    // Prune is fire-and-forget off the write mutex: let it land.
    await new Promise((r) => setTimeout(r, 50));
    const seen = [...storage.data.keys()].filter((k) =>
      k.startsWith(`${PROJECT}/seen/`),
    );
    expect(seen.length).toBeLessThanOrEqual(SEEN_LIMIT);
  });
});

describe("dispatchEvent", () => {
  function deps(log?: (error: unknown) => void) {
    return {
      vcs: new FakeVcs({ current: "main", files: [] }) as VcsPort,
      storage,
      projectID: PROJECT,
      directory: projectRoot,
      memoryRoot,
      log,
    };
  }
  it("drops foreign event.location before any write", async () => {
    const logs: unknown[] = [];
    await dispatchEvent(idleEvent("foreign-sess", "/elsewhere"), deps((e) => logs.push(e)));
    expect(await handoffFiles()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
  it("routes idle → snapshot, ended → capture, compaction.* → diagnostic", async () => {
    const logs: unknown[] = [];
    const d = deps((e) => logs.push(e));
    await dispatchEvent(idleEvent("sess-d1", projectRoot), d);
    await dispatchEvent(endedEvent("sess-d2", projectRoot, "T", "R"), d);
    await dispatchEvent(
      { id: "x", type: "session.compaction.started", data: { sessionID: "s" } },
      d,
    );
    expect(await handoffFiles()).toHaveLength(2);
    expect(logs).toHaveLength(1);
  });
  it("drops TUI noise silently", async () => {
    const logs: unknown[] = [];
    await dispatchEvent(
      { id: "t", type: "tui.prompt.append", data: { text: "hi" } },
      deps((e) => logs.push(e)),
    );
    expect(logs).toHaveLength(0);
    expect(await handoffFiles()).toHaveLength(0);
  });
  it("survives a throwing logger on event N (N+1 still captured)", async () => {
    let calls = 0;
    const evilLog = (): void => {
      calls += 1;
      if (calls === 1) throw new Error("log down");
    };
    const d = { ...deps(), log: evilLog };
    await dispatchEvent(idleEvent("sess-e1", projectRoot), d);
    await dispatchEvent(idleEvent("sess-e2", projectRoot), d);
    expect(await handoffFiles()).toHaveLength(2);
  });
  it("never throws on garbage", async () => {
    await expect(dispatchEvent(null, deps())).resolves.toBeUndefined();
    await expect(dispatchEvent("nope", deps())).resolves.toBeUndefined();
  });
});

describe("startEventLoop survival", () => {
  it("a throw on event N never stops event N+1", async () => {
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const controller = new AbortController();
    function* script() {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }
    await startEventLoop(
      function (options) {
        expect(options.signal).toBe(controller.signal);
        return (async function* () {
          yield* script();
        })();
      },
      {
        signal: controller.signal,
        handleEvent: (event) => {
          const n = (event as { n: number }).n;
          if (n === 1) throw new Error("boom on N");
          seen.push(n);
        },
        log: (e) => errors.push(e),
      },
    );
    expect(seen).toEqual([2, 3]);
    expect(errors).toHaveLength(1);
  });
  it("never rejects when subscribe itself fails", async () => {
    const errors: unknown[] = [];
    await expect(
      startEventLoop(
        () => {
          throw new Error("subscribe down");
        },
        {
          signal: new AbortController().signal,
          handleEvent: () => undefined,
          log: (e) => errors.push(e),
        },
      ),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("snapshotIfDue (fleshed out)", () => {
  const SESSION = "sess-due";
  it("writes once, throttles inside the window, rewrites on change after it", async () => {
    const vcs = new FakeVcs({ current: "main", files: ["a.ts"] });
    const opts = {
      now: T0,
      throttleMinutes: 10,
      vcs: vcs as VcsPort,
      memoryRoot,
    };
    await expect(snapshotIfDue(storage, PROJECT, SESSION, opts)).resolves.toBe(
      true,
    );
    expect(await handoffFiles()).toHaveLength(1);
    // Inside the window: throttled (VCS not even probed).
    await expect(
      snapshotIfDue(storage, PROJECT, SESSION, { ...opts, now: T0 + 1000 }),
    ).resolves.toBe(false);
    expect(await handoffFiles()).toHaveLength(1);
    // Past the window, same hash: no rewrite.
    await expect(
      snapshotIfDue(storage, PROJECT, SESSION, { ...opts, now: T0 + 11 * 60_000 }),
    ).resolves.toBe(false);
    expect(await handoffFiles()).toHaveLength(1);
    // Past the window with changed state: rewrite.
    vcs.opts = { ...vcs.opts, files: ["b.ts"] };
    await expect(
      snapshotIfDue(storage, PROJECT, SESSION, {
        ...opts,
        now: T0 + 22 * 60_000,
      }),
    ).resolves.toBe(true);
    expect(await handoffFiles()).toHaveLength(2);
  });
  it("serializes concurrent context invocations to one slot", async () => {
    const vcs = new FakeVcs({ current: "main" });
    const opts = {
      now: T0,
      throttleMinutes: 10,
      vcs: vcs as VcsPort,
      memoryRoot,
    };
    const results = await Promise.all([
      snapshotIfDue(storage, PROJECT, "sess-race", opts),
      snapshotIfDue(storage, PROJECT, "sess-race", opts),
      snapshotIfDue(storage, PROJECT, "sess-race", opts),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await handoffFiles()).toHaveLength(1);
  });
  it("records the slot without writing when no VCS is available", async () => {
    await expect(
      snapshotIfDue(storage, PROJECT, SESSION, { now: T0 }),
    ).resolves.toBe(false);
    expect(await getThrottle(storage, PROJECT, SESSION)).toBe(T0);
    expect(await handoffFiles()).toHaveLength(0);
  });
  it("never throws", async () => {
    await expect(
      snapshotIfDue(new ThrowingStorage(), PROJECT, SESSION, { now: T0 }),
    ).resolves.toBe(false);
  });
});

describe("setup wiring: single controller + dispose()", () => {
  it("subscribes once on the setup controller and aborts + disposes on cleanup", async () => {
    const hooks = new Map<string, (event: never) => Promise<void> | void>();
    let toolDisposed = false;
    let commandDisposed = false;
    const subscribed: { calls: number; signal?: AbortSignal } = { calls: 0 };
    const localIdle = idleEvent("sess-live", projectRoot);
    const localEnded = {
      ...endedEvent("sess-live2", projectRoot, "LIVE-TEXT", "live recent"),
      created: T0 + 2000,
    };
    const script = [
      idleEvent("foreign-sess", "/elsewhere"),
      localIdle,
      localEnded,
      { id: "t1", type: "tui.toast.show", data: {} },
    ];
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
      vcs: new FakeVcs({ current: "wired-branch", files: [] }),
      event: {
        subscribe: async function* (options?: { signal?: AbortSignal }) {
          subscribed.calls += 1;
          subscribed.signal = options?.signal;
          for (const event of script) yield event as never;
        },
      },
      permission: {
        assert: async (_input: unknown): Promise<void> => undefined,
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
        prompt: async (_args: unknown) => ({ sessionID: "s" }) as never,
      },
      tool: {
        transform: async (
          cb: (editor: { add: (tool: unknown) => void }) => void,
        ) => {
          cb({ add: (_tool: unknown) => undefined });
          return {
            dispose: async () => {
              toolDisposed = true;
            },
          };
        },
        hook: async (
          name: string,
          cb: (event: never) => Promise<void> | void,
        ) => {
          hooks.set(`tool:${name}`, cb);
          return {
            dispose: async () => {
              hooks.delete(`tool:${name}`);
            },
          };
        },
      },
      command: {
        transform: async (
          cb: (editor: { add: (def: unknown) => void }) => void,
        ) => {
          cb({ add: (_def: unknown) => undefined });
          return {
            dispose: async () => {
              commandDisposed = true;
            },
          };
        },
      },
    };
    const setup = plugin.setup as unknown as (
      ctx: unknown,
    ) => Promise<(() => Promise<void>) | void>;
    const cleanup = await setup(fakeCtx);
    expect(typeof cleanup === "function" || cleanup === undefined).toBe(true);

    // Single controller: exactly one subscription carrying an AbortSignal.
    expect(subscribed.calls).toBe(1);
    expect(subscribed.signal).toBeInstanceOf(AbortSignal);
    expect(subscribed.signal!.aborted).toBe(false);

    // Foreign dropped, local idle + ended captured, TUI silent.
    await vi.waitFor(
      async () => {
        expect(await handoffFiles()).toHaveLength(2);
      },
      { timeout: 3000, interval: 10 },
    );
    const bodies = await Promise.all(
      (await handoffFiles()).map((f) => readHandoff(f)),
    );
    expect(bodies.join("\n")).toContain("wired-branch");
    expect(bodies.join("\n")).toContain("LIVE-TEXT");
    expect(bodies.join("\n")).not.toContain("foreign-sess");

    // Cleanup aborts the controller and disposes every registration.
    await cleanup!();
    expect(subscribed.signal!.aborted).toBe(true);
    expect(hooks.size).toBe(0);
    expect(toolDisposed).toBe(true);
    expect(commandDisposed).toBe(true);
  });
});

describe("ledger seams used by capture", () => {
  it("snapshot hash round-trips per session", async () => {
    await setSnapshotHash(storage, PROJECT, "s1", "hash-a");
    expect(await getSnapshotHash(storage, PROJECT, "s1")).toBe("hash-a");
  });
});
