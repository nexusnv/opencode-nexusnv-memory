import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEARCH_DEFAULT_RESULTS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_LINE_CHARS,
  SEARCH_MAX_RESULTS,
  renderSearchResults,
  searchMemory,
} from "../src/search.js";
import { SEARCH_FILE_BYTES } from "../src/files.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-search-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function put(file: string, text: string): Promise<void> {
  const abs = join(root, file);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text);
}

describe("searchMemory", () => {
  it("finds an old decision beyond the recall tail", async () => {
    await put(
      "decisions.md",
      [
        "filler-1",
        "filler-2",
        "filler-3",
        "filler-4",
        "needle-at-line-5",
        ...Array.from({ length: 200 }, (_, i) => `filler-${i + 5}`),
      ].join("\n"),
    );

    const result = await searchMemory({
      memoryRoot: root,
      query: "needle-at-line-5",
    });
    expect(result.matches).toEqual([
      { file: "decisions.md", line: 5, text: "needle-at-line-5" },
    ]);
    expect(result.matched).toBe(1);
  });

  it("is literal and case-insensitive by default", async () => {
    await put("decisions.md", "Alpha.Beta\nAlphaXBeta\nalpha.beta");

    const insensitive = await searchMemory({
      memoryRoot: root,
      query: "alpha.beta",
    });
    expect(insensitive.matches.map((m) => m.line)).toEqual([1, 3]);

    const sensitive = await searchMemory({
      memoryRoot: root,
      query: "alpha.beta",
      caseSensitive: true,
    });
    expect(sensitive.matches.map((m) => m.line)).toEqual([3]);
  });

  it("searches structural files, then handoffs, then archive in deterministic order", async () => {
    await put("INDEX.md", "shared\n");
    await put("style.md", "shared\n");
    await put("handoffs/2026-10-18-120000-aaaaaa.md", "shared older\n");
    await put("handoffs/2026-10-19-120000-bbbbbb.md", "shared newer\n");
    await put(
      "handoffs/archive/2026-10-17-120000-cccccc.md",
      "shared archived\n",
    );

    const result = await searchMemory({ memoryRoot: root, query: "shared" });
    expect(result.matches.map((m) => m.file)).toEqual([
      "INDEX.md",
      "style.md",
      "handoffs/2026-10-19-120000-bbbbbb.md",
      "handoffs/2026-10-18-120000-aaaaaa.md",
      "handoffs/archive/2026-10-17-120000-cccccc.md",
    ]);
  });

  it("scopes to one allowlisted file", async () => {
    await put("style.md", "shared\n");
    await put("decisions.md", "shared\n");

    const result = await searchMemory({
      memoryRoot: root,
      query: "shared",
      file: "style.md",
    });
    expect(result.matches.map((m) => m.file)).toEqual(["style.md"]);
    expect(result.filesTotal).toBe(1);
  });

  it("rejects unknown and traversal scopes", async () => {
    for (const file of [
      "../INDEX.md",
      "/etc/passwd",
      "random.md",
      "handoffs",
    ]) {
      await expect(
        searchMemory({ memoryRoot: root, query: "x", file }),
      ).rejects.toThrow(/rejected/);
    }
  });

  it("bounds results but reports the true match count", async () => {
    await put(
      "decisions.md",
      Array.from({ length: 30 }, (_, i) => `hit-${i + 1}`).join("\n"),
    );
    const result = await searchMemory({
      memoryRoot: root,
      query: "hit-",
      maxResults: 5,
    });
    expect(result.matches).toHaveLength(5);
    expect(result.matched).toBe(30);
    const text = renderSearchResults(result);
    expect(text).toContain("showing 5 of 30 match(es) in 1 file(s)");
  });

  it("clamps maxResults and uses the default for invalid values", async () => {
    await put(
      "decisions.md",
      Array.from({ length: 60 }, (_, i) => `hit-${i + 1}`).join("\n"),
    );
    const clamped = await searchMemory({
      memoryRoot: root,
      query: "hit-",
      maxResults: 999,
    });
    expect(clamped.matches).toHaveLength(SEARCH_MAX_RESULTS);

    const fallback = await searchMemory({
      memoryRoot: root,
      query: "hit-",
      maxResults: 0,
    });
    expect(fallback.matches).toHaveLength(SEARCH_DEFAULT_RESULTS);
  });

  it("redacts before matching", async () => {
    await put(
      "decisions.md",
      "before\n<private>\nsecret-value\n</private>\nafter",
    );
    const result = await searchMemory({
      memoryRoot: root,
      query: "secret-value",
    });
    expect(result.matches).toEqual([]);
    expect(result.matched).toBe(0);
  });

  it("skips missing files in the default scope, but a scoped miss is an error", async () => {
    const empty = await searchMemory({ memoryRoot: root, query: "anything" });
    expect(empty.matches).toEqual([]);
    expect(empty.filesScanned).toBe(0);
    expect(empty.filesTotal).toBe(6);

    await expect(
      searchMemory({ memoryRoot: root, query: "x", file: "style.md" }),
    ).rejects.toThrow("[memory] memory file not found: style.md");
  });

  it("trims and bounds the matched line text", async () => {
    const long = `${"x".repeat(SEARCH_MAX_LINE_CHARS + 50)}match`;
    await put("issues.md", `   ${long}   `);
    const result = await searchMemory({ memoryRoot: root, query: "match" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.text.endsWith("...")).toBe(true);
    expect(result.matches[0]!.text.length).toBe(SEARCH_MAX_LINE_CHARS + 3);
  });

  it("reports the byte guard when a file is too large to search in full", async () => {
    await put(
      "decisions.md",
      `${"a".repeat(SEARCH_FILE_BYTES)}needle-after-guard`,
    );
    const result = await searchMemory({
      memoryRoot: root,
      query: "needle-after-guard",
    });
    expect(result.matches).toEqual([]);
    expect(result.truncatedFiles).toBe(1);
    expect(renderSearchResults(result)).toContain("read guard");
  });

  it("reports candidate-file truncation at the file cap", async () => {
    for (const file of [
      "INDEX.md",
      "activeContext.md",
      "decisions.md",
      "architecture.md",
      "style.md",
      "issues.md",
    ]) {
      await put(file, "hit\n");
    }
    for (let i = 0; i < SEARCH_MAX_FILES + 5; i += 1) {
      const stamp = String(i).padStart(6, "0");
      await put(`handoffs/2026-10-19-${stamp}-aaaaaa.md`, "hit\n");
    }
    const result = await searchMemory({ memoryRoot: root, query: "hit" });
    expect(result.filesTruncated).toBe(true);
    expect(result.filesTotal).toBe(6 + SEARCH_MAX_FILES + 5);
    expect(result.filesScanned).toBe(SEARCH_MAX_FILES);
    expect(renderSearchResults(result)).toContain("candidate file(s)");
  });

  it("rejects an empty query", async () => {
    await expect(
      searchMemory({ memoryRoot: root, query: "" }),
    ).rejects.toThrow("[memory] memory_search query must be a non-empty string");
    await expect(
      searchMemory({ memoryRoot: root, query: "   " }),
    ).rejects.toThrow("[memory] memory_search query must be a non-empty string");
  });
});

describe("renderSearchResults", () => {
  it("renders the header, matches, and footer; sanitizes the query", () => {
    const text = renderSearchResults({
      query: "a\nb",
      caseSensitive: false,
      matches: [{ file: "decisions.md", line: 3, text: "a b" }],
      matched: 1,
      filesScanned: 1,
      filesTotal: 1,
      filesTruncated: false,
      truncatedFiles: 0,
    });
    expect(text.split("\n")[0]).toBe(
      '[memory] search "a b" (literal, case-insensitive)',
    );
    expect(text).toContain("- decisions.md:3: a b");
    expect(text).toContain("showing 1 of 1 match(es) in 1 file(s)");
  });

  it("renders an explicit empty result", () => {
    const text = renderSearchResults({
      query: "absent",
      caseSensitive: true,
      matches: [],
      matched: 0,
      filesScanned: 4,
      filesTotal: 6,
      filesTruncated: false,
      truncatedFiles: 0,
    });
    expect(text).toContain("(no matches)");
    expect(text).toContain("showing 0 of 0 match(es) in 4 file(s)");
    expect(text.split("\n")[0]).toContain("case-sensitive");
  });
});
