/**
 * `/memory-forget` (E13, ADR-0009): dry-run by default, `--confirm` for
 * per-unit approval. The command never holds the write lock while a human
 * decides; `applyForget` re-plans after approvals and aborts on drift.
 */
import type { Plugin } from "@opencode/plugin";
import { commandFlagValue, tokenizeCommandArgs } from "./args.js";
import {
  asLedger,
  logDiagnostic,
  memoryRootOf,
  postCommandOutput,
  projectIDOf,
} from "./command-context.js";
import { incNotice } from "./capture.js";
import { parseMemoryOptions } from "./config.js";
import {
  applyForget,
  FORGETTABLE_FILES,
  previewForget,
  renderForgetResult,
  type ForgetSelector,
} from "./forget.js";

export const MEMORY_FORGET_COMMAND_NAME = "memory-forget";
export const MEMORY_FORGET_DESCRIPTION =
  "Forget active memory lines (dry-run; --confirm archives first)";

export const MEMORY_FORGET_USAGE = [
  "Usage: /memory-forget <file> (--line N | --match TEXT | --all) [--confirm] [--reason TEXT]",
  `Files: ${FORGETTABLE_FILES.join(", ")}`,
  "Without --confirm this prints a dry-run. --confirm asks once per line/block.",
  "decisions.md and handoffs are immutable; use /memory-gc for root handoff snapshots.",
  "This is a logical forget: git history/backups may retain the text. Rotate exposed secrets.",
].join("\n");

type ParseResult =
  | { readonly help: true }
  | { readonly error: string }
  | {
      readonly ok: true;
      readonly file: string;
      readonly selector: ForgetSelector;
      readonly confirm: boolean;
      readonly reason: string;
    };

export function parseForgetArgs(text: string): ParseResult {
  const tokenized = tokenizeCommandArgs(text);
  if (tokenized.error) return { error: tokenized.error };
  const tokens = tokenized.tokens;
  let file: string | undefined;
  let line: number | undefined;
  let match: string | undefined;
  let all = false;
  let confirm = false;
  let reason = "user-requested forget";
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--help" || token === "-h") return { help: true };
    if (token === "--confirm") {
      confirm = true;
      continue;
    }
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--line" || token.startsWith("--line=")) {
      const parsed = commandFlagValue(token, "--line", tokens, i);
      if (parsed.error) return { error: parsed.error };
      i = parsed.index;
      const value = Number(parsed.value!);
      if (
        !/^\d+$/.test(parsed.value!) ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        return { error: "--line requires a positive integer" };
      }
      line = value;
      continue;
    }
    if (token === "--match" || token.startsWith("--match=")) {
      const parsed = commandFlagValue(token, "--match", tokens, i);
      if (parsed.error) return { error: parsed.error };
      i = parsed.index;
      if (!parsed.value || parsed.value.includes("\n")) {
        return { error: "--match requires non-empty single-line text" };
      }
      match = parsed.value;
      continue;
    }
    if (token === "--reason" || token.startsWith("--reason=")) {
      const parsed = commandFlagValue(token, "--reason", tokens, i);
      if (parsed.error) return { error: parsed.error };
      i = parsed.index;
      reason = parsed.value ?? reason;
      continue;
    }
    if (token.startsWith("-")) return { error: `unknown option: ${token}` };
    if (file !== undefined) return { error: `unexpected argument: ${token}` };
    file = token;
  }
  if (file === undefined) {
    return { error: `missing file\n\n${MEMORY_FORGET_USAGE}` };
  }
  if (!FORGETTABLE_FILES.includes(file as (typeof FORGETTABLE_FILES)[number])) {
    if (file === "decisions.md") {
      return {
        error:
          "decisions.md is append-only; add a superseding entry through /memory-review instead",
      };
    }
    if (file.startsWith("handoffs/")) {
      return {
        error:
          "handoffs are immutable; use /memory-gc for root handoff snapshots",
      };
    }
    return { error: `not a forgettable file: ${file}` };
  }
  const selectorCount = [line !== undefined, match !== undefined, all].filter(
    Boolean,
  ).length;
  if (selectorCount !== 1) {
    return {
      error: "choose exactly one selector: --line N, --match TEXT, or --all",
    };
  }
  const selector: ForgetSelector =
    line !== undefined
      ? { kind: "line", line }
      : match !== undefined
        ? { kind: "match", text: match }
        : { kind: "all" };
  return {
    ok: true,
    file,
    selector,
    confirm,
    reason:
      reason.replace(/\s+/g, " ").trim().slice(0, 200) ||
      "user-requested forget",
  };
}

export function registerMemoryForget(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_FORGET_COMMAND_NAME,
      description: MEMORY_FORGET_DESCRIPTION,
      execute: async (invocation) => {
        const { sessionID, prompt } = invocation;
        try {
          const parsed = parseForgetArgs(
            typeof prompt?.text === "string" ? prompt.text : "",
          );
          if ("help" in parsed) {
            await postCommandOutput(ctx, invocation, MEMORY_FORGET_USAGE, true);
            return;
          }
          if ("error" in parsed) {
            await postCommandOutput(
              ctx,
              invocation,
              `[memory] forget: ${parsed.error}`,
              true,
            );
            return;
          }
          const options = parseMemoryOptions(ctx.options);
          const input = {
            memoryRoot: memoryRootOf(ctx),
            file: parsed.file,
            selector: parsed.selector,
            reason: parsed.reason,
            indexLines: options.indexLines,
            fileLines: options.fileLines,
          };
          if (!parsed.confirm) {
            await postCommandOutput(
              ctx,
              invocation,
              await previewForget(input),
              true,
            );
            return;
          }
          const result = await applyForget({
            ...input,
            permission: ctx.permission,
            sessionID,
          });
          try {
            await incNotice(
              asLedger(ctx.storage),
              projectIDOf(ctx),
              "forgotten",
            );
          } catch (error) {
            // The write already happened; a notice failure must not undo it.
            logDiagnostic(error);
          }
          await postCommandOutput(
            ctx,
            invocation,
            renderForgetResult(result),
            true,
          ).then((delivered) => {
            if (!delivered) {
              logDiagnostic(
                new Error(
                  "[memory] forget completed but its result could not be delivered",
                ),
              );
            }
          });
        } catch (error) {
          await postCommandOutput(
            ctx,
            invocation,
            `[memory] forget failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            true,
          );
        }
      },
    });
  });
}
