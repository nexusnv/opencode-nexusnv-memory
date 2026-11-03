/**
 * Testable polling state machine for the TUI sidebar status line (ADR-0012).
 *
 * Keeps the host-independent lifecycle out of `src/tui.tsx`: one in-flight
 * request, a 4-second abort timeout, event-triggered trailing refreshes, and
 * fail-closed snapshot clearing. No Solid, fs, or storage imports.
 */
import { isSidebarSnapshot, type SidebarSnapshot } from "./sidebar.js";

export interface SidebarPollerOptions {
  /**
   * Perform one RPC request. The signal aborts on timeout or disposal; a
   * late-settling result is ignored.
   */
  readonly request: (signal: AbortSignal) => Promise<unknown>;
  /** Receives a validated snapshot, or `undefined` to hide/clear the line. */
  readonly onSnapshot: (snapshot: SidebarSnapshot | undefined) => void;
}

export interface SidebarPoller {
  /** Start the immediate fetch and the interval; idempotent. */
  start(): void;
  /** Refresh now, or queue one trailing refresh while a request is in flight. */
  requestRefresh(): void;
  /** Stop timers, abort the in-flight request, and ignore late results. */
  dispose(): void;
}

export const SIDEBAR_POLL_INTERVAL_MS = 5_000;
export const SIDEBAR_REQUEST_TIMEOUT_MS = 4_000;

/**
 * Create the polling lifecycle for one mounted sidebar line.
 *
 * The first fetch starts with {@link SidebarPoller.start}; event callers use
 * {@link SidebarPoller.requestRefresh}. One request is in flight at a time;
 * an event during it queues exactly one trailing refresh. A timeout hides the
 * line and releases the slot even when the client never settles the aborted
 * request. Disposal clears all timers, aborts the request, and ignores late
 * results.
 */
export function createSidebarPoller(
  options: SidebarPollerOptions,
): SidebarPoller {
  let disposed = false;
  let started = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let inFlight: AbortController | undefined;
  let refreshQueued = false;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();

  /** Run one guarded request and publish a validated snapshot or `undefined`. */
  async function refresh(): Promise<void> {
    if (disposed || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => {
      timeouts.delete(timeout);
      controller.abort();
      if (!disposed) options.onSnapshot(undefined);
      // Recover even if the client never settles the aborted request; a late
      // result is ignored by the aborted check below and must not displace a
      // newer poll's state.
      if (inFlight === controller) inFlight = undefined;
    }, SIDEBAR_REQUEST_TIMEOUT_MS);
    timeouts.add(timeout);

    try {
      const result = await options.request(controller.signal);
      if (disposed || controller.signal.aborted) return;
      options.onSnapshot(isSidebarSnapshot(result) ? result : undefined);
    } catch {
      if (!disposed && !controller.signal.aborted)
        options.onSnapshot(undefined);
    } finally {
      clearTimeout(timeout);
      timeouts.delete(timeout);
      if (inFlight === controller) inFlight = undefined;
      // Only the poll that owns (or owned) the in-flight slot may drain the
      // queue; if another poll owns it, leave the flag set for that poll's
      // own finally. This avoids stealing the flag in a late-settling aborted
      // poll and dropping a queued refresh.
      if (refreshQueued && !disposed && !inFlight) {
        refreshQueued = false;
        void refresh();
      }
    }
  }

  /** Refresh now, or queue one trailing refresh while a request is active. */
  function requestRefresh(): void {
    if (disposed) return;
    if (inFlight) {
      refreshQueued = true;
      return;
    }
    void refresh();
  }

  /** Begin the immediate fetch and the 5-second interval exactly once. */
  function start(): void {
    if (disposed || started) return;
    started = true;
    void refresh();
    interval = setInterval(() => {
      void refresh();
    }, SIDEBAR_POLL_INTERVAL_MS);
  }

  /** Stop timers, abort the current request, and ignore its late result. */
  function dispose(): void {
    disposed = true;
    refreshQueued = false;
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    for (const timeout of timeouts) clearTimeout(timeout);
    timeouts.clear();
    inFlight?.abort();
    inFlight = undefined;
  }

  return { start, requestRefresh, dispose };
}
