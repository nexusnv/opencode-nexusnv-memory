/**
 * Pure TUI sidebar state (ADR-0012, spec §5.15).
 *
 * No fs, storage, Solid, or theme imports: the server collector, the TUI
 * component, and the unit tests all share these functions without pulling a
 * runtime into the wrong process.
 */
export type SidebarState =
  "not-initialized" | "healthy" | "pending" | "attention";

export interface SidebarFacts {
  readonly initialized: boolean;
  /**
   * True only when INDEX was read after initialization and its line count is
   * within the cap. False for missing, unreadable, over-cap, or too-large
   * INDEX files.
   */
  readonly indexWithinCap: boolean;
  readonly overCapNotices: number;
  readonly stalePointers: number;
  readonly failedCaptures: number;
  readonly pending: number;
}

export interface SidebarSnapshot {
  readonly state: SidebarState;
  readonly pending: number;
}

export type SidebarTone = "warning" | "error" | "success";

export interface SidebarLabel {
  readonly text: string;
  readonly tone: SidebarTone;
}

const SIDEBAR_STATES: ReadonlySet<string> = new Set([
  "not-initialized",
  "healthy",
  "pending",
  "attention",
]);

/**
 * Fixed precedence: not-initialized > attention > pending > healthy.
 * The not-initialized branch reports pending 0 because the collector did not
 * read storage; attention and pending carry the observed counter.
 */
export function deriveSidebarSnapshot(facts: SidebarFacts): SidebarSnapshot {
  if (!facts.initialized) {
    return { state: "not-initialized", pending: 0 };
  }
  if (!facts.indexWithinCap) {
    return { state: "attention", pending: facts.pending };
  }
  if (
    facts.overCapNotices > 0 ||
    facts.stalePointers > 0 ||
    facts.failedCaptures > 0
  ) {
    return { state: "attention", pending: facts.pending };
  }
  if (facts.pending > 0) {
    return { state: "pending", pending: facts.pending };
  }
  return { state: "healthy", pending: 0 };
}

/** One fixed label per state; the pending count appears only in `pending`. */
export function renderSidebarLabel(snapshot: SidebarSnapshot): SidebarLabel {
  switch (snapshot.state) {
    case "not-initialized":
      return { text: "○ memory · run /memory-init", tone: "warning" };
    case "attention":
      return { text: "▲ memory · needs attention", tone: "error" };
    case "pending":
      return {
        text: `◐ memory · ${snapshot.pending} pending`,
        tone: "warning",
      };
    case "healthy":
      return { text: "● memory · healthy", tone: "success" };
  }
}

/**
 * Validate the portable RPC result at the TUI boundary. The client return type
 * is `unknown`, so an invalid or foreign payload must hide the line rather
 * than reach the renderer.
 */
export function isSidebarSnapshot(value: unknown): value is SidebarSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  const state = snapshot["state"];
  const pending = snapshot["pending"];
  return (
    typeof state === "string" &&
    SIDEBAR_STATES.has(state) &&
    typeof pending === "number" &&
    Number.isInteger(pending) &&
    pending >= 0
  );
}
