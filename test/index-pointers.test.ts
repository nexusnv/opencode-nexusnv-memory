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

  it("does not flag a section that was already empty before the forget", () => {
    const current = [
      "# Architecture",
      "## Empty",
      "## Keep",
      "- remove me",
    ].join("\n");
    const result = report({
      index: "- Empty → architecture.md:Empty\n",
      current,
      next: "# Architecture\n## Empty\n## Keep\n",
      removed: [{ lineNumbers: [4], text: "- remove me" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("flags a section pointer when the heading and its content are removed", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- old adapter",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n",
      removed: [
        { lineNumbers: [2], text: "## Queue" },
        { lineNumbers: [3], text: "- old adapter" },
      ],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reports a removed heading with remaining content as ambiguous", () => {
    const current = [
      "# Architecture",
      "## Queue",
      "- keep me",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n- keep me\n",
      removed: [{ lineNumbers: [2], text: "## Queue" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason:
          'section heading "queue" was removed but content remains in architecture.md; edit INDEX.md manually',
      },
    ]);
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

  it("reports a missing section when the topic also disappeared", () => {
    const current = "# Architecture\n- legacy queue adapter\n";
    const result = report({
      index: "- legacy queue adapter → architecture.md:Missing section\n",
      current,
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- legacy queue adapter → architecture.md:Missing section",
        reason:
          'section "missing section" was not found in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("reports duplicate headings when the topic also disappeared", () => {
    const current = [
      "# Architecture",
      "## Integrations",
      "- legacy queue adapter",
      "## Integrations",
      "- retry",
    ].join("\n");
    const result = report({
      index: "- legacy queue adapter → architecture.md:Integrations\n",
      current,
      next: "# Architecture\n## Integrations\n## Integrations\n- retry",
      removed: [{ lineNumbers: [3], text: "- legacy queue adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- legacy queue adapter → architecture.md:Integrations",
        reason:
          'section "integrations" matches more than one heading in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const current = [
      "# Architecture",
      "```md",
      "## Queue",
      "```",
      "## Queue",
      "- old adapter",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: "# Architecture\n```md\n## Queue\n```\n## Queue\n",
      removed: [{ lineNumbers: [6], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
    expect(result.ambiguous).toEqual([]);
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

  it("does not flag a pointer embedded inside a larger word", () => {
    const result = report({
      index: "- configuration → architecture.md\n",
      current: "# Architecture\n- reconfiguration happened\n",
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- reconfiguration happened" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("does not match a pointer across separately approved units", () => {
    const result = report({
      index: "- alpha beta → architecture.md\n",
      current: "# Architecture\n- alpha\nbeta gamma\n",
      next: "# Architecture\n",
      removed: [
        { lineNumbers: [2], text: "- alpha" },
        { lineNumbers: [3], text: "beta gamma" },
      ],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("ignores a file-general row whose descriptor was removed", () => {
    const result = report({
      index: "- architecture: legacy queue adapter\n",
      current: "# Architecture\n- legacy queue adapter\n",
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- legacy queue adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reports a topic-only pointer whose removed heading kept content", () => {
    const result = report({
      index: "- Queue → architecture.md\n",
      current: "# Architecture\n## Queue\n- keep me\n",
      next: "# Architecture\n- keep me\n",
      removed: [{ lineNumbers: [2], text: "## Queue" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md",
        reason:
          'topic "queue" matched a heading that was removed but its content remains in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("reports an already-empty section whose heading was removed", () => {
    const result = report({
      index: "- Empty → architecture.md:Empty\n",
      current: "# Architecture\n## Empty\n## Keep\n- keep\n",
      next: "# Architecture\n## Keep\n- keep\n",
      removed: [{ lineNumbers: [2], text: "## Empty" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Empty → architecture.md:Empty",
        reason:
          'heading "empty" was removed but its section was already empty in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("reports an empty section when the topic survives elsewhere", () => {
    const result = report({
      index: "- legacy queue adapter → architecture.md:Queue\n",
      current: [
        "# Architecture",
        "## Queue",
        "- legacy queue adapter",
        "## Other",
        "- legacy queue adapter remains",
      ].join("\n"),
      next: [
        "# Architecture",
        "## Queue",
        "## Other",
        "- legacy queue adapter remains",
      ].join("\n"),
      removed: [{ lineNumbers: [3], text: "- legacy queue adapter" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- legacy queue adapter → architecture.md:Queue",
        reason:
          'section "queue" is now empty but the topic still appears in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("reports a short missing section before literal matching", () => {
    const result = report({
      index: "- Queue → architecture.md:Q\n",
      current: "# Architecture\n- keep\n",
      next: "# Architecture\n",
      removed: [{ lineNumbers: [2], text: "- keep" }],
    });
    expect(result.candidates).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Q",
        reason:
          'section "q" was not found in architecture.md; edit INDEX.md manually',
      },
    ]);
  });

  it("uses the destination after the arrow, not a filename in the topic", () => {
    const result = report({
      index: "- style.md notes → architecture.md:Queue\n",
      current: "# Architecture\n## Queue\n- old adapter\n",
      next: "# Architecture\n## Queue\n",
      removed: [{ lineNumbers: [3], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- style.md notes → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
  });

  it("does not close a backtick fence on a different marker family", () => {
    const current = [
      "# Architecture",
      "```md",
      "~~~",
      "## Queue",
      "~~~",
      "```",
      "## Queue",
      "- old adapter",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: [
        "# Architecture",
        "```md",
        "~~~",
        "## Queue",
        "~~~",
        "```",
        "## Queue",
      ].join("\n"),
      removed: [{ lineNumbers: [8], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
  });

  it("does not close a backtick fence on a shorter or annotated run", () => {
    const current = [
      "# Architecture",
      "````md",
      "```js",
      "## Queue",
      "````",
      "## Queue",
      "- old adapter",
    ].join("\n");
    const result = report({
      index: "- Queue → architecture.md:Queue\n",
      current,
      next: [
        "# Architecture",
        "````md",
        "```js",
        "## Queue",
        "````",
        "## Queue",
      ].join("\n"),
      removed: [{ lineNumbers: [7], text: "- old adapter" }],
    });
    expect(result.candidates).toEqual([
      {
        line: 1,
        text: "- Queue → architecture.md:Queue",
        reason: "empty-section",
      },
    ]);
  });
});
