import { describe, expect, it } from "vitest";
import {
  detectIndexPointers,
  emptyIndexPointerReport,
} from "../src/index-pointers.js";

function report(params: {
  readonly index: string;
  readonly current: string;
  readonly next: string;
  readonly removed: ReadonlyArray<{
    readonly lineNumbers: readonly number[];
    readonly text: string;
  }>;
  readonly file?: string;
}) {
  return detectIndexPointers({
    forgottenFile: params.file ?? "architecture.md",
    currentFileText: params.current,
    nextFileText: params.next,
    removedUnits: params.removed,
    indexText: params.index,
  });
}

describe("detectIndexPointers", () => {
  it("flags a literal topic pointer that disappears", () => {
    const result = report({
      index: "- legacy queue adapter → architecture.md\n",
      current: "# Architecture\n- legacy queue adapter stays\n- keep\n",
      next: "# Architecture\n- keep\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- legacy queue adapter → architecture.md",
        reason: "literal",
      },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("does not flag a file-general scaffold pointer", () => {
    const result = report({
      index:
        "- architecture: contracts, sibling implementations, style-lock pointer\n",
      current: "# Architecture\n- legacy queue adapter stays\n- keep\n",
      next: "# Architecture\n- keep\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("flags a section pointer whose section loses all content", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- old adapter",
      "- retry policy",
      "## Keep",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n## Queue\n## Keep\n- keep",
      removed: [
        { lineNumbers: [3], text: "- old adapter" },
        { lineNumbers: [4], text: "- retry policy" },
      ],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
  });

  it("does not flag a section pointer that still has content", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- old adapter",
      "- retry policy",
      "## Keep",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n## Queue\n- retry policy\n## Keep\n- keep",
      removed: [{ lineNumbers: [3], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("flags a topic pointer whose section still has content as ambiguous", () => {
    const current = [
      "# Architecture",
      "## Integrations",
      "- legacy queue adapter stays",
      "- keep",
    ].join("\n");
    const result = report({
      index: "- legacy queue adapter → architecture.md:Integrations\n",
      current,
      next: "# Architecture\n## Integrations\n- keep",
      removed: [{ lineNumbers: [3], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.line).toBe(1);
    expect(result.ambiguous[0]!.reason).toContain("section still has content");
  });

  it("flags an unresolvable explicit section as ambiguous", () => {
    const current = "# Architecture\n- keep\n";
    const result = report({
      index: "- Queue → architecture.md:Missing section\n",
      current,
      next: current,
      removed: [{ lineNumbers: [2], text: "- remove me" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Missing section",
        reason:
          'section "missing section" was not found in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("flags a duplicate heading match as ambiguous", () => {
    const current = [
      "# Architecture",
      "## Integrations",
      "- old adapter",
      "## Integrations",
      "- retry",
    ].join("\n");
    const result = report({
      index: "- legacy → architecture.md:Integrations\n",
      current,
      next: current,
      removed: [{ lineNumbers: [3], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.line).toBe(1);
    expect(result.ambiguous[0]!.reason).toContain(
      'matches more than one heading',
    );
  });

  it("ignores pointers to other files", () => {
    const result = report({
      index: "- legacy queue adapter → decisions.md\n",
      current: "# Architecture\n- legacy queue adapter stays\n",
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter stays" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("returns an empty report for INDEX.md itself", () => {
    const result = report({
      file: "INDEX.md",
      index: "- anything\n",
      current: "- anything\n",
      next: "",
      removed: [{ lineNumbers: [1], text: "- anything" }],
    });
    expect(result).toEqual(emptyIndexPointerReport("inspected"));
  });

  it("does not flag a pointer whose phrase survives elsewhere", () => {
    const result = report({
      index: "- legacy queue adapter → architecture.md\n",
      current:
        "# Architecture\n- legacy queue adapter old\n- legacy queue adapter new\n",
      next: "# Architecture\n- legacy queue adapter new\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter old" }],
    });
    expect(result.candidates).toEqual([]);
  });
});
