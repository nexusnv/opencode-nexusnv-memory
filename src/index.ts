import { Plugin } from "@opencode/plugin";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureFailure,
  dispatchEvent,
  incNotice,
  setNotice,
  snapshotIfDue,
  startEventLoop,
  type LedgerStorage,
  type VcsPort,
} from "./capture.js";
import {
  indexLineCount,
  loadBrief,
  loadPriors,
  truncateLinesWithNotice,
} from "./brief.js";
import { matchIndex, matchRememberNearMiss } from "./hints.js";
import { hasStatusLine, statusLine } from "./status.js";
import { rememberAsserted } from "./provenance.js";
import { registerMemoryReview } from "./review.js";
import { parseMemoryOptions } from "./config.js";
import { writeNewCapped } from "./files.js";
import { registerMemoryTools } from "./tools.js";
import {
  registerStatusCommand,
  registerStatusTool,
} from "./status-report.js";
import { createBump, registerMetricsCommand, setArm } from "./metrics.js";
import {
  ARCHIVE_DIR,
  HANDOFFS_DIR,
  firstRunInstallText,
  getScaffoldFiles,
  hasMemoryProtocolBlock,
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

/** Once-per-process install nudge state (AGENTS.md protocol block missing). */
let agentsProtocolNudgeLogged = false;

/** Test seam: reset the once-per-process install nudge. */
export function resetInstallNudgesForTests(): void {
  agentsProtocolNudgeLogged = false;
}

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
      const outcome = await writeNewCapped(name, content, {
        memoryRoot: dir,
      });
      if (outcome === "created") created = true;
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

    // Metrics taps (M-T3): ONE metrics bump shared by every hook body and
    // the event loop, built once from one ledger adapter over the same
    // plugin-scoped storage the hooks already adapt (the event-loop wiring
    // below reuses this adapter). `bump` is fire-and-forget counters only:
    // never throws sync, never rejects unhandled, and never delays or
    // alters a hook outcome.
    const ledger = asLedger(ctx.storage);
    const projectID = projectIDOf(ctx);
    const bump = createBump(ledger, projectID);

    // Prompt hook: sole INDEX injector + source:user fast path (§§5.1, 5.11).
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        try {
          bump("hook.prompt");
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          event.prompt.files ??= [];
          const abs = join(memoryRoot, "INDEX.md");
          // Exact identity for this project's INDEX (encoded file URL): a
          // different file:// URI that merely shares the suffix must not
          // suppress the legit attach.
          const expectedIndexUri = pathToFileURL(abs).href;
          const already = event.prompt.files.some(
            (f) => typeof f?.uri === "string" && f.uri === expectedIndexUri,
          );
          if (!already) {
            // Over-cap/missing/unreadable INDEX is not attached (no truncation).
            const indexCount = await indexLineCount(abs);
            if (indexCount !== undefined && indexCount <= options.indexLines) {
              event.prompt.files.push({ uri: expectedIndexUri });
              bump("index.attach");
            } else {
              bump("index.overCap");
              if (indexCount !== undefined && indexCount > options.indexLines) {
                // Over-cap (not missing): report the count once on the
                // status line. Best-effort: a rejected notice write must not
                // skip the rest of this hook (e.g. the remember fast path).
                try {
                  await setNotice(ledger, projectID, "indexOverCap", indexCount);
                } catch (error) {
                  logDiagnostic(error);
                }
              }
            }
          } else {
            bump("index.already");
          }
          // One bounded side effect: user-asserted remember → decisions.md.
          if (
            await rememberAsserted(event, {
              storage: ledger,
              projectID,
              memoryRoot,
            })
          ) {
            bump("remember.caught");
          }
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // Context hook: brief + status + hint, budget-capped (§5.2).
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        try {
          bump("hook.context");
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const brief = await loadBrief(memoryRoot, {
            fileLines: options.fileLines,
          });
          // One hint slot: a remember near-miss outranks an INDEX hit for
          // the same prompt (it is an explicit write attempt the user just
          // missed). `matchRememberNearMiss` shares the prompt-hash throttle
          // with `matchIndex`, so at most one of them can fire.
          const rememberHint = await matchRememberNearMiss(event.messages, {
            storage: ledger,
            projectID,
            sessionID: event.sessionID,
            memoryRoot,
          });
          const hint =
            rememberHint ??
            (await matchIndex(event.messages, {
              storage: ledger,
              projectID,
              sessionID: event.sessionID,
              memoryRoot,
            }));
          // Only an INDEX hint is a recall call-to-action. A near-miss nudge
          // must never arm the hint→recall correlation.
          const hintArms = rememberHint === undefined && hint !== undefined;

          // Budget: INDEX (≤indexLines) + brief (≤48) + status (≤1) +
          // hint (≤1) ≤ injectBudgetLines. Overflow truncates the brief
          // first; the status line is dropped before the hint, which is
          // never dropped on a hit. Ordering: brief, status, hint.
          const budget = Math.max(
            0,
            options.injectBudgetLines - options.indexLines,
          );
          const budgetHintCount = hint !== undefined ? 1 : 0;
          // `statusLine` CONSUMES the notices it reports, so render it only
          // when the budget can carry it: a computed-then-dropped line would
          // silently lose its notices. When it cannot fit, classify a
          // would-be line from a pure read — nothing is consumed and the
          // notices stay queued for a later turn.
          const statusFits = budget >= budgetHintCount + 1;
          const status = statusFits
            ? await statusLine(ledger, projectID, {
                indexLines: options.indexLines,
              })
            : undefined;
          const statusDroppedByBudget =
            !statusFits && (await hasStatusLine(ledger, projectID));
          const rawBrief = brief === "" ? [] : brief.split("\n");
          let briefLines = rawBrief;
          let keepStatus = status !== undefined;
          // Classifier flags, set at their true sites (M-T3 hygiene): the
          // truncation classifier is "a budget branch ran" and the status
          // drop classifier is computed above (a would-be line the budget
          // cannot carry) — never a reference comparison against `rawBrief`
          // (`truncateLinesWithNotice` returning a fresh array is not a
          // documented contract to lean on).
          let briefTruncated = false;
          const hintKept = hint !== undefined;
          const hintCount = hintKept ? 1 : 0;
          const total = () =>
            briefLines.length + (keepStatus ? 1 : 0) + hintCount;
          if (total() > budget) {
            briefLines = truncateLinesWithNotice(
              rawBrief,
              Math.max(0, budget - (keepStatus ? 1 : 0) - hintCount),
            );
            briefTruncated = true;
          }
          if (total() > budget) {
            // With `statusFits` false above, `status` (and so `keepStatus`)
            // is already false when the budget cannot carry the line; this
            // branch then only re-truncates the brief.
            keepStatus = false;
            briefLines = truncateLinesWithNotice(
              rawBrief,
              Math.max(0, budget - hintCount),
            );
            briefTruncated = true;
          }

          // M-T3 taps below: classification uses only these flags and
          // in-scope variables. Truncation = a budget branch ran
          // (briefTruncated) and actually cut brief content
          // (`rawBrief.length > 0`): a vacuous `truncateLinesWithNotice`
          // on an empty brief must not claim `brief.truncated`.
          if (briefTruncated && rawBrief.length > 0) {
            bump("brief.truncated");
          }

          if (briefLines.length > 0) {
            event.system.push({ type: "text", text: briefLines.join("\n") });
            bump("brief.injected");
            bump("brief.lines", briefLines.length);
          } else if (brief === "") {
            bump("brief.empty");
          }
          if (keepStatus && status !== undefined) {
            event.system.push({ type: "text", text: status });
            bump("status.shown");
          } else if (statusDroppedByBudget) {
            // A status line the budget could not carry, classified above by
            // a pure read: the notices were NOT consumed and stay queued.
            bump("status.dropped");
          }
          if (hint !== undefined) {
            event.system.push({ type: "text", text: hint });
            bump("hint.shown");
            // Arm the hint→recall correlation only for an INDEX hint
            // (decision 4: awaited; `setArm` is itself never-throw/never-
            // reject, so the await cannot surface a failure to this hook).
            if (hintArms) {
              await setArm(ledger, projectID, event.sessionID);
            }
          }

          // Throttled handoff writer: fire-and-forget, never awaited.
          void snapshotIfDue(ledger, projectID, event.sessionID, {
            throttleMinutes: options.snapshotThrottleMinutes,
            vcs: ctx.vcs as unknown as VcsPort,
            memoryRoot,
            fileLines: options.fileLines,
            bump,
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
          bump("hook.compaction");
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const priors = await loadPriors(memoryRoot, {
            fileLines: options.fileLines,
          });
          if (priors.length > 0) {
            event.system.push({ type: "text", text: priors });
            bump("compaction.priors");
            bump("priors.lines", priors.split("\n").length);
          }
          // Never set event.result: the hook runs before the summary model
          // call, so setting it would skip the native summary (ADR-0003).
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // execute.after hook: failure-only capture → activeContext.md (§5.3).
    // Failures only (successes ignored); captureFailures:false disables the
    // channel entirely; the body never throws (a throwing tool hook can
    // disturb tool-result delivery).
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          if ((event as { status?: string }).status !== "error") return;
          if (!options.captureFailures) return;
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const outcome = await captureFailure(
            event,
            ledger,
            projectID,
            memoryRoot,
            {
              fileLines: options.fileLines,
              indexLines: options.indexLines,
              log: logDiagnostic,
            },
          );
          // M-T3 failure tap: explicit CaptureReason → §5.12 counter
          // mapping (never the raw reason string; `skipped` bumps nothing).
          switch (outcome.reason) {
            case "captured":
              bump("failure.captured");
              break;
            case "duplicate":
              bump("failure.duplicate");
              break;
            case "retry-later":
              bump("failure.retry");
              break;
            case "failed":
              bump("failure.failed");
              // Write-guard rejections are actionable (over cap / no
              // rotatable block): surface a count-only notice once on the
              // status line.
              if (outcome.failureKind === "write-rejected") {
                await incNotice(ledger, projectID, "captureFailed");
              }
              break;
            case "skipped":
              // No counter for a skip (non-error/disable paths).
              break;
            default: {
              // Exhaustiveness guard: a new CaptureReason must extend
              // this mapping explicitly (TS narrows an unhandled reason
              // to `never` here, so the addition fails to compile
              // instead of bumping nothing forever). Unreachable with
              // the current union — and this hook body's try/catch
              // catches any belt-and-braces throw anyway.
              const never: never = outcome.reason;
              throw new Error(`unreachable outcome reason: ${String(never)}`);
            }
          }
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // memory_recall + memory_apply tools: allowlisted recall + the only
    // deterministic apply channel with fail-closed per-line approval (§§5.4, 5.5).
    registrations.push(await registerMemoryTools(ctx));

    // /memory-review command: read+propose phase only — writes nothing,
    // never resets counters (only memory_apply resets, incl. []); its one
    // §5.12 exception is the count-only `review.invoked` metrics bump
    // (ADR-0008: diagnostics, never content, never a memory write).
    registrations.push(await registerMemoryReview(ctx));

    // /memory-metrics command: local-only count dashboard — never writes a
    // memory file (wipes counter keys only on `reset confirm`; bare `reset`
    // renders the confirmation notice); deps resolve per call from the live
    // context (spec P22).
    registrations.push(await registerMetricsCommand(ctx));

    // /memory-status command + memory_status tool: read-only install/health
    // report. Posts via synthetic (no model turn) with the §5.5 fallback;
    // never writes memory and never bumps a counter (the §5.12 vocabulary
    // is frozen).
    registrations.push(await registerStatusCommand(ctx));
    registrations.push(await registerStatusTool(ctx));

    // Event subscriber: idle/compaction capture + sampled diagnostics
    // (spec §§5.7, 5.9). Fire-and-forget on the ONE setup controller: the
    // loop never rejects (outer catch) and each dispatch carries its own
    // catch, so a throw on event N never stops event N+1. Location
    // isolation drops foreign events before any write.
    try {
      // Reuses the adapter + projectID hoisted at the top of setup (same
      // storage + projectIdentity) — no duplicate per-site build.
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
                bump,
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
    // First run consolidates every install action into ONE message (E12); the
    // non-first-run path keeps the spec §4.4 standalone permission warning.
    try {
      if (firstRun) {
        console.warn(firstRunInstallText());
      } else {
        console.warn(
          "[memory] install the memory_write → ask rule or per-line approval fails open:\n" +
            permissionsSnippet(),
        );
      }
    } catch {
      // Logging must never break plugin load.
    }

    if (!firstRun) {
      // Non-first-run installs with a hand-owned AGENTS.md that predates the
      // protocol block never see the first-run print; nudge once per process.
      // A missing/unreadable AGENTS.md stays silent (a global block may exist).
      try {
        const agentsText = await readFile(
          join(projectRoot, "AGENTS.md"),
          "utf8",
        );
        if (!agentsProtocolNudgeLogged && !hasMemoryProtocolBlock(agentsText)) {
          agentsProtocolNudgeLogged = true;
          console.warn(
            "[memory] root AGENTS.md has no memory protocol block; the agent will not read memory. Paste the block printed on first run (or in the README install section).",
          );
        }
      } catch {
        // Missing/unreadable AGENTS.md: nothing to check.
      }
    }

    return async () => {
      controller.abort();
      await Promise.all(registrations.map((r) => r.dispose()));
    };
  },
});
