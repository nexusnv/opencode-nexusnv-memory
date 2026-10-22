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

  it("preserves input exactly when no block is recognized", () => {
    const lines = ["# Active", "", "- keep", ""];
    expect(splitKnownErrorSections(lines)).toEqual({
      contextLines: lines,
      blocks: [],
    });
  });
});
