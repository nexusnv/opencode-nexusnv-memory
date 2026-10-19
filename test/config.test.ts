import { describe, expect, it, beforeEach } from "vitest";
import {
  parseMemoryOptions,
  resetMemoryOptionsWarnings,
} from "../src/config.js";

function collector(): { messages: string[]; warn: (m: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
}

describe("parseMemoryOptions coherence warnings", () => {
  beforeEach(() => resetMemoryOptionsWarnings());

  it("warns once when injectBudgetLines leaves no budget above indexLines", () => {
    const first = collector();
    const opts = parseMemoryOptions({ indexLines: 100 }, first.warn);
    expect(opts.injectBudgetLines).toBe(80);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("injectBudgetLines (80)");
    expect(first.messages[0]).toContain("indexLines (100)");
    // Warn-once per process (same key): a second parse is silent.
    const second = collector();
    parseMemoryOptions({ indexLines: 100 }, second.warn);
    expect(second.messages).toHaveLength(0);
  });

  it("warns once when fileLines is very small", () => {
    const { messages, warn } = collector();
    parseMemoryOptions({ fileLines: 5 }, warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("fileLines (5)");
  });

  it("stays quiet for coherent values and defaults", () => {
    const { messages, warn } = collector();
    parseMemoryOptions({}, warn);
    parseMemoryOptions({ injectBudgetLines: 200 }, warn);
    parseMemoryOptions(undefined, warn);
    expect(messages).toHaveLength(0);
  });

  it("keeps invalid-value warnings unchanged", () => {
    const { messages, warn } = collector();
    const opts = parseMemoryOptions({ indexLines: "nope" }, warn);
    expect(opts.indexLines).toBe(30);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("invalid option indexLines");
  });
});
