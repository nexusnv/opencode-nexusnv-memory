/** `/memory-gc` (E13): dry-run by default; `--confirm` batch approval. */
import type { Plugin } from "@opencode/plugin";
import { commandFlagValue, tokenizeCommandArgs } from "./args.js";
import { listHandoffsStrict } from "./brief.js";
import {
  logDiagnostic,
  memoryRootOf,
  postCommandOutput,
} from "./command-context.js";
import {
  applyHandoffGc,
  planHandoffGc,
  renderGcPreview,
  renderGcResult,
  type GcPolicy,
} from "./gc.js";

export const MEMORY_GC_COMMAND_NAME = "memory-gc";
export const MEMORY_GC_DESCRIPTION =
  "Garbage-collect root handoff snapshots (dry-run; --confirm deletes)";

export const MEMORY_GC_USAGE = [
  "Usage: /memory-gc [--older-than DAYS] [--keep N] [--confirm]",
  "At least one policy flag is required. Both set = intersection (older AND outside newest N).",
  "Only handoffs/*.md root snapshots are eligible; handoffs/archive/ is never touched.",
  "Without --confirm this prints a dry-run. --confirm asks once for the whole batch.",
  "Deletion is irreversible on this machine; if a handoff is untracked, git cannot recover it. Commit first.",
].join("\n");

type ParseResult =
  | { readonly help: true }
  | { readonly error: string }
  | {
      readonly ok: true;
      readonly policy: GcPolicy;
      readonly confirm: boolean;
    };

export function parseGcArgs(text: string): ParseResult {
  const tokenized = tokenizeCommandArgs(text);
  if (tokenized.error) return { error: tokenized.error };
  const tokens = tokenized.tokens;
  let olderThanDays: number | undefined;
  let keep: number | undefined;
  let confirm = false;
  let dryRun = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--confirm") {
      confirm = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (token === "--older-than" || token.startsWith("--older-than=")) {
      const parsed = commandFlagValue(token, "--older-than", tokens, i);
      if (parsed.error) return { error: parsed.error };
      i = parsed.index;
      const value = Number(parsed.value!);
      if (!/^\d+$/.test(parsed.value!) || !Number.isSafeInteger(value)) {
        return { error: "--older-than requires an integer >= 0" };
      }
      olderThanDays = value;
      continue;
    }
    if (token === "--keep" || token.startsWith("--keep=")) {
      const parsed = commandFlagValue(token, "--keep", tokens, i);
      if (parsed.error) return { error: parsed.error };
      i = parsed.index;
      const value = Number(parsed.value!);
      if (!/^\d+$/.test(parsed.value!) || !Number.isSafeInteger(value)) {
        return { error: "--keep requires an integer >= 0" };
      }
      keep = value;
      continue;
    }
    return { error: `unknown option: ${token}` };
  }
  if (confirm && dryRun) {
    return { error: "--confirm and --dry-run are mutually exclusive" };
  }
  if (olderThanDays === undefined && keep === undefined) {
    return {
      error: `at least one policy flag is required\n\n${MEMORY_GC_USAGE}`,
    };
  }
  return {
    ok: true,
    policy: { olderThanDays, keep },
    confirm,
  };
}

export function registerMemoryGc(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_GC_COMMAND_NAME,
      description: MEMORY_GC_DESCRIPTION,
      execute: async (invocation) => {
        const { sessionID, prompt } = invocation;
        try {
          const parsed = parseGcArgs(
            typeof prompt?.text === "string" ? prompt.text : "",
          );
          if ("help" in parsed) {
            await postCommandOutput(ctx, invocation, MEMORY_GC_USAGE, true);
            return;
          }
          if ("error" in parsed) {
            await postCommandOutput(
              ctx,
              invocation,
              `[memory] gc: ${parsed.error}`,
              true,
            );
            return;
          }
          const listing = await listHandoffsStrict(
            memoryRootOf(ctx),
            "root",
            Number.MAX_SAFE_INTEGER,
          );
          const plan = planHandoffGc(listing.names, parsed.policy);
          if (!parsed.confirm) {
            await postCommandOutput(
              ctx,
              invocation,
              renderGcPreview(plan),
              true,
            );
            return;
          }
          const result = await applyHandoffGc({
            memoryRoot: memoryRootOf(ctx),
            candidates: plan.candidates,
            policy: plan.policy,
            permission: ctx.permission,
            sessionID,
          });
          const delivered = await postCommandOutput(
            ctx,
            invocation,
            renderGcResult(result),
            true,
          );
          if (!delivered) {
            logDiagnostic(
              new Error(
                "[memory] gc completed but its result could not be delivered",
              ),
            );
          }
        } catch (error) {
          await postCommandOutput(
            ctx,
            invocation,
            `[memory] gc failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
          );
        }
      },
    });
  });
}
