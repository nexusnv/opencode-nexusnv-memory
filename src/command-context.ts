import type { Plugin } from "@opencode/plugin";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { join } from "node:path";
import type { LedgerStorage } from "./capture.js";

export const MEMORY_DIR = ".opencode/memory";

export function projectRootOf(ctx: Plugin.Context): string {
  return (ctx.location.project?.canonical ?? ctx.location.directory).replace(
    /\/+$/,
    "",
  );
}

export function projectIDOf(ctx: Plugin.Context): string {
  return ctx.location.project?.id ?? ctx.location.directory;
}

export function memoryRootOf(ctx: Plugin.Context): string {
  return join(projectRootOf(ctx), MEMORY_DIR);
}

export function asLedger(storage: Plugin.Context["storage"]): LedgerStorage {
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

/** Best-effort diagnostic log; logging must never break a hook or command. */
export function logDiagnostic(error: unknown): void {
  try {
    console.warn("[memory] hook diagnostic:", error);
  } catch {
    // Logging must never break plugin load or a hook.
  }
}

/**
 * Post a command result. Prefer a synthetic message; for output the user must
 * see (dry-run/result), degrade to the §5.5 prompt fallback if synthetic
 * delivery is unavailable. Never throws: a mutation already completed must
 * not be reported as an operation failure just because delivery failed.
 * Returns whether any channel delivered the text.
 */
export async function postCommandOutput(
  ctx: Plugin.Context,
  invocation: CommandInvocation,
  text: string,
  required = false,
): Promise<boolean> {
  try {
    await ctx.session.synthetic({ sessionID: invocation.sessionID, text });
    return true;
  } catch (error) {
    logDiagnostic(error);
    if (!required) return false;
    try {
      await ctx.session.prompt({
        ...invocation.prompt,
        sessionID: invocation.sessionID,
        delivery: invocation.delivery,
        text,
      });
      return true;
    } catch (fallbackError) {
      logDiagnostic(fallbackError);
      return false;
    }
  }
}
