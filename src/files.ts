/**
 * Budget/redaction choke point (spec §§5.7, 6 + c4-06-code).
 *
 * Every later writer/loader routes through `readCapped`/`writeCapped`:
 * allowlist + handoff regex + traversal rejects + cap/notice + redaction +
 * per-process write mutex. `activeContext.md` rotates the oldest
 * Known-Errors block to `handoffs/archive/` instead of throwing at the cap.
 *
 * All file IO via `node:fs/promises` (async only).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import { redact } from "./redact.js";

export interface CappedFileOptions {
  /** Absolute path to `.opencode/memory`. Defaults to `<cwd>/.opencode/memory`. */
  readonly memoryRoot?: string;
  /** INDEX.md cap (lines). Defaults to config `indexLines` (30). */
  readonly indexLines?: number;
  /** Per-file cap for activeContext/arch/style/issues/handoffs. Defaults to `fileLines` (60). */
  readonly fileLines?: number;
}

const ALLOWED_ROOT_FILES: ReadonlySet<string> = new Set([
  "INDEX.md",
  "activeContext.md",
  "decisions.md",
  "architecture.md",
  "style.md",
  "issues.md",
]);

const HANDOFF_PATTERN = /^handoffs\/(?:archive\/)?[A-Za-z0-9._-]+\.md$/;

const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

/** One per-process write chain; every plugin write serializes through it. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Run `fn` under the per-process write mutex. Concurrent callers queue in
 * call order; a rejection never breaks the chain for the next waiter.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test seam: reset the chain between isolated suites (no on-disk state). */
export function resetWriteChainForTests(): void {
  writeChain = Promise.resolve();
}

export function resolveMemoryRoot(memoryRoot?: string): string {
  if (typeof memoryRoot === "string" && memoryRoot.length > 0) {
    return resolve(memoryRoot);
  }
  return resolve(join(process.cwd(), ".opencode", "memory"));
}

function capsOf(opts?: CappedFileOptions): {
  indexLines: number;
  fileLines: number;
} {
  return {
    indexLines: opts?.indexLines ?? DEFAULT_MEMORY_OPTIONS.indexLines,
    fileLines: opts?.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines,
  };
}

/**
 * Line cap for `file` (`Infinity` = unbounded on disk: `decisions.md`).
 * Handoffs/archive files share the per-file `fileLines` cap.
 */
export function getCapForFile(
  file: string,
  indexLines: number,
  fileLines: number,
): number {
  if (file === "INDEX.md") return indexLines;
  if (file === "decisions.md") return Number.POSITIVE_INFINITY;
  return fileLines;
}

export function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  // A trailing newline terminates the last line; it is not an extra line.
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function decodeRepeatedly(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    if (!current.includes("%")) return current;
    try {
      const next = decodeURIComponent(current);
      if (next === current) return current;
      current = next;
    } catch {
      return current;
    }
  }
  return current;
}

/** Throw unless `file` is an allowlisted memory path with no escape. */
export function assertAllowedPath(file: string): void {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("[memory] file path must be a non-empty string");
  }
  if (file.includes("\0")) {
    throw new Error(`[memory] rejected path with null byte: ${file}`);
  }
  if (file.includes("\\")) {
    throw new Error(`[memory] rejected backslash path: ${file}`);
  }
  if (isAbsolute(file) || file.startsWith("/")) {
    throw new Error(`[memory] rejected absolute path: ${file}`);
  }
  if (/^[A-Za-z]:/.test(file)) {
    throw new Error(`[memory] rejected drive path: ${file}`);
  }
  if (ENCODED_SEPARATOR.test(file)) {
    throw new Error(`[memory] rejected percent-encoded separator: ${file}`);
  }
  const decoded = decodeRepeatedly(file);
  if (decoded !== file) {
    if (
      decoded.includes("\\") ||
      ENCODED_SEPARATOR.test(decoded) ||
      isAbsolute(decoded)
    ) {
      throw new Error(`[memory] rejected encoded traversal: ${file}`);
    }
  }
  const candidate = decoded !== file ? decoded : file;
  for (const segment of candidate.split("/")) {
    if (segment === ".." || segment === ".") {
      throw new Error(`[memory] rejected traversal: ${file}`);
    }
  }
  if (
    !ALLOWED_ROOT_FILES.has(file) &&
    !ALLOWED_ROOT_FILES.has(candidate) &&
    !HANDOFF_PATTERN.test(file) &&
    !HANDOFF_PATTERN.test(candidate)
  ) {
    throw new Error(`[memory] rejected non-allowlisted path: ${file}`);
  }
}

function resolveUnderRoot(root: string, file: string): string {
  const abs = resolve(join(root, file));
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`[memory] rejected escape from memory root: ${file}`);
  }
  if (isAbsolute(rel)) {
    throw new Error(`[memory] rejected escape from memory root: ${file}`);
  }
  return abs;
}

function truncationNotice(
  kind: "first" | "last",
  cap: number,
  total: number,
): string {
  return `\n\n[truncated: showing ${kind} ${cap} of ${total} lines]`;
}

const KNOWN_ERRORS_HEADING = /^##\s+known errors\s*$/i;
const BULLET_START = /^\s*-\s+/;

/**
 * Split the lines under `## Known errors` into blocks. Each block starts at a
 * `- ` bullet; indented/non-bullet continuation lines join the current block.
 * Returns block boundaries as [start, end) line indexes into `allLines`.
 */
function knownErrorBlocks(
  allLines: string[],
  headingIdx: number,
): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | undefined;
  for (let i = headingIdx + 1; i < allLines.length; i += 1) {
    const line = allLines[i]!;
    if (BULLET_START.test(line)) {
      if (current) blocks.push(current);
      current = { start: i, end: i + 1 };
    } else if (current) {
      // Continuation (indented detail, blank, or plain text): keep with block
      // unless a new ## section starts, which ends the Known-errors region.
      if (/^##\s+/.test(line.trim())) {
        blocks.push(current);
        return blocks;
      }
      current.end = i + 1;
    } else {
      if (/^##\s+/.test(line.trim())) return blocks;
      // Leading blanks before the first bullet belong to no block; skip.
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Archive filename safe for the handoff allowlist (no colons). */
function rotatedArchiveName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `handoffs/archive/rotated-${stamp}-${Date.now()}-${rand}.md`;
}

/**
 * Read one allowlisted file under the memory root. Over-cap content (e.g. a
 * hand-edit that bypassed `writeCapped`) is truncated with a notice; the
 * `decisions.md` tail returns the last N lines, all others the first N.
 * Output is always redacted. Unknown/traversal paths throw.
 */
export async function readCapped(
  file: string,
  opts?: CappedFileOptions,
): Promise<string> {
  assertAllowedPath(file);
  const { indexLines, fileLines } = capsOf(opts);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  const abs = resolveUnderRoot(root, file);
  const raw = await readFile(abs, "utf8");
  const redactedText = redact(raw);
  const total = countLines(redactedText);
  // decisions.md is unbounded on write but recall-capped to the injectable
  // tail; every other file uses its write cap for reads too.
  const cap =
    file === "decisions.md"
      ? fileLines
      : getCapForFile(file, indexLines, fileLines);
  if (!Number.isFinite(cap) || total <= (cap as number)) return redactedText;
  const limit = cap as number;
  if (file === "decisions.md") {
    const kept = redactedText.split("\n").slice(-limit).join("\n");
    return `${kept}${truncationNotice("last", limit, total)}`;
  }
  const kept = redactedText.split("\n").slice(0, limit).join("\n");
  return `${kept}${truncationNotice("first", limit, total)}`;
}

/**
 * Inner write body: assumes the caller already holds `withWriteLock` and
 * passes already-redacted text. Shared by `writeCapped` (overwrite) and
 * `updateCapped` (read-modify-write) so caps, rotation, and archive routing
 * cannot drift between the two paths. Never takes the lock itself.
 */
async function writeRedactedCapped(
  file: string,
  redactedText: string,
  root: string,
  indexLines: number,
  fileLines: number,
): Promise<void> {
  const abs = resolveUnderRoot(root, file);
  const total = countLines(redactedText);
  const cap = getCapForFile(file, indexLines, fileLines);
  if (!Number.isFinite(cap) || total <= (cap as number)) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, redactedText, "utf8");
    return;
  }
  const limit = cap as number;
  if (file !== "activeContext.md") {
    throw new Error(
      `[memory] write rejected: ${file} has ${total} lines, cap is ${limit}; refusing to silently truncate`,
    );
  }
  // activeContext.md: rotate oldest Known-Errors block(s) to archive/.
  const allLines = redactedText.split("\n");
  // Drop a single trailing empty part from a terminal newline for block math.
  const working =
    allLines.length > 0 && allLines[allLines.length - 1] === ""
      ? allLines.slice(0, -1)
      : allLines;
  const headingIdx = working.findIndex((l) => KNOWN_ERRORS_HEADING.test(l.trim()));
  if (headingIdx === -1) {
    throw new Error(
      `[memory] write rejected: activeContext.md has ${total} lines, cap is ${limit}; no Known-Errors block to rotate`,
    );
  }
  const blocks = knownErrorBlocks(working, headingIdx);
  if (blocks.length === 0) {
    throw new Error(
      `[memory] write rejected: activeContext.md has ${total} lines, cap is ${limit}; no Known-Errors block to rotate`,
    );
  }
  let remaining = working.slice();
  // Remove oldest-first until under cap; account for index shifts by
  // removing from the front and tracking the offset.
  let removedCount = 0;
  const rotated: string[] = [];
  let blockCursor = 0;
  while (countLines(remaining.join("\n")) > limit && blockCursor < blocks.length) {
    const block = blocks[blockCursor]!;
    const start = block.start - removedCount;
    const len = block.end - block.start;
    rotated.push(...remaining.slice(start, start + len));
    remaining = [...remaining.slice(0, start), ...remaining.slice(start + len)];
    removedCount += len;
    blockCursor += 1;
  }
  if (countLines(remaining.join("\n")) > limit) {
    throw new Error(
      `[memory] write rejected: activeContext.md still over cap ${limit} after rotating ${rotated.length} lines`,
    );
  }
  const archiveRel = rotatedArchiveName();
  assertAllowedPath(archiveRel);
  const archiveAbs = resolveUnderRoot(root, archiveRel);
  await mkdir(dirname(archiveAbs), { recursive: true });
  await writeFile(
    archiveAbs,
    `# Rotated Known-Errors block(s) from activeContext.md\n\n${rotated.join("\n")}\n`,
    "utf8",
  );
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, remaining.join("\n"), "utf8");
}

/**
 * Write one allowlisted file (full-content overwrite). Text is redacted
 * first, then the cap is enforced; writes serialize via the per-process
 * mutex. Over-cap writes throw — except `activeContext.md`, which rotates
 * the oldest Known-Errors block(s) to `handoffs/archive/` until under cap.
 */
export async function writeCapped(
  file: string,
  text: string,
  opts?: CappedFileOptions,
): Promise<void> {
  assertAllowedPath(file);
  if (typeof text !== "string") {
    throw new Error("[memory] writeCapped text must be a string");
  }
  const redactedText = redact(text);
  await withWriteLock(async () => {
    const { indexLines, fileLines } = capsOf(opts);
    const root = resolveMemoryRoot(opts?.memoryRoot);
    await writeRedactedCapped(file, redactedText, root, indexLines, fileLines);
  });
}

/**
 * Exclusive create of one allowlisted file: redaction, caps, and the
 * per-process mutex apply exactly as in `writeCapped`, but the file must
 * not already exist (`wx` flag). Resolves `"created"` on success or
 * `"exists"` when a file is already there (caller decides: dedupe when the
 * content matches, or retry under a suffixed name). Never overwrites, so a
 * same-name collision between two different handoffs cannot destroy either.
 * Intended for immutable new files (`handoffs/`); appends use
 * `updateCapped`, overwrites use `writeCapped`.
 */
export async function writeNewCapped(
  file: string,
  text: string,
  opts?: CappedFileOptions,
): Promise<"created" | "exists"> {
  assertAllowedPath(file);
  if (typeof text !== "string") {
    throw new Error("[memory] writeNewCapped text must be a string");
  }
  const redactedText = redact(text);
  return withWriteLock(async () => {
    const { indexLines, fileLines } = capsOf(opts);
    const root = resolveMemoryRoot(opts?.memoryRoot);
    const abs = resolveUnderRoot(root, file);
    const total = countLines(redactedText);
    const cap = getCapForFile(file, indexLines, fileLines);
    if (Number.isFinite(cap) && total > (cap as number)) {
      throw new Error(
        `[memory] write rejected: ${file} has ${total} lines, cap is ${cap}; refusing to silently truncate`,
      );
    }
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(abs, redactedText, { encoding: "utf8", flag: "wx" });
      return "created" as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        return "exists" as const;
      }
      throw error;
    }
  });
}

/**
 * Atomic read-modify-write under the per-process mutex. The updater receives
 * the current raw content (`""` when the file does not exist yet) and
 * returns the next raw content; redaction, caps, rotation, and archive
 * routing apply exactly as in `writeCapped`. Use this (never a
 * read-outside/write-inside pair) whenever concurrent writers may append to
 * the same file — otherwise the second writer's read misses the first
 * writer's entry and silently drops it.
 */
export async function updateCapped(
  file: string,
  opts: CappedFileOptions | undefined,
  updater: (current: string) => string | Promise<string>,
): Promise<void> {
  assertAllowedPath(file);
  await withWriteLock(async () => {
    const { indexLines, fileLines } = capsOf(opts);
    const root = resolveMemoryRoot(opts?.memoryRoot);
    const abs = resolveUnderRoot(root, file);
    let current = "";
    try {
      current = await readFile(abs, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const next = await updater(current);
    if (typeof next !== "string") {
      throw new Error("[memory] updateCapped updater must return a string");
    }
    await writeRedactedCapped(file, redact(next), root, indexLines, fileLines);
  });
}
