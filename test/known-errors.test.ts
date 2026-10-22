import { describe, expect, it } from "vitest";
import {
  knownErrorBlockRanges,
  splitKnownErrorSections,
} from "../src/known-errors.js";

describe("shared Known-Errors parser", () => {
  it("keeps heading blocks together and preserves later sections as context", () => {
    const lines = [
      "# Active",
      "",
      "## Known errors",
      "- first source:tool",
      "  detail",
      "",
      "  more detail",
      "## Next",
      "- ship",
    ];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks).toHaveLength(1);
    expect(split.blocks[0]!.lines).toEqual([
      "- first source:tool",
      "  detail",
      "",
      "  more detail",
    ]);
    expect(split.contextLines).toContain("- ship");
  });

  it("finds source:tool blocks without a heading and keeps whitespace-only detail", () => {
    const lines = [
      "# Active",
      "- failure source:tool",
      "  first detail",
      "  ",
      "  SECRET-AFTER-BLANK",
      "- keep",
    ];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks).toHaveLength(1);
    expect(split.blocks[0]!.lines).toContain("  SECRET-AFTER-BLANK");
    expect(split.contextLines).toEqual(["# Active", "- keep"]);
    expect(knownErrorBlockRanges(lines)).toEqual([{ start: 1, end: 5 }]);
  });

  it("ends a no-heading block at a column-0 heading", () => {
    const lines = ["- failure source:tool", "  detail", "## Next", "- ship"];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks[0]!.lines).toEqual([
      "- failure source:tool",
      "  detail",
    ]);
    expect(split.contextLines).toEqual(["## Next", "- ship"]);
  });

  it("ignores an indented fake heading inside captured detail", () => {
    const lines = [
      "# Active",
      "- failure source:tool",
      "  detail before fake heading",
      "  ## Known errors",
      "  SECRET-DETAIL-AFTER-FAKE-HEADING",
      "- keep",
    ];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks).toHaveLength(1);
    expect(split.blocks[0]!.lines).toEqual([
      "- failure source:tool",
      "  detail before fake heading",
      "  ## Known errors",
      "  SECRET-DETAIL-AFTER-FAKE-HEADING",
    ]);
    expect(split.contextLines).toEqual(["# Active", "- keep"]);
  });

  it("keeps an orphaned block before a real heading out of context", () => {
    const lines = [
      "- old failure source:tool",
      "  SECRET-ORPHANED-DETAIL",
      "## Known errors",
      "- new failure source:tool",
      "  new detail",
    ];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks).toHaveLength(2);
    expect(split.blocks[0]!.lines).toContain("  SECRET-ORPHANED-DETAIL");
    expect(split.contextLines.join("\n")).not.toContain(
      "SECRET-ORPHANED-DETAIL",
    );
    expect(knownErrorBlockRanges(lines)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it("recognizes a BOM-prefixed heading and BOM-prefixed no-heading block", () => {
    const withHeading = splitKnownErrorSections([
      "\uFEFF## Known errors",
      "- failure source:tool",
      "  detail",
    ]);
    expect(withHeading.blocks).toHaveLength(1);
    expect(withHeading.contextLines).toEqual([]);

    const withoutHeading = splitKnownErrorSections([
      "\uFEFF- failure source:tool",
      "  SECRET-BOM-DETAIL",
    ]);
    expect(withoutHeading.blocks).toHaveLength(1);
    expect(withoutHeading.blocks[0]!.lines).toContain("  SECRET-BOM-DETAIL");
    expect(withoutHeading.contextLines).toEqual([]);
  });

  it("hides text under a heading even when no bullet block exists", () => {
    const lines = [
      "# Active",
      "## Known errors",
      "  SECRET-NO-BULLET-DETAIL",
      "## Next",
      "- ship",
    ];
    const split = splitKnownErrorSections(lines);
    expect(split.blocks).toEqual([]);
    expect(split.contextLines).toEqual(["# Active", "## Next", "- ship"]);
    expect(split.contextLines.join("\n")).not.toContain("SECRET-NO-BULLET");
  });

  it("preserves input exactly when no block is recognized", () => {
    const lines = ["# Active", "", "- keep", ""];
    expect(splitKnownErrorSections(lines)).toEqual({
      contextLines: lines,
      blocks: [],
    });
  });
});
