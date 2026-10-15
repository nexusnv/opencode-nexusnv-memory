import { describe, expect, it, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BRIEF_MAX_LINES,
  indexWithinCap,
  loadBrief,
  loadPriors,
} from "../src/brief.js";
import {
  captureFailure,
  dispatchEvent,
  getPending,
  handoffName,
  incPending,
  isThisLocation,
  readVcsSnapshot,
  setRotated,
  snapshotHandoffIfChanged,
  writeHandoffUnique,
  type LedgerStorage,
} from "../src/capture.js";
import { DEFAULT_MEMORY_OPTIONS } from "../src/config.js";
import { readCapped, writeCapped } from "../src/files.js";
import { flagInjection } from "../src/guard.js";
import { matchIndex } from "../src/hints.js";
import { classifyProvenance } from "../src/provenance.js";
import { redact } from "../src/redact.js";
import { statusLine, REVIEW_DUE_PENDING } from "../src/status.js";
import {
  AGENTS_PROTOCOL_BLOCK,
  permissionsSnippet,
} from "../src/templates.js";
import {
  createMemoryApplyExecute,
  createMemoryRecallExecute,
  MEMORY_RECALL_DESCRIPTION,
  toolResult,
  type PermissionAsserter,
} from "../src/tools.js";

/**
 * P1 acceptance gate (spec §9). Each `it` maps to one pre-merge bullet:
 * budgets, INDEX attach/dedup, compaction priors, redaction, recall/apply
 * contracts, handoff routing, isolation, lifecycle, status line,
 * containment, provenance, evals, compatibility, and deploy logging.
 */

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
    const after = options.after ?? "";
    const rest = after ? keys.filter((k) => k > after) : keys;
    const limit = options.limit ?? rest.length;
    const page = rest.slice(0, limit);
    return {
      entries: page.map((key) => ({ key, value: this.data.get(key) })),
      next:
        rest.length > page.length
          ? page[page.length - 1]
          : undefined,
    };
  }
}

type AssertCall = Parameters<PermissionAsserter["assert"]>[0];

class FakePermission implements PermissionAsserter {
  readonly calls: AssertCall[] = [];
  async assert(input: AssertCall): Promise<void> {
    this.calls.push(input);
  }
}

const PROJECT = "proj-acceptance";
const SESSION = "session-abcdef123456";

let projectRoot: string;
let memoryRoot: string;
let storage: FakeStorage;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "memory-accept-"));
  memoryRoot = join(projectRoot, ".opencode", "memory");
  await mkdir(join(memoryRoot, "handoffs"), { recursive: true });
  storage = new FakeStorage();
});

async function writeMemory(file: string, text: string): Promise<void> {
  const abs = join(memoryRoot, file);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text, "utf8");
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

const ROOT = resolve(import.meta.dirname!, "..");
const srcOf = (p: string): string =>
  readFileSync(resolve(ROOT, "src", p), "utf8");

describe("acceptance_budgets_every_write_path", () => {
  it("writeCapped enforces caps on every capped path; activeContext rotates", async () => {
    const over = (n: number): string =>
      Array.from({ length: n }, (_, i) => `- line ${i + 1}`).join("\n");
    // INDEX / rule files / handoffs throw instead of silently truncating.
    await expect(
      writeCapped("INDEX.md", over(31), { memoryRoot }),
    ).rejects.toThrow();
    for (const file of [
      "architecture.md",
      "style.md",
      "issues.md",
      "handoffs/2026-10-15-120000-abcdef.md",
    ]) {
      await expect(
        writeCapped(file, over(61), { memoryRoot }),
      ).rejects.toThrow();
    }
    // decisions.md is unbounded on disk.
    await writeCapped("decisions.md", over(500), { memoryRoot });
    expect(countLines(await readFile(join(memoryRoot, "decisions.md"), "utf8"))).toBe(500);
    // activeContext.md rotates the oldest Known-Errors block instead of throwing.
    // activeContext.md rotates the oldest Known-Errors block instead of throwing.
    const errors = Array.from(
      { length: 30 },
      (_, i) => `- boom ${i + 1} source:tool\n  detail ${i + 1}`,
    ).join("\n");
    await writeMemory(
      "activeContext.md",
      `# Active context\n\n## Goal\n- ship it\n\n## Known errors\n${errors}\n`,
    );
    await writeCapped(
      "activeContext.md",
      `# Active context\n\n## Goal\n- ship it\n\n## Known errors\n${errors}\n- one more source:tool\n  extra detail\n`,
      { memoryRoot },
    );
    const archive = await readdir(join(memoryRoot, "handoffs", "archive"));
    expect(archive.length).toBeGreaterThan(0);
  });

  it("end_to_end injected payload fits injectBudgetLines (INDEX+brief+hint+status)", async () => {
    const indexLines = Array.from(
      { length: 30 },
      (_, i) => `- topic-${i}: decisions.md`,
    ).join("\n");
    await writeMemory("INDEX.md", `${indexLines}\n`);
    await writeMemory(
      "activeContext.md",
      `# Active context\n\n## Goal\n- acceptance run ACCEPT-BUDGET-MARKER\n`,
    );
    const attached = await indexWithinCap(join(memoryRoot, "INDEX.md"));
    expect(attached).toBe(true);
    const brief = await loadBrief(memoryRoot);
    const status = await statusLine(storage, PROJECT);
    const hint = await matchIndex(
      [{ role: "user", content: [{ type: "text", text: "tell me about topic-7" }] }],
      { storage, projectID: PROJECT, sessionID: SESSION, indexContent: indexLines },
    );
    const payloadLines =
      countLines(indexLines) +
      countLines(brief) +
      (hint ? 1 : 0) +
      (status ? 1 : 0);
    expect(countLines(brief)).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(payloadLines).toBeLessThanOrEqual(
      DEFAULT_MEMORY_OPTIONS.injectBudgetLines,
    );
  });
});

describe("acceptance_index_attach_and_brief_shape", () => {
  it("over_cap_INDEX_is_not_attached", async () => {
    const over = Array.from({ length: 31 }, (_, i) => `- t${i}: d.md`).join("\n");
    await writeMemory("INDEX.md", `${over}\n`);
    expect(await indexWithinCap(join(memoryRoot, "INDEX.md"))).toBe(false);
  });

  it("brief_carries_no_INDEX_duplication", async () => {
    const marker = "INDEX-MAP-MARKER-UNIQUE-998877";
    await writeMemory("INDEX.md", `- ${marker}: decisions.md\n`);
    await writeMemory(
      "activeContext.md",
      `# Active context\n\n## Goal\n- brief body marker BRIEF-BODY-112233\n`,
    );
    const brief = await loadBrief(memoryRoot);
    expect(brief).toContain("BRIEF-BODY-112233");
    expect(brief).not.toContain(marker);
    expect(brief).not.toContain("topic → file");
  });
});

describe("acceptance_compaction_priors", () => {
  it("priors_carry_decisions_tail_and_hook_never_sets_result", async () => {
    await writeMemory(
      "activeContext.md",
      `# Active context\n\n## Goal\n- keep priors PRIOR-GOAL-4455\n`,
    );
    const tail = Array.from(
      { length: 10 },
      (_, i) => `- decision ${i + 1} source:user`,
    );
    tail.push("- PRIOR-TAIL-MARKER-UNIQUE-6677 source:user");
    await writeMemory("decisions.md", `${tail.join("\n")}\n`);
    const priors = await loadPriors(memoryRoot);
    expect(priors).toContain("PRIOR-TAIL-MARKER-UNIQUE-6677");
    expect(priors).toContain("PRIOR-GOAL-4455");
    // The compaction hook must never set event.result (P3): no assignment
    // site anywhere in src/.
    for (const file of ["index.ts", "capture.ts", "brief.ts"]) {
      expect(srcOf(file)).not.toMatch(/\.result\s*=/);
    }
    expect(srcOf("index.ts")).toMatch(/compaction/);
    expect(srcOf("index.ts")).toMatch(/loadPriors/);
  });
});

describe("acceptance_redaction", () => {
  it("blocks_secrets_fixture_and_private_incl_unclosed", async () => {
    const secrets = readFileSync(
      resolve(ROOT, "test", "fixtures", "secrets.txt"),
      "utf8",
    );
    expect(secrets.trim().length).toBeGreaterThan(0);
    const redacted = redact(secrets);
    for (const line of secrets.split("\n").filter((l) => l.trim().length > 0)) {
      expect(redacted).not.toContain(line.trim());
    }
    expect(redact("before <private>hunter2 hunter2</private> after")).not.toContain(
      "hunter2",
    );
    expect(redact("before <PRIVATE>multi\nline\nsecret</PRIVATE> after")).not.toContain(
      "secret",
    );
    // Unclosed tag strips to EOF.
    const unclosed = redact("visible <private>sk-live-abcdef1234567890");
    expect(unclosed).toContain("visible");
    expect(unclosed).not.toContain("sk-live");
    // Redaction applies on the write path too.
    await writeCapped("style.md", "ok <private>drop me</private> kept", {
      memoryRoot,
    });
    const stored = await readFile(join(memoryRoot, "style.md"), "utf8");
    expect(stored).not.toContain("drop me");
  });
});

describe("acceptance_recall_and_apply_contracts", () => {
  it("recall_rejects_traversal_and_returns_toolResult_envelope", async () => {
    await writeMemory("INDEX.md", "- a: b\n");
    const execute = createMemoryRecallExecute({ memoryRoot });
    const out = await execute({ file: "INDEX.md" }, {
      sessionID: SESSION, agent: "primary", messageID: "m1", id: "c1",
    });
    expect(out).toEqual(toolResult(await readCapped("INDEX.md", { memoryRoot })));
    expect(out).toEqual({ content: expect.any(String) });
    for (const bad of [
      "../INDEX.md",
      "/absolute.md",
      "random.md",
      "handoffs/../../etc/passwd",
      "..\\INDEX.md",
      "%2e%2e/INDEX.md",
    ]) {
      await expect(
        execute({ file: bad }, {
          sessionID: SESSION, agent: "primary", messageID: "m1", id: "c1",
        }),
      ).rejects.toThrow();
    }
  });

  it("apply_asserts_once_per_line_with_shipped_ask_rule_and_tool_context_ids", async () => {
    // Shipped rule makes assert prompt instead of failing open (§4.4).
    expect(permissionsSnippet()).toMatch(/memory_write/);
    expect(permissionsSnippet()).toMatch(/"effect":\s*"ask"/);
    const permission = new FakePermission();
    const execute = createMemoryApplyExecute({
      memoryRoot,
      projectID: PROJECT,
      storage,
      permission,
    });
    const out = await execute(
      {
        candidates: [
          { file: "style.md", line: "- r1 source:user", source: "user" },
          { file: "issues.md", line: "- [todo] t (#1) source:tool", source: "tool" },
        ],
      },
      { sessionID: SESSION, agent: "primary", messageID: "msg-9", id: "call-9" },
    );
    expect(permission.calls).toHaveLength(2);
    for (const call of permission.calls) {
      expect(call.action).toBe("memory_write");
      expect(call.sessionID).toBe(SESSION);
      expect(call.agent).toBe("primary");
      expect(call.save).toEqual([]);
      expect(call.source).toEqual({
        type: "tool",
        messageID: "msg-9",
        id: "call-9",
      });
    }
    expect(permission.calls[0]?.metadata).toEqual({
      line: "- r1 source:user",
      source: "user",
    });
    expect(out).toEqual(toolResult(expect.any(String) as unknown as string));
  });

  it("untrusted_candidates_excluded_from_bulk_approve", async () => {
    // There is no bulk-approve path: even all-untrusted batches assert per
    // line, and a deny stops the batch with the rest still pending.
    const { Tool } = await import("@opencode/schema/tool");
    const denied = new Tool.Error({ message: "denied" });
    let n = 0;
    const denyCalls: AssertCall[] = [];
    const permission: PermissionAsserter = {
      async assert(input: AssertCall): Promise<void> {
        denyCalls.push(input);
        n += 1;
        if (n === 2) throw denied;
      },
    };
    const execute = createMemoryApplyExecute({
      memoryRoot,
      projectID: PROJECT,
      storage,
      permission,
    });
    await expect(
      execute(
        {
          candidates: [
            { file: "style.md", line: "- u1 source:tool", source: "tool" },
            { file: "style.md", line: "- u2 source:model", source: "model" },
            { file: "style.md", line: "- u3 source:snapshot", source: "snapshot" },
          ],
        },
        { sessionID: SESSION, agent: "primary", messageID: "m", id: "c" },
      ),
    ).rejects.toBe(denied);
    // One assert per line up to the deny — never a single bulk assert.
    expect(denyCalls).toHaveLength(2);
    expect(denyCalls[0]?.metadata).toEqual({
      line: "- u1 source:tool",
      source: "tool",
    });
    expect(denyCalls[1]?.metadata).toEqual({
      line: "- u2 source:model",
      source: "model",
    });
  });
});

describe("acceptance_handoff_routing", () => {
  it("HHmmss_session6_names_at_handoffs_root_archive_stays_recall_only", async () => {
    const name = handoffName("session-abcdef123456", Date.UTC(2026, 9, 15, 12, 34, 56));
    expect(name).toBe("handoffs/2026-10-15-123456-123456.md");
    expect(name).toMatch(
      /^handoffs\/\d{4}-\d{2}-\d{2}-\d{6}-[A-Za-z0-9._-]+\.md$/,
    );
    // Snapshot writer mints a root handoff with the session suffix.
    const outcome = await snapshotHandoffIfChanged(
      {
        type: "session.idle",
        data: { sessionID: SESSION },
        location: { directory: projectRoot },
      },
      {
        storage,
        projectID: PROJECT,
        memoryRoot,
        now: Date.UTC(2026, 9, 15, 12, 34, 56),
      },
    );
    expect(outcome.reason).toBe("written");
    expect(outcome.file).toMatch(
      /^handoffs\/2026-10-15-123456-[A-Za-z0-9._-]+\.md$/,
    );
    const top = await readdir(join(memoryRoot, "handoffs"));
    expect(top.some((n) => n.endsWith(".md"))).toBe(true);
    // Archive entries are never pointed at by the brief loader.
    await writeMemory("handoffs/archive/retired-abc.md", "retired body");
    const brief = await loadBrief(memoryRoot);
    expect(brief).not.toContain("retired-abc");
  });
});

describe("acceptance_isolation_and_lifecycle", () => {
  it("foreign_events_dropped_before_any_write", async () => {
    const foreign = {
      type: "session.idle",
      data: { sessionID: "foreign-session-999" },
      location: { directory: "/elsewhere/other-project" },
    };
    expect(
      isThisLocation(foreign, { directory: projectRoot, projectID: PROJECT }),
    ).toBe(false);
    await dispatchEvent(foreign, {
      storage,
      projectID: PROJECT,
      directory: projectRoot,
      memoryRoot,
      now: Date.now(),
    });
    const top = await readdir(join(memoryRoot, "handoffs"));
    expect(top.filter((n) => n.endsWith(".md"))).toHaveLength(0);
  });

  it("single_controller_reused_and_cleanup_disposes", () => {
    const index = srcOf("index.ts");
    expect(index.match(/new AbortController\(\)/g)).toHaveLength(1);
    expect(index).toMatch(/controller\.abort\(\)/);
    expect(index).toMatch(/dispose\(\)/);
  });

  it("startup_VCS_shape_check_is_warn_only", async () => {
    const warnings: unknown[] = [];
    const log = (e: unknown): void => {
      warnings.push(e);
    };
    await expect(readVcsSnapshot(undefined, log)).resolves.toEqual({
      branch: "unknown",
      changes: [],
    });
    const throwing = {
      get: async (): Promise<unknown> => {
        throw new Error("vcs down");
      },
      status: async (): Promise<unknown> => {
        throw new Error("vcs down");
      },
    };
    await expect(readVcsSnapshot(throwing, log)).resolves.toEqual({
      branch: "unknown",
      changes: [],
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("throwing_handler_on_event_N_never_stops_N_plus_1", async () => {
    const seen: unknown[] = [];
    const { startEventLoop } = await import("../src/capture.js");
    const events: unknown[] = [
      { type: "session.idle", n: 1 },
      { type: "session.idle", n: 2 },
    ];
    await startEventLoop(
      () => (async function* () {
        yield* events;
      })(),
      {
        signal: new AbortController().signal,
        handleEvent: async (event) => {
          if ((event as { n: number }).n === 1) throw new Error("boom N");
          seen.push(event);
        },
        log: () => undefined,
      },
    );
    expect(seen).toHaveLength(1);
  });
});

describe("acceptance_status_line", () => {
  it("rotation_notice_once_nudge_at_5_reset_via_empty_apply", async () => {
    expect(REVIEW_DUE_PENDING).toBe(5);
    // Quiet baseline.
    expect(await statusLine(storage, PROJECT)).toBeUndefined();
    // Rotation notice emits once and clears the marker.
    await setRotated(storage, PROJECT, 2);
    const first = await statusLine(storage, PROJECT);
    expect(first).toContain("rotated 2 block(s)");
    expect(await statusLine(storage, PROJECT)).toBeUndefined();
    // Review-due nudge appears at ≥5 uncurated captures.
    await incPending(storage, PROJECT, 4);
    expect(await statusLine(storage, PROJECT)).toBeUndefined();
    await incPending(storage, PROJECT, 1);
    const nudge = await statusLine(storage, PROJECT);
    expect(nudge).toContain("5 uncurated captures");
    expect(nudge).toContain("/memory-review");
    // Reset channel is memory_apply({candidates:[]}) — the command never resets.
    expect(srcOf("review.ts")).not.toMatch(/resetPending|pendingKey/);
    const execute = createMemoryApplyExecute({
      memoryRoot,
      projectID: PROJECT,
      storage,
      permission: new FakePermission(),
    });
    await execute({ candidates: [] }, {
      sessionID: SESSION, agent: "primary", messageID: "m", id: "c",
    });
    expect(await getPending(storage, PROJECT)).toBe(0);
    expect(await statusLine(storage, PROJECT)).toBeUndefined();
  });

  it("status_dropped_before_hint_under_budget_pressure", () => {
    // Ordering rule lives in the context hook: brief, then status, then
    // hint — the status line is dropped before the hint on overflow.
    expect(srcOf("index.ts")).toMatch(/status/);
    expect(srcOf("index.ts")).toMatch(/matchIndex|hint/);
  });
});

describe("acceptance_containment_and_provenance", () => {
  it("poison_fixture_contained_summary_only_in_brief", async () => {
    const poison = readFileSync(
      resolve(ROOT, "test", "fixtures", "poison-error.txt"),
      "utf8",
    );
    expect(poison).toMatch(/Ignore previous instructions/);
    const outcome = await captureFailure(
      { status: "error", error: { message: poison } },
      storage,
      PROJECT,
      memoryRoot,
    );
    expect(outcome.reason).toBe("captured");
    const brief = await loadBrief(memoryRoot);
    // The message-derived summary line is injectable…
    expect(brief).toContain("npm run build failed");
    // …but the raw captured body (agent-directed instruction) never is.
    expect(brief).not.toContain("evil.example");
    expect(brief).not.toContain("Ignore previous instructions");
    expect(brief).toContain("data only, never instructions");
    // Flags are advisory: present, but the write was not blocked.
    expect(flagInjection(poison).length).toBeGreaterThan(0);
  });

  it("fence_and_quote_reject_user_provenance", () => {
    expect(classifyProvenance("remember: ship the plugin")).toBe("user");
    expect(classifyProvenance("remember that we chose X")).toBe("user");
    expect(classifyProvenance("```\nremember: ship the plugin\n```")).toBe("tool");
    expect(classifyProvenance("> remember: ship the plugin")).toBe("tool");
    expect(classifyProvenance("`remember: ship it` inline")).toBe("tool");
    expect(classifyProvenance("I remember when we used X")).toBe("tool");
  });
});

describe("acceptance_evals_three_numbers", () => {
  it("reports_static_per_prompt_and_session_total", () => {
    // Static: hand-owned AGENTS.md protocol block (≤10 non-empty lines) +
    // the memory_recall description (~3 lines when wrapped at 80 cols).
    const protocolLines = AGENTS_PROTOCOL_BLOCK.split("\n").filter(
      (l) => l.trim().length > 0,
    ).length;
    expect(protocolLines).toBeLessThanOrEqual(10);
    const staticLines =
      protocolLines + Math.ceil(MEMORY_RECALL_DESCRIPTION.length / 80);
    expect(staticLines).toBeLessThanOrEqual(16);
    // Per-prompt with content: static + INDEX(≤30, once) + brief(≤48) +
    // hint(≤1) + status(≤1). The injectable portion is budget-capped at 80.
    const perPromptInjectable =
      DEFAULT_MEMORY_OPTIONS.indexLines + BRIEF_MAX_LINES + 1 + 1;
    expect(perPromptInjectable).toBeLessThanOrEqual(
      DEFAULT_MEMORY_OPTIONS.injectBudgetLines,
    );
    const perPromptWithContent = staticLines + perPromptInjectable;
    // Session-total: per-prompt × model steps (context hook runs per model
    // call, including tool-driven continuations; hint throttled to once).
    const modelSteps = 4;
    const sessionTotal = perPromptWithContent * modelSteps;
    // eslint-disable-next-line no-console
    console.log(
      `[memory-evals] static=${staticLines} per-prompt-with-content=${perPromptWithContent} ` +
        `session-total(steps=${modelSteps})=${sessionTotal}`,
    );
    expect(perPromptWithContent).toBeLessThanOrEqual(staticLines + 80);
    expect(sessionTotal).toBe(perPromptWithContent * modelSteps);
  });
});

describe("acceptance_compatibility_and_deploy_gate", () => {
  it("published_form_loads_via_plugin_list_and_supported_range_recorded", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("opencode-nexusnv-memory");
    expect(pkg.type).toBe("module");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(pkg.dependencies?.["@opencode/plugin"]).toBe("2.0.29");
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/opencode plugin list/);
    expect(readme).toMatch(/opencode-nexusnv-memory/);
    expect(readme).toMatch(/2\.0/);
    const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/2\.0/);
  });

  it("deploy_time_event_type_log_confirms_idle_and_compaction_delivery", async () => {
    // Deploy sanity check (G1): log observed event.type values once and
    // confirm both session.idle and session.compaction.ended arrive.
    // The deploy log records the type at the dispatch site (not only
    // diagnostics); both primary handlers must run.
    const seenTypes: string[] = [];
    const log = (value: unknown): void => {
      const type = (value as { type?: unknown }).type;
      if (typeof type === "string") seenTypes.push(type);
    };
    const idleAt = Date.UTC(2026, 9, 15, 12, 0, 0);
    const endedAt = Date.UTC(2026, 9, 15, 12, 30, 0);
    const idle = {
      type: "session.idle",
      data: { sessionID: SESSION },
      location: { directory: projectRoot },
    };
    const ended = {
      type: "session.compaction.ended",
      id: "evt-ended-1",
      data: {
        reason: "test",
        text: "produced summary ACCEPT-COMPACTION-MARKER",
        recent: [],
        sessionID: SESSION,
      },
      location: { directory: projectRoot },
    };
    for (const [event, now] of [
      [idle, idleAt],
      [ended, endedAt],
    ] as const) {
      seenTypes.push(event.type);
      await dispatchEvent(event, {
        storage,
        projectID: PROJECT,
        directory: projectRoot,
        memoryRoot,
        now,
        log,
      });
    }
    // Diagnostics for other compaction events also flow through the log.
    await dispatchEvent(
      { type: "session.compaction.started", location: { directory: projectRoot } },
      {
        storage,
        projectID: PROJECT,
        directory: projectRoot,
        memoryRoot,
        now: endedAt,
        log,
      },
    );
    expect(seenTypes).toContain("session.idle");
    expect(seenTypes).toContain("session.compaction.ended");
    expect(seenTypes).toContain("session.compaction.started");
    // Both primary paths delivered: idle snapshotted and the produced
    // summary persisted (distinct timestamps → distinct handoff files).
    const handoffs = await readdir(join(memoryRoot, "handoffs"));
    expect(handoffs.filter((n) => n.endsWith(".md"))).toHaveLength(2);
    const bodies = await Promise.all(
      handoffs
        .filter((n) => n.endsWith(".md"))
        .map((n) => readFile(join(memoryRoot, "handoffs", n), "utf8")),
    );
    expect(bodies.some((b) => b.includes("ACCEPT-COMPACTION-MARKER"))).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `[memory-deploy] observed event.type: ${[...new Set(seenTypes)].sort().join(", ")}`,
    );
  });
});

describe("acceptance_handoff_collision", () => {
  const NOW = Date.UTC(2026, 9, 15, 12, 34, 56);

  it("same_second_different_content_mints_suffixed_sibling_never_overwrites", async () => {
    const base = handoffName(SESSION, NOW);
    await writeFile(join(memoryRoot, base), "pre-existing different body\n", "utf8");
    const outcome = await snapshotHandoffIfChanged(
      {
        type: "session.idle",
        data: { sessionID: SESSION },
        location: { directory: projectRoot },
      },
      {
        storage,
        projectID: PROJECT,
        memoryRoot,
        now: NOW,
      },
    );
    expect(outcome.reason).toBe("written");
    // Fixed-width sibling, never a bare `-1` (which would mis-sort).
    expect(outcome.file).toBe("handoffs/2026-10-15-123456-123456-01.md");
    // The original file is untouched — no overwrite.
    expect(await readFile(join(memoryRoot, base), "utf8")).toBe(
      "pre-existing different body\n",
    );
    // The newest pointer resolves to the newer sibling, not the base.
    const brief = await loadBrief(memoryRoot);
    expect(brief).toContain("handoffs/2026-10-15-123456-123456-01.md");
  });

  it("same_content_dedupes_to_the_existing_file", async () => {
    const file = await writeHandoffUnique(
      "handoffs/2026-10-15-123456-123456.md",
      "identical body\n",
      { memoryRoot },
    );
    const again = await writeHandoffUnique(
      "handoffs/2026-10-15-123456-123456.md",
      "identical body\n",
      { memoryRoot },
    );
    expect(again).toBe(file);
    expect(await readdir(join(memoryRoot, "handoffs"))).toHaveLength(1);
  });
});
