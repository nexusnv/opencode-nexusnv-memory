import { describe, expect, it, beforeEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEARCH_FILE_BYTES,
  readCapped,
  readFullRedacted,
  updateCapped,
  writeCapped,
  withWriteLock,
} from "../src/files.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memory-files-"));
});

const opts = () => ({ memoryRoot: root });

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join("\n");
}

describe("rejects_traversal_and_enforces_caps", () => {
  it("rejects traversal, absolute, backslash and encoded escapes", async () => {
    const bad = [
      "../INDEX.md",
      "..\\INDEX.md",
      "/absolute.md",
      "handoffs/../../etc/passwd",
      "handoffs\\evil.md",
      "..%2fINDEX.md",
      "%2e%2e/INDEX.md",
      "handoffs/%2e%2e/INDEX.md",
      "INDEX%2f.md",
      "handoffs/%5cevil.md",
      "%252e%252e/INDEX.md",
      "handoffs/sub/dir.md",
      "",
    ];
    for (const file of bad) {
      await expect(readCapped(file, opts()), `read ${file}`).rejects.toThrow();
      await expect(
        writeCapped(file, "x", opts()),
        `write ${file}`,
      ).rejects.toThrow();
    }
  });

  it("rejects non-allowlisted names but allows handoff pattern", async () => {
    await expect(readCapped("random.md", opts())).rejects.toThrow();
    await expect(writeCapped("random.md", "x", opts())).rejects.toThrow();
    await expect(
      readCapped("handoffs/bad name!.md", opts()),
    ).rejects.toThrow();

    await writeCapped("handoffs/2026-10-15-120000-abcdef.md", "ok", opts());
    const out = await readCapped(
      "handoffs/2026-10-15-120000-abcdef.md",
      opts(),
    );
    expect(out).toContain("ok");

    await writeCapped("handoffs/archive/rotated-123.md", "archived", opts());
    expect(await readCapped("handoffs/archive/rotated-123.md", opts())).toContain(
      "archived",
    );
  });

  it("lists valid paths in the non-allowlisted rejection", async () => {
    await expect(readCapped("random.md", opts())).rejects.toThrow(
      /rejected non-allowlisted path: random\.md; valid: .*issues\.md.*handoffs\/<name>\.md/,
    );
  });

  it("reports missing files with a recovery hint", async () => {
    await expect(readCapped("style.md", opts())).rejects.toThrow(
      "[memory] memory file not found: style.md",
    );
    await expect(
      readCapped("handoffs/2026-10-15-120000-abcdef.md", opts()),
    ).rejects.toThrow(
      /not found: handoffs\/2026-10-15-120000-abcdef\.md; list available files with memory_recall\("handoffs"\)/,
    );
  });

  it("enforces INDEX cap on write and truncates with notice on read", async () => {
    await writeCapped("INDEX.md", lines(30), opts());
    await expect(writeCapped("INDEX.md", lines(31), opts())).rejects.toThrow();

    // Over-cap hand-edit bypasses writeCapped; readCapped truncates with notice.
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "INDEX.md"), lines(35));
    const out = await readCapped("INDEX.md", opts());
    expect(out.toLowerCase()).toContain("[truncated");
    const contentLines = out
      .split("\n")
      .filter((l) => l.length > 0 && !l.includes("[truncated"));
    expect(contentLines.length).toBeLessThanOrEqual(30);
    expect(out).toContain("line-1");
  });

  it("enforces per-file caps on rule files and handoffs", async () => {
    await expect(writeCapped("style.md", lines(61), opts())).rejects.toThrow();
    await writeCapped("style.md", lines(60), opts());
    await expect(
      writeCapped("handoffs/2026-10-15-120000-abcdef.md", lines(61), opts()),
    ).rejects.toThrow();
    // decisions.md is append-only unbounded: no write cap.
    await writeCapped("decisions.md", lines(200), opts());
    const tail = await readCapped("decisions.md", opts());
    expect(tail.toLowerCase()).toContain("[truncated");
    expect(tail).toContain("line-200");
  });

  it("rotates oldest Known-Errors block instead of throwing for activeContext", async () => {
    const headLines = [
      "# Active context",
      "",
      "## Goal",
      "- g",
      "",
      "## Known errors",
    ];
    const block1 = ["- err-one source:tool", "  detail-one", "  more-one"];
    const block2 = ["- err-two source:tool", "  detail-two"];
    const fillerCount = 60 - headLines.length - block1.length - block2.length;
    expect(fillerCount).toBeGreaterThan(0);
    const filler = Array.from(
      { length: fillerCount },
      (_, i) => `- filler-${i}`,
    );
    const base = [...headLines, ...block1, ...block2, ...filler].join("\n");
    expect(base.split("\n").length).toBe(60);
    await writeCapped("activeContext.md", base, opts());

    const over = `${base}\n- one-more-line-to-push-over-cap`;
    // Sanity: this must be over the 60-line cap.
    expect(over.split("\n").length).toBeGreaterThan(60);
    await writeCapped("activeContext.md", over, opts());

    const after = await readCapped("activeContext.md", opts());
    expect(after.split("\n").length).toBeLessThanOrEqual(61 + 2); // cap + notice slop
    expect(after.toLowerCase()).not.toContain("[truncated");
    expect(after).not.toContain("err-one");
    expect(after).toContain("err-two");

    const archived = await readdir(join(root, "handoffs/archive"));
    expect(archived.length).toBeGreaterThanOrEqual(1);
    const archivedContent = await readFile(
      join(root, "handoffs/archive", archived[0]!),
      "utf8",
    );
    expect(archivedContent).toContain("err-one");
  });

  it("redacts secrets on write and read", async () => {
    await writeCapped(
      "style.md",
      "rule one\nkey AKIAIOSFODNN7EXAMPLE\n",
      opts(),
    );
    const out = await readCapped("style.md", opts());
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.toLowerCase()).toContain("[redacted");
  });

  it("serializes concurrent writes via the per-process mutex", async () => {
    expect(typeof withWriteLock).toBe("function");
    await writeCapped("style.md", lines(5, "base"), opts());
    // Two overlapping writeCapped calls must serialize (no interleave/corruption).
    const a = writeCapped("style.md", lines(5, "A"), opts());
    const b = writeCapped("style.md", lines(5, "B"), opts());
    await Promise.all([a, b]);
    const out = await readCapped("style.md", opts());
    // Chain order = call order, so the second write wins intact.
    expect(out).toContain("B-1");
    expect(out).not.toContain("A-1");
  });
});

describe("updateCapped_atomic_append", () => {
  it("concurrent appends all land with no lost entries", async () => {
    await writeCapped("activeContext.md", "# ctx\n", opts());
    const append = (tag: string) =>
      updateCapped(
        "activeContext.md",
        opts(),
        (current) => `${current}- entry-${tag}\n`,
      );
    await Promise.all([
      append("a"),
      append("b"),
      append("c"),
      append("d"),
      append("e"),
    ]);
    const out = await readCapped("activeContext.md", opts());
    for (const tag of ["a", "b", "c", "d", "e"]) {
      expect(out, `missing entry-${tag}`).toContain(`entry-${tag}`);
    }
  });

  it("updater observes the latest content (no stale-base overwrite)", async () => {
    await writeCapped("issues.md", "- one\n", opts());
    await Promise.all([
      updateCapped("issues.md", opts(), (c) => `${c}- two\n`),
      updateCapped("issues.md", opts(), (c) => `${c}- three\n`),
    ]);
    const out = await readCapped("issues.md", opts());
    expect(out).toContain("- one");
    expect(out).toContain("- two");
    expect(out).toContain("- three");
  });
});

describe("readFullRedacted (memory_search support)", () => {
  it("returns decisions.md in full instead of the recall tail", async () => {
    const body = [
      "oldest-marker",
      ...Array.from({ length: 199 }, (_, i) => `line-${i + 2}`),
    ].join("\n");
    await writeCapped("decisions.md", body, opts());

    const full = await readFullRedacted("decisions.md", opts());
    expect(full).toBeDefined();
    expect(full!.text).toContain("oldest-marker");
    expect(full!.text).toContain("line-200");
    expect(full!.truncated).toBe(false);

    // The contrast with recall: the tail cap drops the oldest marker.
    const tail = await readCapped("decisions.md", opts());
    expect(tail).not.toContain("oldest-marker");
  });

  it("applies redaction to the full text", async () => {
    await writeFile(
      join(root, "decisions.md"),
      "before\n<private>\nsecret-value\n</private>\nafter",
    );
    const full = await readFullRedacted("decisions.md", opts());
    expect(full!.text).not.toContain("secret-value");
    expect(full!.text).toContain("before");
    expect(full!.text).toContain("after");
    // The private block is replaced line-for-line, not collapsed, so search
    // hit locations still match the on-disk file.
    expect(full!.text.split("\n")).toHaveLength(5);
  });

  it("rejects symlinks that escape the memory root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "memory-files-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "outside-secret");
      await symlink(join(outside, "secret.md"), join(root, "style.md"));
      await expect(readFullRedacted("style.md", opts())).rejects.toThrow(
        /symlink escape/,
      );
      await expect(readCapped("style.md", opts())).rejects.toThrow(
        /symlink escape/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows a symlink that stays inside the memory root", async () => {
    await writeFile(join(root, "architecture.md"), "inside-target\n");
    await symlink(join(root, "architecture.md"), join(root, "issues.md"));
    const full = await readFullRedacted("issues.md", opts());
    expect(full!.text).toContain("inside-target");
  });

  it("rejects a symlinked directory that escapes the memory root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "memory-files-outside-dir-"));
    try {
      await mkdir(join(outside, "handoffs"), { recursive: true });
      await writeFile(
        join(outside, "handoffs", "2026-10-19-000000-aaaaaa.md"),
        "outside-secret",
      );
      await symlink(join(outside, "handoffs"), join(root, "handoffs"));
      await expect(
        readFullRedacted("handoffs/2026-10-19-000000-aaaaaa.md", opts()),
      ).rejects.toThrow(/symlink escape/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows a memory root that is itself a symlink", async () => {
    await writeFile(join(root, "decisions.md"), "root-link-target\n");
    const linkRoot = await mkdtemp(join(tmpdir(), "memory-files-root-link-"));
    await rm(linkRoot, { recursive: true, force: true });
    await symlink(root, linkRoot);
    try {
      const full = await readFullRedacted("decisions.md", {
        memoryRoot: linkRoot,
      });
      expect(full!.text).toContain("root-link-target");
    } finally {
      await rm(linkRoot, { force: true });
    }
  });

  it("uses the same allowlist and traversal choke point", async () => {
    for (const file of [
      "../INDEX.md",
      "/etc/passwd",
      "random.md",
      "handoffs/sub/dir.md",
    ]) {
      await expect(
        readFullRedacted(file, opts()),
        `read ${file}`,
      ).rejects.toThrow();
    }
    await expect(readFullRedacted("handoffs", opts())).rejects.toThrow(
      /rejected non-allowlisted path/,
    );
  });

  it("reports a missing file unless the caller asks to skip", async () => {
    await expect(readFullRedacted("style.md", opts())).rejects.toThrow(
      "[memory] memory file not found: style.md",
    );
    await expect(
      readFullRedacted("style.md", { ...opts(), onMissing: "skip" }),
    ).resolves.toBeUndefined();
    await expect(
      readFullRedacted("handoffs/2026-10-15-120000-abcdef.md", {
        ...opts(),
        onMissing: "skip",
      }),
    ).resolves.toBeUndefined();
  });

  it("guards oversized files at the byte limit and reports truncation", async () => {
    await writeFile(
      join(root, "decisions.md"),
      `${"x".repeat(SEARCH_FILE_BYTES)}needle-after-guard`,
    );
    const full = await readFullRedacted("decisions.md", opts());
    expect(full!.truncated).toBe(true);
    expect(full!.text).not.toContain("needle-after-guard");
    expect(full!.text.length).toBeLessThanOrEqual(SEARCH_FILE_BYTES);
  });

  it("drops an incomplete final line at the byte guard", async () => {
    const head = `${"x".repeat(SEARCH_FILE_BYTES - 20)}\n`;
    await writeFile(
      join(root, "decisions.md"),
      `${head}https://user:SuperSecretPW@host`,
    );
    const full = await readFullRedacted("decisions.md", opts());
    expect(full!.truncated).toBe(true);
    // The cut lands inside the URL; the partial line must not survive,
    // because redaction cannot see the `@` that would identify the password.
    expect(full!.text).not.toContain("https://");
    expect(full!.text).not.toContain("SuperSecretPW");
    expect(full!.text.length).toBeLessThanOrEqual(SEARCH_FILE_BYTES);
  });
});
