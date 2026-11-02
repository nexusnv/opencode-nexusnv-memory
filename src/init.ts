/**
 * Explicit initialization gate (E15, issue #20; ADR-0011).
 *
 * A project is initialized when `.opencode/memory/INDEX.md` exists as a
 * regular file. Until then every production surface is inert; `/memory-init`
 * is the only writer, and it creates INDEX last so a partial scaffold never
 * activates the plugin.
 */
import type { Plugin } from "@opencode/plugin";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { memoryRootOf, postCommandOutput } from "./command-context.js";
import { parseMemoryOptions } from "./config.js";
import { writeNewCapped } from "./files.js";
import {
  ARCHIVE_DIR,
  HANDOFFS_DIR,
  MEMORY_FILES,
  getScaffoldFiles,
  initInstallText,
} from "./templates.js";

export const MEMORY_INIT_COMMAND_NAME = "memory-init";
export const MEMORY_INIT_COMMAND_DESCRIPTION =
  "Initialize the memory store on demand (creates .opencode/memory; never overwrites)";
export const MEMORY_NOT_INITIALIZED =
  "[memory] not initialized; run /memory-init to create .opencode/memory";
export const MEMORY_INIT_USAGE = [
  "Usage: /memory-init",
  "Creates .opencode/memory/ with the six starter files plus handoffs/ and handoffs/archive/.",
  "Idempotent: only missing paths are created; existing files are never overwritten.",
  "INDEX.md is created last; until it exists the plugin stays inert.",
].join("\n");

export interface MemoryInitInput {
  readonly memoryRoot: string;
  readonly indexLines?: number;
  readonly fileLines?: number;
}

export interface MemoryInitResult {
  readonly firstInit: boolean;
  readonly created: readonly string[];
  readonly present: readonly string[];
  readonly failures: readonly string[];
  readonly initialized: boolean;
  readonly lostMapWarning: boolean;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Fail closed: every probe error means “not initialized”. Never throws. */
export async function isInitialized(memoryRoot: string): Promise<boolean> {
  return isRegularFile(join(resolve(memoryRoot), "INDEX.md"));
}

function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Idempotent create/repair. Creates `INDEX.md` last; when `INDEX.md` was
 * absent and any earlier target failed, INDEX is never attempted, so the
 * project remains uninitialized.
 */
export async function initializeMemory(
  input: MemoryInitInput,
): Promise<MemoryInitResult> {
  const root = resolve(input.memoryRoot);
  const firstInit = !(await isInitialized(root));
  const created: string[] = [];
  const present: string[] = [];
  const preexisting: string[] = [];
  const failures: string[] = [];
  const opts = {
    memoryRoot: root,
    indexLines: input.indexLines,
    fileLines: input.fileLines,
  };

  for (const dir of [HANDOFFS_DIR, ARCHIVE_DIR]) {
    try {
      await mkdir(join(root, dir), { recursive: true });
    } catch (error) {
      failures.push(`${dir}/: ${errorLine(error)}`);
    }
  }

  const templates = getScaffoldFiles();
  for (const name of MEMORY_FILES) {
    if (name === "INDEX.md") continue;
    if (await isRegularFile(join(root, name))) {
      present.push(name);
      preexisting.push(name);
      continue;
    }
    try {
      const outcome = await writeNewCapped(name, templates[name] ?? "", opts);
      if (outcome === "created") {
        created.push(name);
      } else if (await isRegularFile(join(root, name))) {
        present.push(name);
      } else {
        failures.push(`${name}: existing path is not a regular file`);
      }
    } catch (error) {
      failures.push(`${name}: ${errorLine(error)}`);
    }
  }

  if (failures.length === 0) {
    if (await isRegularFile(join(root, "INDEX.md"))) {
      present.push("INDEX.md");
    } else {
      try {
        const outcome = await writeNewCapped(
          "INDEX.md",
          templates["INDEX.md"] ?? "",
          opts,
        );
        if (outcome === "created") {
          created.push("INDEX.md");
        } else if (await isRegularFile(join(root, "INDEX.md"))) {
          present.push("INDEX.md");
        } else {
          failures.push("INDEX.md: existing path is not a regular file");
        }
      } catch (error) {
        failures.push(`INDEX.md: ${errorLine(error)}`);
      }
    }
  }

  const initialized = await isInitialized(root);
  if (!initialized && failures.length === 0) {
    failures.push("INDEX.md: not a regular readable file");
  }

  return {
    firstInit,
    created,
    present,
    failures,
    initialized,
    lostMapWarning: firstInit && initialized && preexisting.length > 0,
  };
}

/** Deterministic command output. No memory body, no captured content. */
export function renderInitResult(result: MemoryInitResult): string {
  const lines: string[] = [];
  if (result.initialized) {
    lines.push(
      result.failures.length > 0
        ? "[memory] memory is initialized, but repair did not complete."
        : result.firstInit
          ? "[memory] initialized .opencode/memory (+ handoffs/)."
          : "[memory] memory already initialized; repair complete.",
    );
  } else {
    lines.push(
      "[memory] initialization did not complete; .opencode/memory is not initialized.",
    );
  }
  lines.push(
    `Created: ${result.created.length > 0 ? result.created.join(", ") : "(none)"}`,
  );
  lines.push(
    `Already present: ${result.present.length > 0 ? result.present.join(", ") : "(none)"}`,
  );
  if (result.failures.length > 0) {
    lines.push("Failed:");
    for (const failure of result.failures) lines.push(`- ${failure}`);
  }
  if (result.lostMapWarning) {
    lines.push("");
    lines.push(
      "[memory] warning: INDEX.md was missing while other memory files were present. The new INDEX.md is the default map; it does not reconstruct a lost custom map. Existing files were left untouched.",
    );
  }
  if (result.firstInit && result.initialized) {
    lines.push("");
    lines.push(initInstallText());
  }
  if (!result.initialized) {
    lines.push(
      "Fix the failure and re-run /memory-init. No memory is read or written until initialization completes.",
    );
  }
  return lines.join("\n");
}

/**
 * `/memory-init` — user-invoked only. Accepts no arguments except help.
 * Never throws; output is required (synthetic, then the §5.5 fallback).
 */
export function registerMemoryInit(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_INIT_COMMAND_NAME,
      description: MEMORY_INIT_COMMAND_DESCRIPTION,
      execute: async (invocation) => {
        try {
          const arg =
            typeof invocation.prompt?.text === "string"
              ? invocation.prompt.text.trim()
              : "";
          if (arg === "--help" || arg === "-h") {
            await postCommandOutput(ctx, invocation, MEMORY_INIT_USAGE, true);
            return;
          }
          if (arg.length > 0) {
            await postCommandOutput(
              ctx,
              invocation,
              `[memory] init: unexpected argument\n\n${MEMORY_INIT_USAGE}`,
              true,
            );
            return;
          }
          const options = parseMemoryOptions(ctx.options);
          const result = await initializeMemory({
            memoryRoot: memoryRootOf(ctx),
            indexLines: options.indexLines,
            fileLines: options.fileLines,
          });
          await postCommandOutput(
            ctx,
            invocation,
            renderInitResult(result),
            true,
          );
        } catch (error) {
          await postCommandOutput(
            ctx,
            invocation,
            `[memory] init failed: ${errorLine(error)}`,
            true,
          );
        }
      },
    });
  });
}
