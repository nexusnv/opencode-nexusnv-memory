/**
 * Budget/redaction choke point (spec §§5.7, 6 + c4-06-code).
 *
 * Every later writer/loader routes through `readCapped`/`writeCapped`:
 * allowlist + handoff regex + traversal rejects + cap/notice + redaction +
 * per-process mutex + cross-process root lock. `activeContext.md` rotates the oldest
 * Known-Errors block to `handoffs/archive/` instead of throwing at the cap.
 *
 * All file IO via `node:fs/promises` (async only).
 */
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import {
  findKnownErrorsHeading,
  splitKnownErrorSections,
} from "./known-errors.js";
import { acquireWriteLock, type FileLockOptions } from "./lock.js";
import { redact, redactPreservingLines } from "./redact.js";

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

/** Per-process chain for ledger/storage writes (not memory files). */
let writeChain: Promise<void> = Promise.resolve();
/** Per-process chain for memory-file lock acquisition and write bodies. */
let fileWriteChain: Promise<void> = Promise.resolve();

/**
 * Run `fn` under the per-process ledger/storage write mutex. Concurrent
 * callers queue in call order; a rejection never breaks the chain for the
 * next waiter.
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function withFileMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileWriteChain.then(fn, fn);
  fileWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test seam: reset both write chains between isolated suites (no on-disk state). */
export function resetWriteChainForTests(): void {
  writeChain = Promise.resolve();
  fileWriteChain = Promise.resolve();
}

/**
 * Run `fn` while holding both the in-process file mutex and the root-level
 * cross-process lock. The callback must not call `withFileWriteLock` again.
 */
export async function withFileWriteLock<T>(
  root: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  return withFileMutex(async () => {
    const release = await acquireWriteLock(root, options);
    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  });
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
    throw new Error(
      `[memory] rejected non-allowlisted path: ${file}; valid: ${[...ALLOWED_ROOT_FILES].join(", ")}, handoffs/<name>.md, handoffs/archive/<name>.md`,
    );
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

/**
 * O_NONBLOCK keeps a symlink to an outside FIFO from blocking before the
 * opened handle is validated; regular files ignore it. Platforms without the
 * flag fall back to a normal read-only open.
 */
const READ_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Open an allowlisted path, then validate the *opened inode* against the
 * memory root. Resolving first and opening second left a check-then-open race:
 * a concurrent replace could swap the validated path for an outside symlink
 * before `open`, and the read would follow it. Opening first fixes the
 * descriptor; `realpath` plus a `dev`/`ino` comparison prove that inode is
 * still reachable inside the root, and no bytes are read until that holds.
 * In-root symlinks and a root that is itself a symlink keep working. A missing
 * root/target still propagates ENOENT so callers keep the friendly error.
 */
async function openContainedRead(
  root: string,
  file: string,
): Promise<{ readonly handle: FileHandle; readonly size: number }> {
  const abs = resolveUnderRoot(root, file);
  await assertContainedAncestors(root, dirname(abs));
  // Atomic publish replaces the inode on every write. A reader that opened
  // just before the rename sees the old inode at `stat` time; that is normal
  // concurrency, so retry a bounded number of times before treating it as a
  // rewrite race rather than a symlink escape.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const handle = await open(abs, READ_OPEN_FLAGS);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new Error(`[memory] rejected non-regular memory file: ${file}`);
      }
      const realRoot = await realpath(root);
      const realAbs = await realpath(abs);
      if (realAbs === realRoot || !realAbs.startsWith(`${realRoot}${sep}`)) {
        throw new Error(
          `[memory] rejected symlink escape from memory root: ${file}`,
        );
      }
      // The path may have been swapped after `open`; only accept the read
      // when the descriptor still names the contained path's current inode.
      const target = await stat(realAbs);
      if (target.dev !== opened.dev || target.ino !== opened.ino) {
        await handle.close().catch(() => undefined);
        if (attempt < 3) continue;
        throw new Error(`[memory] memory file is being rewritten: ${file}`);
      }
      return { handle, size: opened.size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  throw new Error(`[memory] memory file is being rewritten: ${file}`);
}

function truncationNotice(
  kind: "first" | "last",
  cap: number,
  total: number,
): string {
  return `\n\n[truncated: showing ${kind} ${cap} of ${total} lines]`;
}

/** The loader-generated truncation notice line (see `truncationNotice`). */
export const TRUNCATION_NOTICE_LINE =
  /^\[truncated: showing (?:first|last) \d+ of (?:at least )?\d+ lines\]$/;

/** Archive filename safe for the handoff allowlist (no colons). */
function rotatedArchiveName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `handoffs/archive/rotated-${stamp}-${Date.now()}-${rand}.md`;
}

/** Recovery hint for a missing-file recall error (names only, never content). */
function missingFileHint(file: string): string {
  if (file.startsWith("handoffs/archive/")) {
    return `; list available files with memory_recall("handoffs/archive")`;
  }
  if (file.startsWith("handoffs/")) {
    return `; list available files with memory_recall("handoffs")`;
  }
  return "";
}

/**
 * Read one allowlisted file under the memory root. Over-cap content (e.g. a
 * hand-edit that bypassed `writeCapped`) is truncated with a notice; the
 * `decisions.md` tail returns the last N lines, all others the first N.
 * Output is always redacted. Unknown/traversal paths throw; a missing file
 * reports `memory file not found` with a listing hint for handoffs.
 */
export async function readCapped(
  file: string,
  opts?: CappedFileOptions,
): Promise<string> {
  assertAllowedPath(file);
  const { indexLines, fileLines } = capsOf(opts);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  let raw: string;
  let handle: FileHandle | undefined;
  try {
    const opened = await openContainedRead(root, file);
    handle = opened.handle;
    raw = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `[memory] memory file not found: ${file}${missingFileHint(file)}`,
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  const redactedText = redact(raw);
  const total = countLines(redactedText);
  // decisions.md is unbounded on write but recall-capped to the injectable
  // tail; every other file uses its write cap for reads too. User-invoked
  // forgotten-* archives add a short provenance header around the removed
  // text, so give them headroom above the file cap as well.
  const cap =
    file === "decisions.md"
      ? fileLines
      : file.startsWith("handoffs/archive/forgotten-")
        ? Math.max(fileLines * 3 + 64, 512)
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

/** Per-file byte guard for full (`memory_search`) reads. */
export const SEARCH_FILE_BYTES = 1_000_000;

export interface FullReadOptions {
  /** Absolute path to `.opencode/memory`; defaults like `readCapped`. */
  readonly memoryRoot?: string;
  /** `throw` (default) reports a friendly missing-file error; `skip` returns undefined. */
  readonly onMissing?: "throw" | "skip";
}

export interface FullReadResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Read one allowlisted memory file in full (no line cap) for `memory_search`.
 * Same allowlist/traversal choke point and redaction as `readCapped`, but a
 * per-file byte guard instead of a line cap so older decisions and archived
 * handoffs stay searchable. A missing file throws the same friendly error as
 * `readCapped` unless `onMissing: "skip"`. Never reads outside the root
 * (symlinks are resolved and rejected when they escape). Redaction preserves
 * newline count so reported line numbers match the on-disk file.
 */
export async function readFullRedacted(
  file: string,
  opts?: FullReadOptions,
): Promise<FullReadResult | undefined> {
  assertAllowedPath(file);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  let handle: FileHandle;
  let size: number;
  try {
    const opened = await openContainedRead(root, file);
    handle = opened.handle;
    size = opened.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (opts?.onMissing === "skip") return undefined;
      throw new Error(
        `[memory] memory file not found: ${file}${missingFileHint(file)}`,
      );
    }
    throw error;
  }
  try {
    const length = Math.min(size, SEARCH_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    // `FileHandle.read` may satisfy a short read; loop so the tail is not
    // silently dropped (the limit is a byte guard, not a read-size hint).
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const raw = buffer.subarray(0, offset).toString("utf8");
    // A byte-limited read can cut through a URL credential before the `@`
    // that redaction needs. Drop the incomplete final line; complete lines
    // before the guard keep their on-disk line numbers.
    const text =
      size > SEARCH_FILE_BYTES ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
    return {
      text: redactPreservingLines(text),
      truncated: size > SEARCH_FILE_BYTES,
    };
  } finally {
    await handle.close();
  }
}

export interface ContainedTextOptions {
  readonly memoryRoot?: string;
  readonly onMissing?: "skip";
  readonly maxBytes?: number;
}

export interface ContainedTextResult {
  /** Raw (unredacted) text; callers must redact before injection. */
  readonly text: string;
  readonly truncated: boolean;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

/**
 * Bounded contained read (default 1 MiB). No search-specific line dropping;
 * the caller decides whether a truncated result is usable.
 */
export async function readContainedText(
  file: string,
  opts?: ContainedTextOptions,
): Promise<ContainedTextResult | undefined> {
  assertAllowedPath(file);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  let handle: FileHandle | undefined;
  try {
    const opened = await openContainedRead(root, file);
    handle = opened.handle;
    const limit = positiveInt(opts?.maxBytes, 1_048_576);
    const length = Math.min(opened.size, limit);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      text: buffer.subarray(0, offset).toString("utf8"),
      truncated: opened.size > limit,
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === "ENOENT" &&
      opts?.onMissing === "skip"
    ) {
      return undefined;
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export interface ContainedLinesOptions {
  readonly memoryRoot?: string;
  readonly maxLines: number;
  readonly maxBytes?: number;
  readonly onMissing?: "skip";
}

export interface ContainedLinesResult {
  /** Raw (unredacted) lines; callers must redact before injection. */
  readonly lines: string[];
  readonly truncated: boolean;
}

/**
 * Bounded line read for hot prompt paths. Reads at most `maxLines` lines and
 * `maxBytes` bytes; a byte hit before the line cap is reported as truncated so
 * `indexLineCount` can fail closed. Junk-length lines never fully materialize.
 */
export async function readContainedLines(
  file: string,
  opts: ContainedLinesOptions,
): Promise<ContainedLinesResult | undefined> {
  assertAllowedPath(file);
  const root = resolveMemoryRoot(opts.memoryRoot);
  let handle: FileHandle | undefined;
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(64 * 1024);
  const lines: string[] = [];
  let carry = "";
  let bytes = 0;
  let truncated = false;
  try {
    const opened = await openContainedRead(root, file);
    handle = opened.handle;
    const limit = positiveInt(opts.maxLines, 1);
    const maxBytes = positiveInt(opts.maxBytes, 1_048_576);
    const accept = (line: string): boolean => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      const size = Buffer.byteLength(clean, "utf8") + 1;
      if (lines.length >= limit || bytes + size > maxBytes) {
        truncated = true;
        return false;
      }
      lines.push(clean);
      bytes += size;
      return true;
    };
    outer: for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      carry += decoder.write(chunk.subarray(0, bytesRead));
      let newline = carry.indexOf("\n");
      while (newline !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (!accept(line)) break outer;
        newline = carry.indexOf("\n");
      }
      if (Buffer.byteLength(carry, "utf8") > maxBytes) {
        truncated = true;
        break;
      }
    }
    if (!truncated) {
      carry += decoder.end();
      if (carry.length > 0) accept(carry);
    }
    return { lines, truncated };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === "ENOENT" &&
      opts.onMissing === "skip"
    ) {
      return undefined;
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Exact contained handoff directory listing. By default aliases (including
 * in-root symlinks such as `handoffs -> .` or `handoffs/archive -> ..`) and
 * off-root targets yield an empty listing rather than filenames from the
 * wrong dir. `strict` mode throws instead, so GC never mistakes an alias for
 * an empty directory. A missing/non-directory path propagates ENOENT/ENOTDIR;
 * every caller wraps.
 */
export async function readHandoffDirectory(
  memoryRoot: string | undefined,
  subdir: "root" | "archive",
  options?: { readonly strict?: boolean },
): Promise<string[]> {
  const root = resolveMemoryRoot(memoryRoot);
  const relativeDir =
    subdir === "archive" ? join("handoffs", "archive") : "handoffs";
  const directory = join(root, relativeDir);
  const realRoot = await realpath(root);
  const realDir = await realpath(directory);
  if (realDir !== join(realRoot, relativeDir)) {
    if (options?.strict) {
      throw new Error(
        `[memory] rejected handoff directory alias or escape: ${relativeDir}`,
      );
    }
    return [];
  }
  // Regular files only: a directory or symlink named like a handoff must
  // never enter a listing that feeds GC deletion.
  return (await readdir(realDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && /^[A-Za-z0-9._-]+\.md$/.test(entry.name),
    )
    .map((entry) => entry.name);
}

/** Reject escaping ancestors and handoff/archive symlink aliases. */
async function assertContainedAncestors(
  root: string,
  directory: string,
): Promise<void> {
  const realRoot = await realpath(root);
  const rel = relative(root, directory);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[memory] rejected escape from memory root: ${directory}`);
  }
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (info.isSymbolicLink()) {
      const currentRel = relative(root, current);
      if (
        currentRel === "handoffs" ||
        currentRel === join("handoffs", "archive")
      ) {
        throw new Error(
          `[memory] rejected handoff symlink alias (symlink escape): ${current}`,
        );
      }
      const target = await realpath(current);
      if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
        throw new Error(
          `[memory] rejected symlink escape from memory root: ${current}`,
        );
      }
      const targetInfo = await stat(current);
      if (!targetInfo.isDirectory()) {
        throw new Error(
          `[memory] rejected non-directory memory parent: ${current}`,
        );
      }
    } else if (!info.isDirectory()) {
      throw new Error(
        `[memory] rejected non-directory memory parent: ${current}`,
      );
    }
  }
}

async function assertContainedDirectory(
  root: string,
  directory: string,
): Promise<void> {
  const realRoot = await realpath(root);
  const realDir = await realpath(directory);
  if (realDir !== realRoot && !realDir.startsWith(`${realRoot}${sep}`)) {
    throw new Error(
      `[memory] rejected symlink escape from memory root: ${directory}`,
    );
  }
}

/**
 * Validate existing ancestors, create the parent, then re-check the resolved
 * parent. The first check prevents `mkdir` from following an outside symlink;
 * the second detects a parent swapped during `mkdir`. A same-host attacker
 * racing the path between those checks is outside the documented threat model.
 */
async function prepareParent(root: string, abs: string): Promise<void> {
  const directory = dirname(abs);
  // Exported writers may be called before the plugin scaffold exists.
  await mkdir(root, { recursive: true });
  await assertContainedAncestors(root, directory);
  await mkdir(directory, { recursive: true });
  await assertContainedDirectory(root, directory);
}

function tempPathFor(abs: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return join(dirname(abs), `.tmp-${process.pid}-${Date.now()}-${rand}`);
}

/**
 * Existing regular-file mode, or `undefined` when the target does not exist.
 * A symlink is not a regular file: publishing replaces it, so it must not
 * donate its (or its target's) mode to the new file.
 */
async function existingFileMode(abs: string): Promise<number | undefined> {
  try {
    const info = await lstat(abs);
    return info.isFile() ? info.mode & 0o777 : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Publish `text` with same-directory temp + rename (old or new complete). */
async function publishAtomic(
  root: string,
  abs: string,
  text: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await prepareParent(root, abs);
  // A rename swaps the inode, so an overwrite must carry the target's
  // permissions explicitly or a user-hardened 0600 file becomes 0644 under a
  // default umask. Capture the mode before the temp write; chmod after the
  // write so creat(2)'s umask masking cannot broaden or narrow it.
  const mode = await existingFileMode(abs);
  const tmp = tempPathFor(abs);
  try {
    await writeFile(tmp, text, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    if (mode !== undefined) await chmod(tmp, mode);
    await beforeRename?.();
    await rename(tmp, abs);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** Test-only seam to pause between temp write and rename. */
export async function publishAtomicForTests(
  root: string,
  abs: string,
  text: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  return publishAtomic(root, abs, text, beforeRename);
}

/**
 * Publish a new file with temp + hard link (no overwrite, no partial read).
 * `mode` is applied exactly after creation (archives pass 0600).
 */
async function publishExclusive(
  root: string,
  abs: string,
  text: string,
  mode?: number,
): Promise<"created" | "exists"> {
  await prepareParent(root, abs);
  const tmp = tempPathFor(abs);
  try {
    await writeFile(tmp, text, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    if (mode !== undefined) await chmod(tmp, mode);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  try {
    await link(tmp, abs);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
    throw error;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function readRawForMutation(
  file: string,
  root: string,
  onMissing: "throw" | "empty",
): Promise<string> {
  assertAllowedPath(file);
  let handle: FileHandle | undefined;
  try {
    const opened = await openContainedRead(root, file);
    handle = opened.handle;
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (onMissing === "empty") return "";
      throw new Error(`[memory] memory file not found: ${file}`);
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Contained raw read without the write lock or any directory creation.
 * Read-only callers (forget dry-run) must not create `.opencode/memory` or
 * block behind a writer; apply paths re-read under the lock.
 */
export async function readRawContained(
  file: string,
  opts?: Pick<CappedFileOptions, "memoryRoot">,
): Promise<string> {
  const root = resolveMemoryRoot(opts?.memoryRoot);
  return readRawForMutation(file, root, "throw");
}

/**
 * Inner write body: assumes the caller already holds `withFileWriteLock` and
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
    await publishAtomic(root, abs, redactedText);
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
  const headingIdx = findKnownErrorsHeading(working);
  if (headingIdx === -1) {
    throw new Error(
      `[memory] write rejected: activeContext.md has ${total} lines, cap is ${limit}; no Known-Errors block to rotate`,
    );
  }
  const blocks = splitKnownErrorSections(working).blocks;
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
  while (
    countLines(remaining.join("\n")) > limit &&
    blockCursor < blocks.length
  ) {
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
  let archiveRel = rotatedArchiveName();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertAllowedPath(archiveRel);
    const archiveAbs = resolveUnderRoot(root, archiveRel);
    const outcome = await publishExclusive(
      root,
      archiveAbs,
      `# Rotated Known-Errors block(s) from activeContext.md\n\n${rotated.join("\n")}\n`,
      0o600,
    );
    if (outcome === "created") break;
    if (attempt === 4) {
      throw new Error(
        "[memory] could not allocate a unique rotation archive name",
      );
    }
    archiveRel = rotatedArchiveName();
  }
  await publishAtomic(root, abs, remaining.join("\n"));
}

/**
 * Write one allowlisted file (full-content overwrite). Text is redacted
 * first, then the cap is enforced; writes serialize via the in-process file
 * mutex and the cross-process root lock, and publish atomically. Over-cap
 * writes throw — except `activeContext.md`, which rotates the oldest
 * Known-Errors block(s) to `handoffs/archive/` until under cap.
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
  await withCappedTransaction(opts, async (tx) => {
    await tx.write(file, text);
  });
}

/**
 * Exclusive create of one allowlisted file: redaction, caps, and the
 * in-process/cross-process locks apply exactly as in `writeCapped`, but the
 * file must not already exist. Publishing uses temp + hard link, so readers
 * never observe a partial file. Resolves `"created"` on success or `"exists"`
 * when a file is already there (caller decides: dedupe when the content
 * matches, or retry under a suffixed name). Never overwrites, so a same-name
 * collision between two different handoffs cannot destroy either. Intended
 * for immutable new files (`handoffs/`); appends use `updateCapped`,
 * overwrites use `writeCapped`.
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
  const root = resolveMemoryRoot(opts?.memoryRoot);
  return withFileWriteLock(root, async () => {
    const { indexLines, fileLines } = capsOf(opts);
    const abs = resolveUnderRoot(root, file);
    const total = countLines(redactedText);
    const cap = getCapForFile(file, indexLines, fileLines);
    if (Number.isFinite(cap) && total > (cap as number)) {
      throw new Error(
        `[memory] write rejected: ${file} has ${total} lines, cap is ${cap}; refusing to silently truncate`,
      );
    }
    return publishExclusive(root, abs, redactedText);
  });
}

export interface CappedTransaction {
  /** Read raw current text (redaction happens on write). */
  read(file: string): Promise<string>;
  /** Redacted, capped overwrite. */
  write(file: string, text: string): Promise<void>;
  /** Exclusive archive create without a line cap (archive is recall-only). */
  writeArchive(file: string, text: string): Promise<"created" | "exists">;
  /** Contained preflight for a root handoff (no deletion). */
  assertHandoffRemovable(file: string): Promise<"present" | "missing">;
  /** Contained delete for a root handoff; archive/root files are rejected. */
  removeHandoff(file: string): Promise<"deleted" | "missing">;
}

/**
 * Run a short read/plan/write transaction under one lock. Do NOT hold this
 * open across a human permission prompt: plan, release, ask, then re-plan and
 * compare before writing.
 */
export async function withCappedTransaction<T>(
  opts: CappedFileOptions | undefined,
  fn: (tx: CappedTransaction) => Promise<T>,
): Promise<T> {
  const { indexLines, fileLines } = capsOf(opts);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  return withFileWriteLock(root, async () => {
    let closed = false;
    const assertOpen = (): void => {
      if (closed) {
        throw new Error("[memory] transaction already closed");
      }
    };
    try {
      return await fn({
        read: async (file) => {
          assertOpen();
          return readRawForMutation(file, root, "throw");
        },
        write: async (file, text) => {
          assertOpen();
          assertAllowedPath(file);
          await writeRedactedCapped(
            file,
            redact(text),
            root,
            indexLines,
            fileLines,
          );
        },
        writeArchive: async (file, text) => {
          assertOpen();
          assertAllowedPath(file);
          if (!file.startsWith("handoffs/archive/")) {
            throw new Error(
              `[memory] archive write rejected outside handoffs/archive/: ${file}`,
            );
          }
          return publishExclusive(
            root,
            resolveUnderRoot(root, file),
            redact(text),
            0o600,
          );
        },
        assertHandoffRemovable: async (file) => {
          assertOpen();
          if (
            !HANDOFF_PATTERN.test(file) ||
            file.startsWith("handoffs/archive/")
          ) {
            throw new Error(
              `[memory] remove rejected: root handoffs only: ${file}`,
            );
          }
          assertAllowedPath(file);
          const abs = resolveUnderRoot(root, file);
          try {
            await assertContainedAncestors(root, dirname(abs));
            await assertContainedDirectory(root, dirname(abs));
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              return "missing";
            }
            throw error;
          }
          try {
            const info = await lstat(abs);
            if (!info.isFile()) {
              throw new Error(
                `[memory] remove rejected: not a regular handoff file: ${file}`,
              );
            }
            return "present";
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              return "missing";
            }
            throw error;
          }
        },
        removeHandoff: async (file) => {
          assertOpen();
          if (
            !HANDOFF_PATTERN.test(file) ||
            file.startsWith("handoffs/archive/")
          ) {
            throw new Error(
              `[memory] remove rejected: root handoffs only: ${file}`,
            );
          }
          assertAllowedPath(file);
          const abs = resolveUnderRoot(root, file);
          const directory = dirname(abs);
          try {
            await assertContainedAncestors(root, directory);
            await assertContainedDirectory(root, directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              return "missing";
            }
            throw error;
          }
          try {
            await unlink(abs);
            return "deleted";
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
              return "missing";
            }
            throw error;
          }
        },
      });
    } finally {
      closed = true;
    }
  });
}

/**
 * Atomic read-modify-write under the in-process file mutex and the
 * cross-process root lock. The updater receives the current raw content
 * (`""` when the file does not exist yet) and returns the next raw content;
 * redaction, caps, rotation, and archive routing apply exactly as in
 * `writeCapped`. Use this (never a read-outside/write-inside pair) whenever
 * concurrent writers may append to the same file — otherwise the second
 * writer's read misses the first writer's entry and silently drops it.
 */
export async function updateCapped(
  file: string,
  opts: CappedFileOptions | undefined,
  updater: (current: string) => string | Promise<string>,
): Promise<void> {
  assertAllowedPath(file);
  const { indexLines, fileLines } = capsOf(opts);
  const root = resolveMemoryRoot(opts?.memoryRoot);
  await withFileWriteLock(root, async () => {
    const current = await readRawForMutation(file, root, "empty");
    const next = await updater(current);
    if (typeof next !== "string") {
      throw new Error("[memory] updateCapped updater must return a string");
    }
    await writeRedactedCapped(file, redact(next), root, indexLines, fileLines);
  });
}
