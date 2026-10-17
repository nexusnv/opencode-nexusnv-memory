/**
 * memory_recall + memory_apply tools (spec §§5.4, 5.5 + c4-04 + c4-06).
 *
 * `toolResult(text)` is the single adapter for the tool-executor return
 * envelope (`{ content: text }` by default; G2). Every tool return goes
 * through it.
 *
 * `memory_recall` is the allowlisted read channel: `{ file }` in,
 * `{ content }` out via `readCapped` (cap + notice + redaction + traversal
 * rejects). Its description doubles as the retrieval policy (spec §5.4).
 * Archive paths are recallable on demand, never auto-injected (handled by
 * `readCapped`, not duplicated here).
 *
 * `memory_apply` is the ONLY deterministic apply channel: per candidate, in
 * order, one `permission.assert({ action: "memory_write", ... })` and then a
 * verbatim `writeCapped` on allow. The first deny/reject propagates
 * immediately (remaining candidates stay pending, no summary). Completion —
 * including the `candidates: []` reviewed-nothing signal — resets
 * `<projectID>/curation.pending` → 0 and clears `<projectID>/curation.rotated`.
 *
 * Fail-closed note (spec §4.4): per-line approval holds only with the shipped
 * `memory_write → ask` rule installed. Without it the request matches only
 * the base `* / * → allow` wildcard and resolves silently, so the gate fails
 * open. Setup emits an unconditional loud warning about this (src/index.ts).
 *
 * §5.12 metric taps: every executor carries an optional `bump` (recall/
 * apply) and recall additionally an optional `arm` transport — both undefined
 * = silent no-op, so a tap-free construction behaves exactly as before.
 * `memory_metrics` is the read-only metrics query: empty input, resolves the
 * readers per call (P22) and returns `collectAndRender`'s markdown count
 * table via the same `toolResult` adapter — it reads storage/files only,
 * never writes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import {
  clearRotated,
  resetPending,
  type LedgerStorage,
} from "./capture.js";
import { DEFAULT_MEMORY_OPTIONS, parseMemoryOptions } from "./config.js";
import {
  assertAllowedPath,
  countLines,
  getCapForFile,
  readCapped,
  resolveMemoryRoot,
  updateCapped,
  type CappedFileOptions,
} from "./files.js";
import {
  clearArm,
  collectAndRender,
  metricsBumpOf,
  readArmed,
  type MetricName,
  type MetricsBump,
} from "./metrics.js";
import { redact } from "./redact.js";

/** Fixed memory root, relative to the project (spec ADR-0006; not configurable). */
const MEMORY_DIR = ".opencode/memory";

/** Single adapter for the tool-executor return envelope (G2). */
export function toolResult(text: string): { content: string } {
  return { content: text };
}

/**
 * Normative retrieval policy (spec §5.4): the description IS the policy —
 * when to recall, and when to work from current code alone.
 */
export const MEMORY_RECALL_DESCRIPTION =
  "Past project decisions, renames, and rejected alternatives (capped). Use when the user asks why something is named/designed this way, when touching a contract or previously-renamed symbol, or when INDEX.md mentions the area. Do not use for fresh implementation from current code alone.";

export const MEMORY_APPLY_DESCRIPTION =
  "Apply human-approved memory lines deterministically (per-line approval). Input is the reviewed candidate table: target file, exact line, and provenance source. Each line prompts separately via the memory_write permission rule; the first deny stops the batch with the rest still pending.";

/** §5.12 tool row, normative wording for the read-only metrics query. */
export const MEMORY_METRICS_DESCRIPTION =
  "Local usage metrics of the memory plugin: counters for explicit calls (recall/apply/review) and behind-the-scenes outcomes (captures, truncations, denials, hint→recall), plus memory-file health. Counts only — no content. Use when the user asks about the plugin's activity or its stored stats.";

export const MEMORY_RECALL_INPUT = {
  type: "object",
  properties: { file: { type: "string" } },
  required: ["file"],
  additionalProperties: false,
} as const;

/** §5.12 tool row: the metrics query takes no arguments (empty object). */
export const MEMORY_METRICS_INPUT = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

const APPLY_SOURCES = ["user", "tool", "model", "snapshot"] as const;

export type ApplySource = (typeof APPLY_SOURCES)[number];

export interface ApplyCandidate {
  readonly file: string;
  readonly line: string;
  readonly source: ApplySource;
  readonly flags?: readonly string[];
}

export const MEMORY_APPLY_INPUT = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "string" },
          source: { type: "string", enum: [...APPLY_SOURCES] },
          flags: { type: "array", items: { type: "string" } },
        },
        required: ["file", "line", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

/**
 * Minimum surface of `ctx.permission` the apply executor needs. Method
 * shorthand keeps this bivariant so both the real `ctx.permission` and test
 * fakes satisfy it (same pattern as `LedgerStorage` in src/capture.ts).
 */
export interface PermissionAsserter {
  assert(input: {
    readonly sessionID: string;
    readonly agent?: string;
    readonly action: string;
    readonly resources: readonly string[];
    readonly metadata?: Record<string, unknown>;
    readonly source?: {
      readonly type: "tool";
      readonly messageID: string;
      readonly id: string;
    };
    readonly save?: readonly string[];
  }): Promise<void>;
}

/** Executor-bound tool context: IDs come from the tool call, not the command. */
export interface ApplyToolContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
}

/**
 * The arm transport `memory_recall` consults on success (§5.12 hint→recall
 * correlation): whether the context hook armed this session's hint flag
 * (`<projectID>/metrics/arm/hint/<sessionID>`, the int `1`), and a clear
 * for consuming it on first use. The flag lives in the metrics namespace,
 * which is why `bump` alone can neither read nor clear it. Method shorthand
 * keeps the shape bivariant so both the real wiring and test fakes satisfy
 * it (same pattern as `PermissionAsserter`).
 */
export interface MetricsArm {
  /** True when `hint.shown` armed this session's hint flag (§5.12). */
  readArmed(sessionID: string): Promise<boolean>;
  /** Consume the flag: clear is awaited before the `hint.recall` bump. */
  clearArm(sessionID: string): Promise<void>;
}

export interface RecallDeps extends CappedFileOptions {
  /** Absolute path to `.opencode/memory`. */
  readonly memoryRoot: string;
  /** §5.12 recall taps; undefined = silent no-op (no metrics at all). */
  readonly bump?: MetricsBump;
  /** Hint→recall arm transport; undefined = never read or cleared. */
  readonly arm?: MetricsArm;
}

export interface ApplyDeps extends CappedFileOptions {
  /** Absolute path to `.opencode/memory`. */
  readonly memoryRoot: string;
  readonly projectID: string;
  readonly storage: LedgerStorage;
  readonly permission: PermissionAsserter;
  /** §5.12 apply taps; undefined = silent no-op (no metrics at all). */
  readonly bump?: MetricsBump;
}

/**
 * Six-name classifier (§5.12 recall row): every allowlisted structural file
 * maps to its LITERAL counter — the name is never templated from the
 * request path (the vocabulary is enumerated fail-closed, so templating
 * could only ever drop unknown names, but the explicit set→name mapping
 * documents the classification contract). Any other successful read is a
 * `handoffs/…` path (the only allowlist remainder) → the handoff aggregate.
 */
// Null-prototype lookup keyed dictionary: a bare `constructor` probe
// returns undefined, never the inherited `Object` function — unmapped
// names must keep classifying to the handoff aggregate, fail-closed.
const RECALL_FILE_COUNTERS: Readonly<Record<string, MetricName | undefined>> =
  Object.freeze(
    Object.assign(Object.create(null), {
      "INDEX.md": "recall.INDEX.md",
      "activeContext.md": "recall.activeContext.md",
      "decisions.md": "recall.decisions.md",
      "architecture.md": "recall.architecture.md",
      "style.md": "recall.style.md",
      "issues.md": "recall.issues.md",
    }),
  );

function candidateAt(candidates: unknown, index: number): ApplyCandidate {
  const raw = (candidates as readonly unknown[])[index] as Record<
    string,
    unknown
  >;
  const file = raw["file"];
  const line = raw["line"];
  const source = raw["source"];
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`[memory] memory_apply candidate ${index}: file must be a non-empty string`);
  }
  if (typeof line !== "string") {
    throw new Error(`[memory] memory_apply candidate ${index}: line must be a string`);
  }
  if (line.trim().length === 0) {
    throw new Error(`[memory] memory_apply candidate ${index}: line must be a non-empty string`);
  }
  if (!APPLY_SOURCES.includes(source as ApplySource)) {
    throw new Error(
      `[memory] memory_apply candidate ${index}: source must be one of ${APPLY_SOURCES.join("|")}`,
    );
  }
  return { file, line, source: source as ApplySource };
}

/**
 * `memory_recall` executor: allowlisted read via the `readCapped` choke
 * point. Unknown/traversal/missing paths throw (never list the filesystem).
 *
 * §5.12 taps (fire-and-forget, best-effort — metrics never alter the tool
 * outcome): the six structural names bump their literal counters, any other
 * successful read bumps the `handoff` aggregate, and a rejection bumps
 * `recall.error` in the catch before RETHROWING THE ORIGINAL ERROR UNCHANGED
 * (identity preserved — metrics never mask a failure). On success it also
 * consumes the hint→recall arm (§5.12): readArmed → if armed, the awaited
 * clearArm THEN the fire-and-forget `hint.recall` bump, clear-first so a
 * crash between the two cannot double-count the conversion on replay; the
 * block is best-effort wrapped because `readArmed` is a plain storage read
 * that may reject, and such an arm hiccup must never turn a successful
 * recall into an error.
 */
export function createMemoryRecallExecute(deps: RecallDeps) {
  return async (
    input: unknown,
    context: ApplyToolContext,
  ): Promise<{ content: string }> => {
    const file = (input as { file?: unknown }).file as string;
    // The catch scope is exactly the readCapped rejection: `recall.error`
    // marks a failed READ only, then the SAME error object propagates
    // unchanged (identity preserved — metrics never mask a failure). All
    // success bookkeeping lives outside the try so the failure counter's
    // meaning cannot widen to bookkeeping throws.
    let content: string;
    try {
      content = await readCapped(file, {
        memoryRoot: deps.memoryRoot,
        indexLines: deps.indexLines,
        fileLines: deps.fileLines,
      });
    } catch (error) {
      deps.bump?.("recall.error");
      throw error;
    }
    // Success counter: the six-name classifier → literal name, else the
    // handoff aggregate.
    deps.bump?.(RECALL_FILE_COUNTERS[file] ?? "recall.handoff");
    // Hint→recall conversion (§5.12). Clear is awaited BEFORE the bump
    // so a crashed process replays at most one uncounted flag, never a
    // double count.
    if (deps.arm) {
      try {
        const armed = await deps.arm.readArmed(context.sessionID);
        if (armed) {
          await deps.arm.clearArm(context.sessionID);
          deps.bump?.("hint.recall");
        }
      } catch {
        // Best-effort conversion: an arm read/clear failure must never
        // fail a recall that already succeeded. The inner catch defends
        // the *port* contract — `readArmed` is a plain get that can
        // reject, while `clearArm` is already never-throw at the impl
        // layer (ADR-0008 §3) — belt-and-braces, not duplication.
      }
    }
    return toolResult(content);
  };
}

/**
 * Raw read for cap projection only (no cap, no redaction — the projection
 * replicates the `updateCapped` merge and counts redacted lines itself).
 * Resolves `""` when the file does not exist yet; other IO errors propagate
 * (fail-closed, like a deny). Validates the path (M-5 defense-in-depth: the
 * caller already asserts, but the helper must never read outside the root
 * on its own).
 */
async function readRawForProjection(
  memoryRoot: string,
  file: string,
): Promise<string> {
  assertAllowedPath(file);
  try {
    return await readFile(join(resolveMemoryRoot(memoryRoot), file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Batch cap preflight: project every target file's line count after the
 * whole batch and reject before the first prompt when a capped file would
 * overflow. Advisory only (M-5): the projection reads outside `withWriteLock`
 * and runs before the per-line `permission.assert` round-trips, so a
 * concurrent grow (second batch, captureFailure append, hand-edit) or a
 * rotation-exempt `activeContext.md` without a Known-errors block can still
 * throw mid-batch. Callers surface the applied-count on failure so a retry
 * can resume without blindly duplicating the already-durable prefix (which
 * has no content-ID dedupe). `activeContext.md` is exempt (rotation, not
 * rejection) and `decisions.md` is unbounded; both still go through the
 * per-line prompts and atomic appends below.
 */
async function preflightBatchCaps(
  parsed: readonly ApplyCandidate[],
  deps: ApplyDeps,
  indexLines: number,
  fileLines: number,
): Promise<void> {
  const byFile = new Map<string, string[]>();
  for (const candidate of parsed) {
    const lines = byFile.get(candidate.file) ?? [];
    lines.push(candidate.line);
    byFile.set(candidate.file, lines);
  }
  for (const [file, lines] of byFile) {
    const cap = getCapForFile(file, indexLines, fileLines);
    if (!Number.isFinite(cap)) continue;
    if (file === "activeContext.md") continue;
    const current = await readRawForProjection(deps.memoryRoot, file);
    let merged = current;
    for (const line of lines) {
      merged =
        merged === ""
          ? line
          : merged.endsWith("\n")
            ? merged + line
            : `${merged}\n${line}`;
    }
    if (countLines(redact(merged)) > (cap as number)) {
      throw new Error(
        `[memory] memory_apply rejected: batch would put ${file} over its ${cap}-line cap; nothing was written and no approval was requested`,
      );
    }
  }
}

/**
 * `memory_apply` executor: the only deterministic apply channel.
 *
 * Per candidate in order: allowlist-validate, then one `permission.assert`
 * (line + `source:` tag in `metadata`, so approval is per line by
 * construction; `save: []` stores nothing on allow-always), then a verbatim
 * append via atomic `updateCapped` on allow (read-modify-write inside the
 * choke-point lock, so concurrent same-file batches cannot drop each other;
 * same-file candidates accumulate in order instead of clobbering each other).
 * The first deny/rejection propagates immediately — remaining candidates stay
 * pending, no summary is returned, and the curation counters stay untouched
 * (the §5.12 metrics taps still count the call/denial). On full
 * completion (including `candidates: []`) pending resets to 0 and the
 * rotated marker clears.
 *
 * §5.12 taps (fire-and-forget, beside the correctness counters): `apply.batch`
 * once per shape-valid call (the `candidates: []` signal is also a call),
 * `apply.lines` by candidate count on entry (zero is skipped — the fail-closed
 * guard drops non-positive deltas), `apply.denied` per rejected line,
 * `apply.partialError` when a write fails with ≥1 line already applied (the
 * specification's own definition), and `apply.reset` next to every completion
 * reset (both terminal paths incl. `candidates: []`).
 */
export function createMemoryApplyExecute(deps: ApplyDeps) {
  return async (
    input: unknown,
    context: ApplyToolContext,
  ): Promise<{ content: string }> => {
    const candidates = (input as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) {
      throw new Error("[memory] memory_apply candidates must be an array");
    }
    // One per call (§5.12) — shape-valid invocations, empty included;
    // malformed (non-array) input throws before entering the flow.
    deps.bump?.("apply.batch");
    if (candidates.length === 0) {
      await resetPending(deps.storage, deps.projectID);
      await clearRotated(deps.storage, deps.projectID);
      deps.bump?.("apply.reset");
      return toolResult(
        "No candidates to apply (reviewed-nothing signal); pending review counters reset.",
      );
    }
    // Lines follow the candidate count (§5.12 "by candidate count"); zero
    // deltas never reach `bump` (its guard would warn + drop them).
    deps.bump?.("apply.lines", candidates.length);
    const indexLines = deps.indexLines ?? DEFAULT_MEMORY_OPTIONS.indexLines;
    const fileLines = deps.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines;
    // Validate everything up front: shape, allowlist, then whole-batch caps.
    // A batch that cannot fit is rejected before the first approval prompt.
    // The preflight is advisory under concurrency (see above): a mid-batch
    // cap throw reports how many lines already landed so the operator can
    // resume instead of re-applying the whole batch (which would duplicate).
    const parsed = candidates.map((_, i) => candidateAt(candidates, i));
    for (const candidate of parsed) assertAllowedPath(candidate.file);
    await preflightBatchCaps(parsed, deps, indexLines, fileLines);
    let applied = 0;
    for (let i = 0; i < parsed.length; i += 1) {
      const candidate = parsed[i]!;
      // Deny propagates as the SAME error object (identity-preserved:
      // callers/tests rely on `rejects.toBe`), with the applied count
      // attached so a denial after earlier writes is still resumable
      // without blindly duplicating the durable prefix.
      try {
        await deps.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          action: "memory_write",
          resources: [candidate.file],
          metadata: { line: candidate.line, source: candidate.source },
          source: {
            type: "tool",
            messageID: context.messageID,
            id: context.id,
          },
          save: [],
        });
      } catch (deny) {
        // §5.12: one counter per rejected line (the executor stops at the
        // first); the deny itself still propagates unchanged below.
        deps.bump?.("apply.denied");
        try {
          (deny as { memoryApplied?: number }).memoryApplied = applied;
        } catch {
          // Property attach is best-effort; the deny itself still propagates.
        }
        throw deny;
      }
      try {
        await updateCapped(
          candidate.file,
          {
            memoryRoot: deps.memoryRoot,
            indexLines,
            fileLines,
          },
          (current) =>
            current === ""
              ? candidate.line
              : current.endsWith("\n")
                ? current + candidate.line
                : `${current}\n${candidate.line}`,
        );
      } catch (error) {
        // §5.12: partial errors are counted only when ≥1 line already
        // landed (nothing partial has landed at applied=0 — the throw
        // below still reports the applied count). Fire-and-forget, then
        // the resume guidance propagates as before.
        if (applied >= 1) deps.bump?.("apply.partialError");
        throw new Error(
          `[memory] memory_apply failed at candidate ${i} after ${applied} applied (${candidate.file} over cap or concurrent grow); ${parsed.length - applied} candidate(s) remain pending and already-applied lines must not be re-applied blindly: ${(error as Error)?.message ?? error}`,
        );
      }
      applied += 1;
    }
    await resetPending(deps.storage, deps.projectID);
    await clearRotated(deps.storage, deps.projectID);
    // Completion reset counts (§5.12: "on the completion reset incl.
    // candidates: []" — post-reset so a failing reset is not over-counted).
    deps.bump?.("apply.reset");
    return toolResult(`Applied ${applied} approved line(s) to memory.`);
  };
}

function memoryRootOf(ctx: Plugin.Context): string {
  const base = (
    ctx.location.project?.canonical ?? ctx.location.directory
  ).replace(/\/+$/, "");
  return join(base, MEMORY_DIR);
}

function projectIDOf(ctx: Plugin.Context): string {
  return ctx.location.project?.id ?? ctx.location.directory;
}

/** Adapt the plugin-scoped `ctx.storage` to the ledger's structural port. */
function ledgerOf(ctx: Plugin.Context): LedgerStorage {
  return {
    get: (key) => ctx.storage.get(key),
    set: (key, value) =>
      ctx.storage.set(
        key,
        value as Parameters<Plugin.Context["storage"]["set"]>[1],
      ),
    remove: (key) => ctx.storage.remove(key),
    scan: (options) => ctx.storage.scan(options),
  };
}

/**
 * The §5.12 hint→recall arm transport for the recall executor: the real
 * flag lives under `<projectID>/metrics/arm/hint/<sessionID>` over the
 * ledger, so the executor needs these two partials resolved against the
 * live context (spec P22 — never captured once at load).
 */
function armOf(ctx: Plugin.Context): MetricsArm {
  const storage = ledgerOf(ctx);
  const projectID = projectIDOf(ctx);
  return {
    readArmed: (sessionID) => readArmed(storage, projectID, sessionID),
    clearArm: (sessionID) => clearArm(storage, projectID, sessionID),
  };
}

/**
 * Register all three tools via `ctx.tool.transform` (spec §5.4/§5.12):
 * `memory_recall`, `memory_apply`, and the read-only `memory_metrics`
 * query. The memory root and project ID resolve per execute call from the
 * live context — never captured once at load (spec P22); caps come from the
 * plugin options (same parse as setup). Returns the transform registration
 * for disposal.
 */
export function registerMemoryTools(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  // Caps come from the plugin options (same parse as setup); the memory
  // root and project ID still resolve per execute call from the live
  // context — never captured once at load (spec P22).
  const options = parseMemoryOptions(ctx.options);
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_recall",
      description: MEMORY_RECALL_DESCRIPTION,
      input: MEMORY_RECALL_INPUT,
      execute: async (input, context) => {
        const execute = createMemoryRecallExecute({
          memoryRoot: memoryRootOf(ctx),
          indexLines: options.indexLines,
          fileLines: options.fileLines,
          bump: metricsBumpOf(ctx),
          arm: armOf(ctx),
        });
        return execute(input, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: context.messageID,
          id: context.id,
        });
      },
    });
    editor.add({
      name: "memory_apply",
      description: MEMORY_APPLY_DESCRIPTION,
      input: MEMORY_APPLY_INPUT,
      execute: async (input, context) => {
        const execute = createMemoryApplyExecute({
          memoryRoot: memoryRootOf(ctx),
          projectID: projectIDOf(ctx),
          storage: ledgerOf(ctx),
          permission: ctx.permission,
          indexLines: options.indexLines,
          fileLines: options.fileLines,
          bump: metricsBumpOf(ctx),
        });
        return execute(input, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: context.messageID,
          id: context.id,
        });
      },
    });
    editor.add({
      name: "memory_metrics",
      description: MEMORY_METRICS_DESCRIPTION,
      input: MEMORY_METRICS_INPUT,
      // Read-only §5.12 query (spec tool row): empty input, deps resolve
      // per call from the live context (P22), and the rendered markdown
      // count table returns through the single toolResult adapter. No
      // storage set/remove, no memory body reads.
      execute: async () =>
        toolResult(
          await collectAndRender({
            storage: ledgerOf(ctx),
            projectID: projectIDOf(ctx),
            memoryRoot: memoryRootOf(ctx),
            caps: {
              indexLines: options.indexLines,
              fileLines: options.fileLines,
            },
          }),
        ),
    });
  });
}
