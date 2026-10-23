import { Plugin } from "@opencode/plugin";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureFailure,
  dispatchEvent,
  incNotice,
  setNotice,
  snapshotIfDue,
  startEventLoop,
  type VcsPort,
} from "./capture.js";
import {
  asLedger,
  logDiagnostic,
  MEMORY_DIR,
  projectIDOf,
  projectRootOf,
} from "./command-context.js";
import {
  indexLineCount,
  loadBrief,
  loadPriors,
  newestHandoffLine,
} from "./brief.js";
import { matchIndex, matchRememberNearMiss } from "./hints.js";
import {
  appendPromptNotices,
  briefInjectionCap,
  hasPromptNotices,
  planPromptNotices,
  promptNoticeBudget,
  promptStatusFits,
} from "./prompt-notices.js";
import { hasStatusLine, statusLine } from "./status.js";
import { rememberAsserted } from "./provenance.js";
import { registerMemoryReview } from "./review.js";
import { parseMemoryOptions } from "./config.js";
import { TRUNCATION_NOTICE_LINE, writeNewCapped } from "./files.js";
import { registerMemoryTools } from "./tools.js";
import { registerMemoryForget } from "./forget-command.js";
import { registerMemoryGc } from "./gc-command.js";
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
      try {
        await access(join(dir, name));
        continue;
      } catch {
        // Missing (or unreadable): fall through to the exclusive create.
      }
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

    // Prompt hook: sole INDEX injector, volatile prompt-tail notices, and
    // source:user fast path (§§5.1, 5.2, 5.11).
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
            const indexCount = await indexLineCount(
              abs,
              memoryRoot,
              options.indexLines,
            );
            if (indexCount !== undefined && indexCount <= options.indexLines) {
              event.prompt.files.push({ uri: expectedIndexUri });
              bump("index.attach");
            } else if (
              indexCount !== undefined &&
              indexCount > options.indexLines
            ) {
              bump("index.overCap");
              // Over-cap (not missing): report the count once on the
              // status line. Best-effort: a rejected notice write must not
              // skip the rest of this hook (e.g. the remember fast path).
              try {
                await setNotice(ledger, projectID, "indexOverCap", indexCount);
              } catch (error) {
                logDiagnostic(error);
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
          // Volatile memory notices ride on the canonical user prompt, after
          // the user's own text, as labelled data. The marker makes a retried
          // admission idempotent; the stable system prefix stays untouched.
          const promptText =
            typeof event.prompt.text === "string" ? event.prompt.text : "";
          if (!hasPromptNotices(promptText)) {
            const noticeBudget = promptNoticeBudget(
              options.indexLines,
              options.injectBudgetLines,
            );
            const rememberHint = await matchRememberNearMiss(promptText, {
              storage: ledger,
              projectID,
              sessionID: event.sessionID,
              memoryRoot,
            });
            const hint =
              rememberHint ??
              (await matchIndex(promptText, {
                storage: ledger,
                projectID,
                sessionID: event.sessionID,
                memoryRoot,
                indexLines: options.indexLines,
              }));
            const hintArms =
              rememberHint === undefined && hint !== undefined;
            const statusFits = promptStatusFits(
              noticeBudget,
              hint !== undefined,
            );
            // Pure precheck first: prompt admission must not queue behind
            // ledger writes when there is nothing to consume.
            const hasStatus = await hasStatusLine(ledger, projectID);
            const status =
              statusFits && hasStatus
                ? await statusLine(ledger, projectID, {
                    indexLines: options.indexLines,
                  })
                : undefined;
            const statusDroppedByBudget = !statusFits && hasStatus;
            const handoff = await newestHandoffLine(memoryRoot);
            const plan = planPromptNotices({
              handoff,
              status,
              hint,
              budget: noticeBudget,
            });
            if (plan.text.length > 0) {
              event.prompt.text = appendPromptNotices(promptText, plan.text);
            }
            if (status !== undefined) {
              bump("status.shown");
            } else if (statusDroppedByBudget) {
              bump("status.dropped");
            }
            if (hint !== undefined) {
              bump("hint.shown");
              if (hintArms) {
                await setArm(ledger, projectID, event.sessionID);
              }
            }
          }
        } catch (error) {
          logDiagnostic(error);
        }
      }),
    );

    // Context hook: stable brief only, dynamically budget-capped (§5.2).
    // Status, hint, and the newest-handoff pointer are prompt-tail notices,
    // so this per-model-call system prefix carries only the brief and never
    // any volatile notice.
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        try {
          bump("hook.context");
          const ledger = asLedger(ctx.storage);
          const projectID = projectIDOf(ctx);
          const memoryRoot = join(projectRootOf(ctx), MEMORY_DIR);
          const briefCap = briefInjectionCap(
            options.indexLines,
            options.injectBudgetLines,
          );
          const brief = await loadBrief(memoryRoot, {
            fileLines: options.fileLines,
            maxLines: briefCap,
          });
          const briefLines = brief === "" ? [] : brief.split("\n");
          const lastBriefLine = briefLines[briefLines.length - 1];
          if (
            lastBriefLine !== undefined &&
            TRUNCATION_NOTICE_LINE.test(lastBriefLine)
          ) {
            bump("brief.truncated");
          }
          if (briefLines.length > 0) {
            event.system.push({ type: "text", text: briefLines.join("\n") });
            bump("brief.injected");
            bump("brief.lines", briefLines.length);
          } else if (briefCap > 0) {
            bump("brief.empty");
          }
          // Throttled handoff writer remains per-model-call and fire-and-forget.
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

    // /memory-forget and /memory-gc: user-invoked lifecycle commands.
    // Dry-run by default; --confirm applies per-unit (forget) or one batch
    // (GC) approval. Neither is exposed as a model-facing tool.
    registrations.push(await registerMemoryForget(ctx));
    registrations.push(await registerMemoryGc(ctx));

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
