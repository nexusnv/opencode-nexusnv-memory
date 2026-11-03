/**
 * Server-side sidebar status collector and RPC registration (ADR-0012).
 *
 * Read-only by construction: the collector checks initialization first and
 * returns the pre-init reminder without a storage read. For an initialized
 * project it reads the existing INDEX line count, pending counter, and three
 * actionable notice markers through `get` only — it never calls `set`,
 * `remove`, `takeNotice`, `takeRotated`, or a metric bump.
 */
import type { Plugin } from "@opencode/plugin";
import { join } from "node:path";
import { indexLineCount } from "./brief.js";
import {
  getNotice,
  getPending,
  type LedgerStorage,
  type NoticeKind,
} from "./capture.js";
import { asLedger, memoryRootOf, projectIDOf } from "./command-context.js";
import { isInitialized } from "./init.js";
import { MemoryRpc } from "./rpc.js";
import { deriveSidebarSnapshot, type SidebarSnapshot } from "./sidebar.js";

export interface SidebarStatusInput {
  readonly memoryRoot: string;
  readonly storage: LedgerStorage;
  readonly projectID: string;
  readonly indexLines: number;
}

export interface SidebarStatusDeps {
  readonly isInitialized: (memoryRoot: string) => Promise<boolean>;
  readonly indexLineCount: (
    absPath: string,
    memoryRoot: string,
    indexLines: number,
  ) => Promise<number | undefined>;
  readonly getPending: (
    storage: LedgerStorage,
    projectID: string,
  ) => Promise<number>;
  readonly getNotice: (
    storage: LedgerStorage,
    projectID: string,
    kind: NoticeKind,
  ) => Promise<number | undefined>;
}

const defaultDeps: SidebarStatusDeps = {
  isInitialized,
  indexLineCount,
  getPending,
  getNotice,
};

/**
 * Collect one project's status without mutating storage.
 *
 * Pre-init returns the reminder before any storage read. An initialized
 * project reads only the existing INDEX line count, pending counter, and
 * actionable notice markers; the result feeds the pure precedence function.
 */
export async function collectSidebarStatus(
  input: SidebarStatusInput,
  deps: SidebarStatusDeps = defaultDeps,
): Promise<SidebarSnapshot> {
  if (!(await deps.isInitialized(input.memoryRoot))) {
    return { state: "not-initialized", pending: 0 };
  }

  const indexCount = await deps.indexLineCount(
    join(input.memoryRoot, "INDEX.md"),
    input.memoryRoot,
    input.indexLines,
  );
  const [pending, overCapNotices, stalePointers, failedCaptures] =
    await Promise.all([
      deps.getPending(input.storage, input.projectID),
      deps.getNotice(input.storage, input.projectID, "indexOverCap"),
      deps.getNotice(input.storage, input.projectID, "indexStale"),
      deps.getNotice(input.storage, input.projectID, "captureFailed"),
    ]);

  return deriveSidebarSnapshot({
    initialized: true,
    indexWithinCap: indexCount !== undefined && indexCount <= input.indexLines,
    overCapNotices: overCapNotices ?? 0,
    stalePointers: stalePointers ?? 0,
    failedCaptures: failedCaptures ?? 0,
    pending,
  });
}

/**
 * Register the read-only RPC unconditionally. The method must answer before
 * and after initialization, and the TUI is a separate plugin part; guarding
 * registration would silently drop the indicator instead of failing the host
 * contract.
 */
export function registerSidebarRpc(ctx: Plugin.Context, indexLines: number) {
  const storage = asLedger(ctx.storage);
  const projectID = projectIDOf(ctx);
  const memoryRoot = memoryRootOf(ctx);
  // Overlapping TUI polls share one collection. A timed-out client request
  // must not accumulate another INDEX/storage read while the previous read is
  // still stalled; the snapshot is project-wide and read-only, so sharing it
  // is safe. Both settle paths clear the slot so the next poll retries.
  let inFlight: Promise<SidebarSnapshot> | undefined;
  return ctx.rpc.register(MemoryRpc, {
    /** Serve the one in-flight collection, starting it when idle. */
    sidebarStatus: () => {
      let collection = inFlight;
      if (collection === undefined) {
        collection = collectSidebarStatus({
          memoryRoot,
          storage,
          projectID,
          indexLines,
        });
        inFlight = collection;
        const clear = () => {
          if (inFlight === collection) inFlight = undefined;
        };
        void collection.then(clear, clear);
      }
      return collection;
    },
  });
}
