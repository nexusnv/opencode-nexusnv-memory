import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_OPTIONS,
  deriveSidebarSnapshot,
  isSidebarSnapshot,
  parseSidebarOptions,
  renderSidebarLabel,
  resetSidebarOptionsWarnings,
  type SidebarFacts,
  type SidebarState,
  type SidebarTone,
} from "../src/sidebar.js";

function collector(): { messages: string[]; warn: (m: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
}

function facts(overrides: Partial<SidebarFacts> = {}): SidebarFacts {
  return {
    initialized: true,
    indexWithinCap: true,
    overCapNotices: 0,
    stalePointers: 0,
    failedCaptures: 0,
    pending: 0,
    ...overrides,
  };
}

describe("parseSidebarOptions", () => {
  beforeEach(() => resetSidebarOptionsWarnings());

  it("defaults to visible when the key is missing", () => {
    expect(parseSidebarOptions(undefined)).toEqual(DEFAULT_SIDEBAR_OPTIONS);
    expect(parseSidebarOptions({})).toEqual({ showSidebarStatus: true });
  });

  it("honors an explicit false", () => {
    expect(parseSidebarOptions({ showSidebarStatus: false })).toEqual({
      showSidebarStatus: false,
    });
  });

  it("warns once and stays visible for an invalid value", () => {
    const first = collector();
    expect(parseSidebarOptions({ showSidebarStatus: "yes" }, first.warn)).toEqual(
      { showSidebarStatus: true },
    );
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("showSidebarStatus");
    expect(first.messages[0]).toContain('"yes"');

    const second = collector();
    parseSidebarOptions({ showSidebarStatus: "yes" }, second.warn);
    expect(second.messages).toHaveLength(0);
  });

  it("defaults to visible for non-object input without a duplicate warning", () => {
    const messages = collector();
    expect(parseSidebarOptions("bad", messages.warn)).toEqual({
      showSidebarStatus: true,
    });
    expect(messages.messages).toHaveLength(0);
  });

  it("ignores unrelated keys, including the five server options", () => {
    const messages = collector();
    expect(
      parseSidebarOptions(
        { indexLines: 30, fileLines: 60, captureFailures: false },
        messages.warn,
      ),
    ).toEqual({ showSidebarStatus: true });
    expect(messages.messages).toHaveLength(0);
  });
});

describe("deriveSidebarSnapshot", () => {
  it("not-initialized wins over every other fact and reports zero pending", () => {
    expect(
      deriveSidebarSnapshot(
        facts({
          initialized: false,
          indexWithinCap: false,
          overCapNotices: 3,
          stalePointers: 2,
          failedCaptures: 1,
          pending: 7,
        }),
      ),
    ).toEqual({ state: "not-initialized", pending: 0 });
  });

  it("an uninspectable or over-cap INDEX produces attention", () => {
    expect(
      deriveSidebarSnapshot(facts({ indexWithinCap: false, pending: 4 })),
    ).toEqual({ state: "attention", pending: 4 });
  });

  it("any actionable notice beats pending", () => {
    for (const override of [
      { overCapNotices: 1 },
      { stalePointers: 1 },
      { failedCaptures: 1 },
    ] as const) {
      expect(
        deriveSidebarSnapshot(facts({ ...override, pending: 2 })),
      ).toEqual({ state: "attention", pending: 2 });
    }
  });

  it("reports pending when initialized, inspectable, and notice-free", () => {
    expect(deriveSidebarSnapshot(facts({ pending: 3 }))).toEqual({
      state: "pending",
      pending: 3,
    });
  });

  it("is healthy only when every fact is clean", () => {
    expect(deriveSidebarSnapshot(facts())).toEqual({
      state: "healthy",
      pending: 0,
    });
  });
});

const LABEL_CASES: ReadonlyArray<{
  readonly state: SidebarState;
  readonly pending: number;
  readonly text: string;
  readonly tone: SidebarTone;
}> = [
  {
    state: "not-initialized",
    pending: 0,
    text: "○ memory · run /memory-init",
    tone: "warning",
  },
  {
    state: "attention",
    pending: 4,
    text: "▲ memory · needs attention",
    tone: "error",
  },
  {
    state: "pending",
    pending: 3,
    text: "◐ memory · 3 pending",
    tone: "warning",
  },
  {
    state: "healthy",
    pending: 0,
    text: "● memory · healthy",
    tone: "success",
  },
];

describe("renderSidebarLabel", () => {
  it.each(LABEL_CASES)("renders $state", ({ state, pending, text, tone }) => {
    expect(renderSidebarLabel({ state, pending })).toEqual({ text, tone });
  });
});

describe("isSidebarSnapshot", () => {
  it("accepts exactly the four states with a non-negative integer pending", () => {
    for (const state of [
      "not-initialized",
      "healthy",
      "pending",
      "attention",
    ] as const) {
      expect(isSidebarSnapshot({ state, pending: 0 })).toBe(true);
    }
    expect(isSidebarSnapshot({ state: "pending", pending: 2 })).toBe(true);
  });

  it("rejects invalid payloads", () => {
    expect(isSidebarSnapshot(undefined)).toBe(false);
    expect(isSidebarSnapshot(null)).toBe(false);
    expect(isSidebarSnapshot([])).toBe(false);
    expect(isSidebarSnapshot({ state: "healthy" })).toBe(false);
    expect(isSidebarSnapshot({ state: "unknown", pending: 0 })).toBe(false);
    expect(isSidebarSnapshot({ state: "healthy", pending: -1 })).toBe(false);
    expect(isSidebarSnapshot({ state: "healthy", pending: 1.5 })).toBe(false);
    expect(isSidebarSnapshot({ state: "healthy", pending: "0" })).toBe(false);
  });
});
