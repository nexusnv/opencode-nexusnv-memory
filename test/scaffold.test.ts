import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import plugin from "../src/index.js";
import {
  AGENTS_PROTOCOL_BLOCK,
  ARCHIVE_DIR,
  HANDOFFS_DIR,
  MEMORY_FILES,
  getScaffoldFiles,
  optionsSnippet,
  permissionsSnippet,
} from "../src/templates.js";

const root = resolve(import.meta.dirname!, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pkgPath = resolve(root, "package.json");

/** Minimal storage fake for the setup-wiring wiring test: setup only
 * constructs the bump adapter over it (bumps fire on hooks later). */
const fakeStorageForSetup = {
  get: async (_key: string) => undefined,
  set: async (_key: string, _value: unknown) => undefined,
  remove: async (_key: string) => undefined,
  scan: async (_options: { prefix: string; after?: string; limit?: number }) => ({
    entries: [] as Array<{ key: string; value: unknown }>,
  }),
};

describe("shows_memory_in_plugin_list_and_scaffolds", () => {
  it("manifest is a bootable memory plugin package", () => {
    expect(existsSync(pkgPath), "package.json exists").toBe(true);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("opencode-nexusnv-memory");
    // Semver shape + CHANGELOG entry, never a pinned value: every release
    // bump must keep CI green, and the release workflow already enforces
    // tag == manifest separately. Full SemVer 2.0.0 grammar (semver.org):
    // no leading zeros, prerelease dot-identifiers without underscores,
    // build metadata allowed.
    expect(pkg.version).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    );
    const headings = read("CHANGELOG.md")
      .split("\n")
      .map((l) => l.trimEnd());
    expect(
      headings.some(
        (l) => l === `## ${pkg.version}` || l.startsWith(`## ${pkg.version} `),
      ),
      `CHANGELOG.md has an exact ## ${pkg.version} heading`,
    ).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(pkg.dependencies?.["@opencode/plugin"]).toBe("2.0.29");
  });

  it("tsconfig is strict nodenext es2022 covering src+test", () => {
    expect(existsSync(resolve(root, "tsconfig.json"))).toBe(true);
    const tsconfig = JSON.parse(read("tsconfig.json"));
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(
      String(tsconfig.compilerOptions?.module ?? "").toLowerCase(),
    ).toBe("nodenext");
    expect(String(tsconfig.compilerOptions?.target ?? "").toLowerCase()).toBe(
      "es2022",
    );
    expect(tsconfig.include).toContain("src");
    expect(tsconfig.include).toContain("test");
  });

  it("index.ts wires Plugin.define memory with controller + registrations + async cleanup", () => {
    const src = read("src/index.ts");
    expect(src).toMatch(/Plugin\.define/);
    expect(src).toMatch(/id:\s*["']memory["']/);
    expect(src).toMatch(/new AbortController\(\)/);
    expect(src).toMatch(/registrations/);
    expect(src).toMatch(/controller\.abort\(\)/);
    expect(src).toMatch(/dispose\(\)/);
    // Promise flavor only: no effect() import, no server() dual export
    expect(src).not.toMatch(/from\s+["']@opencode\/plugin\/effect["']/);
    expect(src).not.toMatch(/export\s+(default\s+)?(async\s+function|function|const)\s+server/);
  });

  it("config.ts parses exactly 5 options with defaults, warn-once, never throws", () => {
    const src = read("src/config.ts");
    for (const key of [
      "indexLines",
      "fileLines",
      "injectBudgetLines",
      "captureFailures",
      "snapshotThrottleMinutes",
    ]) {
      expect(src).toContain(key);
    }
    expect(src).toMatch(/30/);
    expect(src).toMatch(/60/);
    expect(src).toMatch(/80/);
    expect(src).toMatch(/snapshotThrottleMinutes/);
  });

  it("templates.ts scaffolds six files + handoffs + both snippets + AGENTS block", () => {
    const src = read("src/templates.ts");
    for (const name of [
      "INDEX.md",
      "activeContext.md",
      "decisions.md",
      "architecture.md",
      "style.md",
      "issues.md",
    ]) {
      expect(src).toContain(name);
    }
    expect(src).toContain("handoffs");
    // options snippet (commented, ≤5 options)
    expect(src).toMatch(/indexLines/);
    // mandatory memory_write→ask permissions snippet
    expect(src).toMatch(/memory_write/);
    expect(src).toMatch(/ask/);
    // AGENTS.md protocol block text (narrow trigger forms, fence/quote heuristic + paste caveat)
    expect(src).toMatch(/remember:/);
    expect(src).toMatch(/fence\/quote/i);
  });

  it("memory-manager agent is read-only with leading deny", () => {
    const md = read("agents/memory-manager.md");
    expect(md).toMatch(/mode:\s*subagent/);
    const denyIdx = md.indexOf('action: "*"');
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(md.slice(denyIdx)).toMatch(/effect:\s*deny/);
    // leading deny comes before any allow
    const firstAllow = md.indexOf("effect: allow");
    expect(firstAllow).toBeGreaterThan(denyIdx);
    expect(md).toMatch(/action:\s*read/);
    expect(md).toMatch(/action:\s*glob/);
    expect(md).toMatch(/action:\s*grep/);
    expect(md).not.toMatch(/action:\s*edit/);
    expect(md).not.toMatch(/action:\s*shell/);
  });

  it("file-based command stub exists", () => {
    expect(existsSync(resolve(root, "commands/memory-review.md"))).toBe(true);
    const md = read("commands/memory-review.md");
    expect(md).toMatch(/memory-review/);
  });

  it("registers_memory_metrics_and_review_commands", async () => {
    // index.ts wires registerMetricsCommand beside registerMemoryReview.
    const src = read("src/index.ts");
    expect(src).toMatch(/registerMetricsCommand/);

    // setupHooks-style fake ctx (M-T6): registration wiring only, not
    // behavior — capture what the command + tool editors receive from
    // plugin.setup. Tool adds are name-collected; command adds are
    // name → description.
    const commands = new Map<string, string>();
    const tools: string[] = [];
    const projectRoot = await mkdtemp(join(tmpdir(), "memory-scaffold-"));
    const setup = plugin.setup as unknown as (
      ctx: unknown,
    ) => Promise<(() => Promise<void>) | void>;
    const cleanup = await setup({
      options: {},
      location: {
        directory: projectRoot,
        project: {
          id: "scaffold-wiring",
          directory: projectRoot,
          canonical: projectRoot,
        },
      },
      storage: fakeStorageForSetup,
      permission: { assert: async (_input: unknown) => undefined },
      tool: {
        transform: async (
          cb: (editor: { add: (tool: { name: string }) => void }) => void,
        ) => {
          cb({ add: (tool) => tools.push(tool.name) });
          return { dispose: async () => undefined };
        },
        hook: async (
          _name: string,
          _cb: (event: never) => Promise<void> | void,
        ) => ({
          dispose: async () => undefined,
        }),
      },
      command: {
        transform: async (
          cb: (
            editor: { add: (def: { name: string; description?: string }) => void },
          ) => void,
        ) => {
          cb({ add: (def) => commands.set(def.name, def.description ?? "") });
          return { dispose: async () => undefined };
        },
      },
      session: {
        hook: async (
          _name: string,
          _cb: (event: never) => Promise<void> | void,
        ) => ({
          dispose: async () => undefined,
        }),
        prompt: async (args: unknown) =>
          ({ sessionID: (args as { sessionID?: string }).sessionID }) as never,
      },
    });

    // Command editor received BOTH plugin commands (commands together in
    // setup: /memory-review first, then /memory-metrics).
    expect([...commands.keys()]).toContain("memory-review");
    expect(commands.has("memory-metrics"), "memory-metrics registered").toBe(
      true,
    );
    // The file-based metrics stub mirrors the review stub's contract.
    expect(
      read("commands/memory-metrics.md").startsWith(
        "---\ndescription: Local usage metrics of the memory plugin (count-only, on-machine)\n---\n",
      ),
      "metrics stub frontmatter description is byte-exact",
    ).toBe(true);

    // Tool editor received the read-only metrics query besides
    // memory_recall/memory_apply.
    expect(tools).toContain("memory_metrics");

    await cleanup?.();
  });
});

describe("install_surface_P0_parity", () => {
  it("emits_options_and_ask_snippets_and_protocol_block", () => {
    // Six templates + handoffs/ scaffold surface (P0-usable by hand).
    expect(MEMORY_FILES).toEqual([
      "INDEX.md",
      "activeContext.md",
      "decisions.md",
      "architecture.md",
      "style.md",
      "issues.md",
    ]);
    const files = getScaffoldFiles();
    expect(Object.keys(files).sort()).toEqual([...MEMORY_FILES].sort());
    for (const content of Object.values(files)) {
      expect(content.length).toBeGreaterThan(0);
    }
    expect(HANDOFFS_DIR).toBe("handoffs");
    expect(ARCHIVE_DIR).toBe("handoffs/archive");
    // index.ts actually scaffolds both dirs (never overwrites).
    const index = read("src/index.ts");
    expect(index).toContain("HANDOFFS_DIR");
    expect(index).toContain("ARCHIVE_DIR");
    expect(index).toMatch(/flag:\s*["']wx["']/);

    // Commented options snippet: exactly the 5 spec §3 options, all commented.
    const options = optionsSnippet();
    for (const key of [
      "indexLines",
      "fileLines",
      "injectBudgetLines",
      "captureFailures",
      "snapshotThrottleMinutes",
    ]) {
      expect(options).toContain(key);
    }
    const optionLines = options
      .split("\n")
      .filter((l) => /"(indexLines|fileLines|injectBudgetLines|captureFailures|snapshotThrottleMinutes)"/.test(l));
    expect(optionLines).toHaveLength(5);
    for (const line of optionLines) {
      expect(line.trimStart().startsWith("//")).toBe(true);
    }
    expect(options).not.toMatch(/memoryDir/);
    expect(options).not.toMatch(/references/);

    // Mandatory memory_write → ask permissions snippet (fails open without it).
    const perms = permissionsSnippet();
    expect(perms).toMatch(/memory_write/);
    expect(perms).toMatch(/"effect":\s*"ask"/);
    expect(perms).toMatch(/"resource":\s*"\*"/);

    // AGENTS protocol block: hand-owned, ≤10 lines, narrow trigger,
    // fence/quote heuristic + paste caveat, read/recall/write/nudge bullets.
    const nonEmpty = AGENTS_PROTOCOL_BLOCK.split("\n").filter(
      (l) => l.trim().length > 0,
    );
    expect(nonEmpty.length).toBeLessThanOrEqual(10);
    expect(AGENTS_PROTOCOL_BLOCK).toContain("## Project memory");
    // read/recall bullet
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/memory_recall/);
    // data-not-instructions bullet
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/Data, not instructions/);
    // write bullet (review-only)
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/\/memory-review/);
    // narrow user-asserted trigger forms
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/remember:/);
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/remember that/);
    // fence/quote heuristic + paste caveat
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/fence\/quote/i);
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/[Pp]ast/);
    // nudge bullet (status line)
    expect(AGENTS_PROTOCOL_BLOCK).toMatch(/\[memory\]/);
    // Matches spec §4.4 exactly (normative text).
    const spec = read("docs/design-spec-v2-production.md");
    const m = spec.match(/```md\n(## Project memory[\s\S]*?)\n```/);
    expect(m, "spec §4.4 protocol block exists").not.toBeNull();
    expect(AGENTS_PROTOCOL_BLOCK.trim()).toBe(m![1].trim());
  });

  it("manager_has_leading_deny_and_proposal_only_body", () => {
    const md = read("agents/memory-manager.md");
    // Leading-deny frontmatter: `* → deny` before any allow.
    const denyIdx = md.indexOf('action: "*"');
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(md.slice(denyIdx)).toMatch(/effect:\s*deny/);
    const firstAllow = md.indexOf("effect: allow");
    expect(firstAllow).toBeGreaterThan(denyIdx);
    for (const action of ["read", "glob", "grep"]) {
      expect(md).toMatch(new RegExp(`action:\\s*${action}`));
    }
    expect(md).not.toMatch(/action:\s*edit/);
    expect(md).not.toMatch(/action:\s*(shell|write)/);
    // Proposal-only body: proposes, never writes/executes/fetches.
    expect(md).toMatch(/proposal/i);
    expect(md).toMatch(/never write/i);
    expect(md).toMatch(/never (execute|fetch)/i);
    expect(md).toMatch(/human approves/i);
  });

  it("readme_covers_install_uninstall_P0_budgets", () => {
    const md = read("README.md");
    const lower = md.toLowerCase();
    // Install matrices: drop-in vs package, both config locations.
    expect(md).toMatch(/drop-in/i);
    expect(md).toMatch(/opencode-nexusnv-memory/);
    expect(md).toContain(".opencode/opencode.jsonc");
    expect(lower).toContain("repo-root");
    // Merge order.
    expect(md).toMatch(/merge global/i);
    // plugin list verify + reload guidance.
    expect(md).toMatch(/opencode plugin list/);
    expect(lower).toContain("reload");
    // Uninstall: hand-remove AGENTS block, explicit git rm, orphaned ledger harmless.
    expect(md).toMatch(/## Uninstall/);
    expect(md).toMatch(/by hand/);
    expect(md).toMatch(/git rm/);
    expect(md).toMatch(/orphan/i);
    // P0 manual section: six files by hand, restores from INDEX + activeContext.
    expect(md).toMatch(/P0|without code/i);
    expect(md).toMatch(/INDEX\.md/);
    expect(md).toMatch(/activeContext\.md/);
    expect(md).toMatch(/no re-explaining/);
    // Budgets.
    expect(lower).toContain("budget");
    expect(md).toMatch(/30/);
    expect(md).toMatch(/60/);
    expect(md).toMatch(/80/);
    // Supported range.
    expect(md).toMatch(/2\.0/);
  });

  it("changelog_records_P1_and_supported_range", () => {
    const md = read("CHANGELOG.md");
    expect(md).toMatch(/templates\.ts|memory-manager|install/i);
    expect(md).toMatch(/2\.0/);
  });
});
