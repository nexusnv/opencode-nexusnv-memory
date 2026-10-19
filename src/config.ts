/**
 * Plugin options (spec §3). Exactly five options, all optional.
 *
 * Read once in `setup` via `ctx.options`. Invalid or missing values fall
 * back to the default with a warn-once notice; parsing never throws.
 */
export interface MemoryPluginOptions {
  /** INDEX.md cap (lines, on disk). Default 30. */
  readonly indexLines: number;
  /** activeContext/architecture/style/issues + per-handoff cap (lines). Default 60. */
  readonly fileLines: number;
  /** Total auto-inject payload cap (INDEX attach + brief + status + hint). Default 80. */
  readonly injectBudgetLines: number;
  /** Append failed shell/build/test output to activeContext.md. Default true. */
  readonly captureFailures: boolean;
  /** Min interval between context-hook snapshots per session (minutes). Default 10. */
  readonly snapshotThrottleMinutes: number;
}

export const DEFAULT_MEMORY_OPTIONS: MemoryPluginOptions = {
  indexLines: 30,
  fileLines: 60,
  injectBudgetLines: 80,
  captureFailures: true,
  snapshotThrottleMinutes: 10,
};

export type WarnFn = (message: string) => void;

/** Keys already warned about in this process; each invalid key warns at most once. */
const warnedKeys = new Set<string>();

/** Test seam: clear warn-once state between assertions. */
export function resetMemoryOptionsWarnings(): void {
  warnedKeys.clear();
}

function warnOnce(key: string, warn: WarnFn, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  try {
    warn(message);
  } catch {
    // A failing logger must never break plugin load.
  }
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Parse raw `ctx.options` into validated options. Never throws: any invalid
 * or missing value warns once and falls back to its default. Valid but
 * incoherent combinations warn once (no behavior change).
 */
export function parseMemoryOptions(
  raw: unknown,
  warn: WarnFn = console.warn,
): MemoryPluginOptions {
  try {
    if (raw === undefined || raw === null) {
      return { ...DEFAULT_MEMORY_OPTIONS };
    }
    if (typeof raw !== "object") {
      warnOnce(
        "options",
        warn,
        "[memory] plugin options must be an object; using defaults",
      );
      return { ...DEFAULT_MEMORY_OPTIONS };
    }
    const src = raw as Record<string, unknown>;

    const indexLines = asPositiveInt(src["indexLines"]);
    if (src["indexLines"] !== undefined && indexLines === undefined) {
      warnOnce(
        "indexLines",
        warn,
        `[memory] invalid option indexLines=${JSON.stringify(src["indexLines"])}; using default 30`,
      );
    }

    const fileLines = asPositiveInt(src["fileLines"]);
    if (src["fileLines"] !== undefined && fileLines === undefined) {
      warnOnce(
        "fileLines",
        warn,
        `[memory] invalid option fileLines=${JSON.stringify(src["fileLines"])}; using default 60`,
      );
    }

    const injectBudgetLines = asPositiveInt(src["injectBudgetLines"]);
    if (
      src["injectBudgetLines"] !== undefined &&
      injectBudgetLines === undefined
    ) {
      warnOnce(
        "injectBudgetLines",
        warn,
        `[memory] invalid option injectBudgetLines=${JSON.stringify(src["injectBudgetLines"])}; using default 80`,
      );
    }

    if (
      src["captureFailures"] !== undefined &&
      typeof src["captureFailures"] !== "boolean"
    ) {
      warnOnce(
        "captureFailures",
        warn,
        `[memory] invalid option captureFailures=${JSON.stringify(src["captureFailures"])}; using default true`,
      );
    }

    const snapshotThrottleMinutes = asPositiveInt(
      src["snapshotThrottleMinutes"],
    );
    if (
      src["snapshotThrottleMinutes"] !== undefined &&
      snapshotThrottleMinutes === undefined
    ) {
      warnOnce(
        "snapshotThrottleMinutes",
        warn,
        `[memory] invalid option snapshotThrottleMinutes=${JSON.stringify(src["snapshotThrottleMinutes"])}; using default 10`,
      );
    }

    const resolved: MemoryPluginOptions = {
      indexLines: indexLines ?? DEFAULT_MEMORY_OPTIONS.indexLines,
      fileLines: fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines,
      injectBudgetLines:
        injectBudgetLines ?? DEFAULT_MEMORY_OPTIONS.injectBudgetLines,
      captureFailures:
        typeof src["captureFailures"] === "boolean"
          ? src["captureFailures"]
          : DEFAULT_MEMORY_OPTIONS.captureFailures,
      snapshotThrottleMinutes:
        snapshotThrottleMinutes ??
        DEFAULT_MEMORY_OPTIONS.snapshotThrottleMinutes,
    };
    // Coherence warnings (Tier 0): a valid parse can still be unusable.
    if (resolved.injectBudgetLines <= resolved.indexLines) {
      warnOnce(
        "coherence.injectBudgetLines",
        warn,
        `[memory] option coherence: injectBudgetLines (${resolved.injectBudgetLines}) is not above indexLines (${resolved.indexLines}); no budget remains for the brief/status/hint — raise injectBudgetLines or lower indexLines`,
      );
    }
    if (resolved.fileLines < 10) {
      warnOnce(
        "coherence.fileLines",
        warn,
        `[memory] option coherence: fileLines (${resolved.fileLines}) is very small; memory files and handoffs will be truncated aggressively (default 60)`,
      );
    }
    return resolved;
  } catch {
    return { ...DEFAULT_MEMORY_OPTIONS };
  }
}
