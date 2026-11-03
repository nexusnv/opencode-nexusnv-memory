import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSidebarPoller,
  SIDEBAR_POLL_INTERVAL_MS,
  SIDEBAR_REQUEST_TIMEOUT_MS,
} from "../src/sidebar-poll.js";
import type { SidebarSnapshot } from "../src/sidebar.js";

const HEALTHY: SidebarSnapshot = { state: "healthy", pending: 0 };

function deferredRequest(): {
  readonly request: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
} {
  let resolve!: (value: unknown) => void;
  const request = (_signal: AbortSignal): Promise<unknown> =>
    new Promise<unknown>((done) => {
      resolve = done;
    });
  return { request, resolve: (value: unknown) => resolve(value) };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSidebarPoller", () => {
  it("validates each result before publishing a snapshot", async () => {
    const results: unknown[] = [
      HEALTHY,
      { state: "healthy", pending: -1 },
      { state: "attention", pending: 3 },
    ];
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const request = vi.fn(async () => results.shift());
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    poller.requestRefresh();
    await flush();
    poller.requestRefresh();
    await flush();

    expect(snapshots).toEqual([
      HEALTHY,
      undefined,
      { state: "attention", pending: 3 },
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it("hides the line when a request rejects", async () => {
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const request = vi.fn(async () => {
      throw new Error("storage down");
    });
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    expect(snapshots).toEqual([undefined]);
    expect(request).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it("does nothing when started or refreshed after disposal", async () => {
    const request = vi.fn(async () => HEALTHY);
    const poller = createSidebarPoller({
      request,
      onSnapshot: () => undefined,
    });

    poller.dispose();
    poller.start();
    poller.requestRefresh();
    await vi.advanceTimersByTimeAsync(SIDEBAR_POLL_INTERVAL_MS);

    expect(request).not.toHaveBeenCalled();
  });

  it("starts once and polls immediately and on the interval", async () => {
    const request = vi.fn(async () => HEALTHY);
    const poller = createSidebarPoller({
      request,
      onSnapshot: () => undefined,
    });

    poller.start();
    poller.start();
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SIDEBAR_POLL_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("hides at the timeout and recovers on a later poll", async () => {
    let calls = 0;
    const request = vi.fn((_signal: AbortSignal): Promise<unknown> => {
      calls += 1;
      return calls === 1
        ? new Promise(() => undefined)
        : Promise.resolve(HEALTHY);
    });
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(SIDEBAR_REQUEST_TIMEOUT_MS);
    expect(snapshots).toEqual([undefined]);

    // The first request never settled; the timeout must release the in-flight
    // guard so the next interval tick can recover.
    await vi.advanceTimersByTimeAsync(
      SIDEBAR_POLL_INTERVAL_MS - SIDEBAR_REQUEST_TIMEOUT_MS,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([undefined, HEALTHY]);
    poller.dispose();
  });

  it("queues one trailing refresh while a request is in flight", async () => {
    const first = deferredRequest();
    let calls = 0;
    const request = vi.fn((signal: AbortSignal): Promise<unknown> => {
      calls += 1;
      return calls === 1 ? first.request(signal) : Promise.resolve(HEALTHY);
    });
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    poller.requestRefresh();
    poller.requestRefresh();
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve(HEALTHY);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(snapshots).toEqual([HEALTHY, HEALTHY]);
    poller.dispose();
  });

  it("ignores a late result from an aborted request", async () => {
    const first = deferredRequest();
    let calls = 0;
    const request = vi.fn((signal: AbortSignal): Promise<unknown> => {
      calls += 1;
      return calls === 1 ? first.request(signal) : Promise.resolve(HEALTHY);
    });
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    await vi.advanceTimersByTimeAsync(SIDEBAR_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(
      SIDEBAR_POLL_INTERVAL_MS - SIDEBAR_REQUEST_TIMEOUT_MS,
    );
    expect(snapshots).toEqual([undefined, HEALTHY]);

    first.resolve({ state: "not-initialized", pending: 0 });
    await flush();
    expect(snapshots).toEqual([undefined, HEALTHY]);
    poller.dispose();
  });

  it("clears timers and ignores a late result after disposal", async () => {
    const pending = deferredRequest();
    const request = vi.fn((signal: AbortSignal) => pending.request(signal));
    const snapshots: Array<SidebarSnapshot | undefined> = [];
    const poller = createSidebarPoller({
      request,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    poller.start();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    poller.dispose();
    pending.resolve(HEALTHY);
    await flush();
    await vi.advanceTimersByTimeAsync(SIDEBAR_POLL_INTERVAL_MS * 2);

    expect(snapshots).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
