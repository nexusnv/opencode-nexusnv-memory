import { Plugin } from "@opencode/plugin";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dispatchEvent,
  snapshotIfDue,
  startEventLoop,
  type LedgerStorage,
  type VcsPort,
} from "./capture.js";
import {
  indexWithinCap,
  loadBrief,
  loadPriors,
  truncateLinesWithNotice,
} from "./brief.js";
import { matchIndex } from "./hints.js";
import { statusLine } from "./status.js";
import { rememberAsserted } from "./provenance.js";
import { registerMemoryReview } from "./review.js";
import { parseMemoryOptions } from "./config.js";
import { registerMemoryTools } from "./tools.js";
import {
  AGENTS_PROTOCOL_BLOCK,
  ARCHIVE_DIR,
  HANDOFFS_DIR,
  getScaffoldFiles,
  optionsSnippet,
  permissionsSnippet,
} from "./templates.js";

/**
 * Registration handle returned by `hook`/`transform` calls. Structural match
 * for the plugin API's `Registration` (`dispose(): Promise<void>`); captured
 * so unload can dispose explicitly (spec §5.7 lifecycle).
 */
interface Registration {
  readonly dispose: () => Promise<void>;
}

/** Fixed memory root, relative to the project (spec ADR-0006; not configurable). */
const MEMORY_DIR = ".opencode/memory";

/**
 * Scaffold `.opencode/memory/` + six templates + `handoffs/` (+ archive dir).
 * Only writes missing files; never overwrites hand-owned content; never throws.
 * Returns true when anything was created (first run).
 */
async function scaffoldMemoryDir(projectRoot: string): Promise<boolean> {
  try {
    const dir = join(projectRoot, MEMORY_DIR);
    await mkdir(join(dir, HANDOFFS_DIR), { recursive: true });
    await mkdir(join(dir, ARCHIVE_DIR), { recursive: true });
    let created = false;
    for (const [name, content] of Object.entries(getScaffoldFiles())) {
      try {
        await writeFile(join(dir, name), content, { flag: "wx" });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    }
    return created;
  } catch {
    return false;
  }
}

/** Best-effort diagnostic log; logging must never break a hook. */
function logDiagnostic(error: unknown): void {
  try {
    console.warn("[memory] hook diagnostic:", error);
  } catch {
    // Logging must never break plugin load or a hook.
  }
}

/**
 * Adapt the plugin-scoped `ctx.storage` (narrow JSON value type) to the
 * ledger's structural port. `ctx.storage` is the durable store; nothing is
 * cached in-memory alone.
 */
function asLedger(storage: Plugin.Context["storage"]): LedgerStorage {
  return {
    get: (key) => storage.get(key),
    set: (key, value) =>
      storage.set(
        key,
        value as Parameters<Plugin.Context["storage"]["set"]>[1],
      ),
    remove: (key) => storage.remove(key),
    scan: (options) => storage.scan(options),
  };
}

function projectRootOf(ctx: Plugin.Context): string {
  return (
    ctx.location.project?.canonical ?? ctx.location.directory
  ).replace(/\/+$/, "");
}

function projectIDOf(ctx: Plugin.Context): string {
  return ctx.location.project?.id ?? ctx.location.directory;
}

/**
 * Memory plugin entrypoint — wiring only (Promise flavor; no `effect()`
 * import, no `server()` dual export). Hook/transform registrations are
 * pushed into `registrations`; the async cleanup aborts the single event
 * controller and disposes every registration (spec §§5.7, 5.9).
 *
 * Every hook body is wrapped so it never throws: a throwing `prompt` hook
 * blocks prompt admission, and a throwing request hook can disturb
 * tool-result delivery. All loaders are async and always awaited (except
 * the explicitly fire-and-forget snapshot throttle gate).
 */
export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    // Read options once; invalid values warn once and fall back to defaults.
    const options = parseMemoryOptions(ctx.options);

    // The ONE event-stream controller; §5.9 reuses it (subscribed in Task 8).
    const controller = new AbortController();
    const registrations: Registration[] = [];

    // Prompt hook: sole INDEX injector + source:user fast path (§§5.1, 5.11).
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        try {
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          event.prompt.files ??= [];
          const already = event.prompt.files.some(
            (f) =>
              typeof f?.uri === "string" &&
              f.uri.endsWith(".opencode/memory/INDEX.md"),
          );
          if (!already) {
            const abs = join(memoryRoot, "INDEX.md");
            // Over-cap/missing/unreadable INDEX is not attached (no truncation).
            if (await indexWithinCap(abs, options.indexLines)) {
              event.prompt.files.push({ uri: `file://${abs}` });
            }
          }
          // One bounded side effect: user-asserted remember → decisions.md.
          await rememberAsserted(event, {
            storage: ledger,
            projectID,
            memoryRoot,
          });
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // Context hook: brief + status + hint, budget-capped (§5.2).
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        try {
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const brief = await loadBrief(memoryRoot, {
            fileLines: options.fileLines,
          });
          const status = await statusLine(ledger, projectID);
          const hint = await matchIndex(event.messages, {
            storage: ledger,
            projectID,
            sessionID: event.sessionID,
            memoryRoot,
          });

          // Budget: INDEX (≤indexLines) + brief (≤48) + status (≤1) +
          // hint (≤1) ≤ injectBudgetLines. Overflow truncates the brief
          // first; the status line is dropped before the hint, which is
          // never dropped on a hit. Ordering: brief, status, hint.
          const budget = Math.max(
            0,
            options.injectBudgetLines - options.indexLines,
          );
          const rawBrief = brief === "" ? [] : brief.split("\n");
          let briefLines = rawBrief;
          let keepStatus = status !== undefined;
          const hintKept = hint !== undefined;
          const hintCount = hintKept ? 1 : 0;
          const total = () =>
            briefLines.length + (keepStatus ? 1 : 0) + hintCount;
          if (total() > budget) {
            briefLines = truncateLinesWithNotice(
              rawBrief,
              Math.max(0, budget - (keepStatus ? 1 : 0) - hintCount),
            );
          }
          if (total() > budget) {
            keepStatus = false;
            briefLines = truncateLinesWithNotice(
              rawBrief,
              Math.max(0, budget - hintCount),
            );
          }

          if (briefLines.length > 0) {
            event.system.push({ type: "text", text: briefLines.join("\n") });
          }
          if (keepStatus && status !== undefined) {
            event.system.push({ type: "text", text: status });
          }
          if (hint !== undefined) {
            event.system.push({ type: "text", text: hint });
          }

          // Throttled handoff writer: fire-and-forget, never awaited.
          void snapshotIfDue(ledger, projectID, event.sessionID, {
            throttleMinutes: options.snapshotThrottleMinutes,
            vcs: ctx.vcs as unknown as VcsPort,
            memoryRoot,
            fileLines: options.fileLines,
          }).catch(logDiagnostic);
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // Compaction hook: priors only — never set event.result (§5.6).
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        try {
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const priors = await loadPriors(memoryRoot, {
            fileLines: options.fileLines,
          });
          if (priors.length > 0) {
            event.system.push({ type: "text", text: priors });
          }
          // Never set event.result: the hook runs before the summary model
          // call, so setting it would skip the native summary (ADR-0003).
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // memory_recall + memory_apply tools: allowlisted recall + the only
    // deterministic apply channel with fail-closed per-line approval (§§5.4, 5.5).
    registrations.push(await registerMemoryTools(ctx));

    // /memory-review command: read+propose phase only — writes nothing,
    // never resets counters (only memory_apply resets, incl. []).
    registrations.push(await registerMemoryReview(ctx));

    // Event subscriber: idle/compaction capture + sampled diagnostics
    // (spec §§5.7, 5.9). Fire-and-forget on the ONE setup controller: the
    // loop never rejects (outer catch) and each dispatch carries its own
    // catch, so a throw on event N never stops event N+1. Location
    // isolation drops foreign events before any write.
    try {
      const ledger = asLedger(ctx.storage);
      const projectID = projectIDOf(ctx);
      const projectDir = projectRootOf(ctx);
      const memoryRoot = join(projectDir, MEMORY_DIR);
      const subscribe = ctx.event?.subscribe;
      if (typeof subscribe === "function") {
        void startEventLoop(
          (opts) => subscribe.call(ctx.event, opts) as AsyncIterable<unknown>,
          {
            signal: controller.signal,
            handleEvent: (event) =>
              dispatchEvent(event, {
                vcs: ctx.vcs as unknown as VcsPort,
                storage: ledger,
                projectID,
                directory: projectDir,
                memoryRoot,
                fileLines: options.fileLines,
                log: logDiagnostic,
              }),
            log: logDiagnostic,
          },
        );
      }
    } catch (error) {
      logDiagnostic(error);
    }

    const projectRoot = projectRootOf(ctx);
    const firstRun = await scaffoldMemoryDir(projectRoot);

    // Unconditional loud warning: effective rules are unverifiable at setup
    // (no acting agent), so scaffold + first-run print are the install channel.
    try {
      console.warn(
        "[memory] install the memory_write → ask rule or per-line approval fails open:\n" +
          permissionsSnippet(),
      );
    } catch {
      // Logging must never break plugin load.
    }

    if (firstRun) {
      try {
        console.log(
          `[memory] scaffolded ${MEMORY_DIR}/ (+ ${HANDOFFS_DIR}/). Options snippet:\n` +
            optionsSnippet() +
            `\nPaste this protocol block into root AGENTS.md (hand-owned, never auto-written):\n` +
            AGENTS_PROTOCOL_BLOCK,
        );
      } catch {
        // Logging must never break plugin load.
      }
    }

    return async () => {
      controller.abort();
      await Promise.all(registrations.map((r) => r.dispose()));
    };
  },
});
