import { Plugin } from "@opencode/plugin";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMemoryOptions } from "./config.js";
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

/**
 * Memory plugin entrypoint — wiring only (Promise flavor; no `effect()`
 * import, no `server()` dual export). Later tasks push hook/transform
 * registrations into `registrations`; the async cleanup aborts the single
 * event controller and disposes every registration (spec §§5.7, 5.9).
 */
export default Plugin.define({
  id: "memory",
  async setup(ctx) {
    // Read options once; invalid values warn once and fall back to defaults.
    const options = parseMemoryOptions(ctx.options);
    void options;

    // The ONE event-stream controller; §5.9 reuses it (subscribed in Task 8).
    const controller = new AbortController();
    const registrations: Registration[] = [];

    // Task 1 registers no hooks yet beyond this wiring; Tasks 5–8 push
    // prompt/context/compaction hooks, tool hooks, tool/command transforms,
    // and the event-subscriber loop here.

    const projectRoot = (
      ctx.location.project?.canonical ??
      ctx.location.directory
    ).replace(/\/+$/, "");
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
