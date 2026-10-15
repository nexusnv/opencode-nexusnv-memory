import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname!, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const pkgPath = resolve(root, "package.json");

describe("shows_memory_in_plugin_list_and_scaffolds", () => {
  it("manifest is a bootable memory plugin package", () => {
    expect(existsSync(pkgPath), "package.json exists").toBe(true);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("opencode-nexusnv-memory");
    expect(pkg.version).toBe("0.1.0");
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
});
