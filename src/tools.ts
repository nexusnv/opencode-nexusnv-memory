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
 */
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import {
  clearRotated,
  resetPending,
  type LedgerStorage,
} from "./capture.js";
import { readCapped, writeCapped, type CappedFileOptions } from "./files.js";

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

export const MEMORY_RECALL_INPUT = {
  type: "object",
  properties: { file: { type: "string" } },
  required: ["file"],
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

export interface RecallDeps extends CappedFileOptions {
  /** Absolute path to `.opencode/memory`. */
  readonly memoryRoot: string;
}

export interface ApplyDeps extends CappedFileOptions {
  /** Absolute path to `.opencode/memory`. */
  readonly memoryRoot: string;
  readonly projectID: string;
  readonly storage: LedgerStorage;
  readonly permission: PermissionAsserter;
}

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
 */
export function createMemoryRecallExecute(deps: RecallDeps) {
  return async (
    input: unknown,
    _context: ApplyToolContext,
  ): Promise<{ content: string }> => {
    const file = (input as { file?: unknown }).file;
    return toolResult(
      await readCapped(file as string, {
        memoryRoot: deps.memoryRoot,
        indexLines: deps.indexLines,
        fileLines: deps.fileLines,
      }),
    );
  };
}

/**
 * `memory_apply` executor: the only deterministic apply channel.
 *
 * Per candidate in order: one `permission.assert` (line + `source:` tag in
 * `metadata`, so approval is per line by construction; `save: []` stores
 * nothing on allow-always), then a verbatim `writeCapped` on allow. The
 * first deny/rejection propagates immediately — remaining candidates stay
 * pending, no summary is returned, counters are untouched. On full
 * completion (including `candidates: []`) pending resets to 0 and the
 * rotated marker clears.
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
    if (candidates.length === 0) {
      await resetPending(deps.storage, deps.projectID);
      await clearRotated(deps.storage, deps.projectID);
      return toolResult(
        "No candidates to apply (reviewed-nothing signal); pending review counters reset.",
      );
    }
    let applied = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidateAt(candidates, i);
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
      await writeCapped(candidate.file, candidate.line, {
        memoryRoot: deps.memoryRoot,
        indexLines: deps.indexLines,
        fileLines: deps.fileLines,
      });
      applied += 1;
    }
    await resetPending(deps.storage, deps.projectID);
    await clearRotated(deps.storage, deps.projectID);
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
 * Register both tools via `ctx.tool.transform`. The memory root and project
 * ID resolve per execute call from the live context — never captured once at
 * load (spec P22). Returns the transform registration for disposal.
 */
export function registerMemoryTools(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_recall",
      description: MEMORY_RECALL_DESCRIPTION,
      input: MEMORY_RECALL_INPUT,
      execute: async (input, context) => {
        const execute = createMemoryRecallExecute({
          memoryRoot: memoryRootOf(ctx),
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
        });
        return execute(input, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: context.messageID,
          id: context.id,
        });
      },
    });
  });
}
