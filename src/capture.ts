/**
 * Ledger + storage adapter (spec §5.7 + c4-05).
 *
 * Restart-safe idempotency over `ctx.storage` (plugin-scoped, so every key is
 * namespaced per project: `<projectID>/…` where `<projectID>` is
 * `ctx.location.project.id`). No compare-and-set exists, so check-before-write
 * goes through `get`, concurrent `markSeen` calls for one content ID share a
 * single-flight promise, and all writes serialize via the `withWriteLock`
 * mutex. A duplicate that still slips through is benign (idempotent append).
 *
 * Ledger helpers only — `captureFailure`/`snapshotHandoffIfChanged` land in
 * later tasks (T4/T8) on top of these primitives.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MEMORY_OPTIONS } from "./config.js";
import { resolveMemoryRoot, updateCapped, withWriteLock, writeNewCapped, type CappedFileOptions } from "./files.js";
import { flagInjection } from "./guard.js";
import { redact } from "./redact.js";

/**
 * Minimum surface of `ctx.storage` the ledger needs. Method shorthand keeps
 * this bivariant so both the real `ctx.storage` and test fakes satisfy it.
 */
export interface LedgerStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit?: number;
  }): Promise<{
    readonly entries: ReadonlyArray<{
      readonly key: string;
      readonly value: unknown;
    }>;
    readonly next?: string;
  }>;
}

/** Max `seen` entries; pruning evicts oldest-first down to this. */
export const SEEN_LIMIT = 500;

/** Retry window for a failed capture attempt (~30s via the attempt key). */
export const RETRY_WINDOW_MS = 30_000;

/** In-flight `markSeen` writes keyed by full storage key (single-flight). */
const inflight = new Map<string, Promise<boolean>>();

/** In-process single-flight for in-progress failure captures by content ID:
 * concurrent `execute.after` events for one failure converge on a single
 * append instead of each passing the `hasSeen` check and duplicating the
 * entry (with a double `pending` increment). Keyed by projectID + contentID
 * (M-3): two projects hashing the same generic failure must not dedupe each
 * other. The persisted ledger remains the cross-restart dedupe. */
const captureInflight = new Set<string>();

function captureFlightKey(projectID: string, contentID: string): string {
  return `${projectID}\0${contentID}`;
}

/** In-process single-flight for compaction captures by event ID (M-4):
 * `session.compaction.ended` is durable and `subscribe` may redeliver it;
 * concurrent redeliveries during `writeHandoffUnique` IO must converge on
 * one handoff instead of minting `-01` siblings. Keyed by projectID + event
 * ID like the failure path. */
const compactionInflight = new Set<string>();

function compactionFlightKey(projectID: string, eventID: string): string {
  return `${projectID}\0${eventID}`;
}

/** Test seam: drop single-flight state between isolated suites. */
export function resetLedgerSingleFlightForTests(): void {
  inflight.clear();
  captureInflight.clear();
  compactionInflight.clear();
}

function requireNonEmpty(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[memory] ledger ${name} must be a non-empty string`);
  }
  return value;
}

function projectPrefix(projectID: string): string {
  return `${requireNonEmpty("projectID", projectID)}/`;
}

/** `<projectID>/seen/<contentID>` → first-seen timestamp. */
export function seenKey(projectID: string, contentID: string): string {
  return `${projectPrefix(projectID)}seen/${requireNonEmpty("contentID", contentID)}`;
}

/** `<projectID>/attempt/<contentID>` → last attempt timestamp. */
export function attemptKey(projectID: string, contentID: string): string {
  return `${projectPrefix(projectID)}attempt/${requireNonEmpty("contentID", contentID)}`;
}

/** `<projectID>/curation.pending` → uncurated scratchpad count. */
export function pendingKey(projectID: string): string {
  return `${projectPrefix(projectID)}curation.pending`;
}

/** `<projectID>/curation.rotated` → transient rotation marker (count). */
export function rotatedKey(projectID: string): string {
  return `${projectPrefix(projectID)}curation.rotated`;
}

/** `<projectID>/snapshot/<sessionID>` → last snapshot content hash. */
export function snapshotKey(projectID: string, sessionID: string): string {
  return `${projectPrefix(projectID)}snapshot/${requireNonEmpty("sessionID", sessionID)}`;
}

/** `<projectID>/snapshotThrottle/<sessionID>` → last fallback-snapshot time. */
export function throttleKey(projectID: string, sessionID: string): string {
  return `${projectPrefix(projectID)}snapshotThrottle/${requireNonEmpty("sessionID", sessionID)}`;
}

/** `<projectID>/hint/<sessionID>/<promptHash>` → once-per-prompt throttle. */
export function hintKey(
  projectID: string,
  sessionID: string,
  promptHash: string,
): string {
  return `${projectPrefix(projectID)}hint/${requireNonEmpty("sessionID", sessionID)}/${requireNonEmpty("promptHash", promptHash)}`;
}

/** True when the content ID was already recorded (check-before-write read). */
export async function hasSeen(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
): Promise<boolean> {
  return (await storage.get(seenKey(projectID, contentID))) != null;
}

/**
 * Record a content ID. Resolves `true` when newly recorded (caller proceeds),
 * `false` on replay. Concurrent calls for one ID share a single storage
 * write; every write runs under the mutex.
 */
export function markSeen(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = seenKey(projectID, contentID);
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = withWriteLock(async () => {
    if ((await storage.get(key)) != null) return false;
    await storage.set(key, now);
    return true;
  });
  inflight.set(key, run);
  const cleanup = (): void => {
    if (inflight.get(key) === run) inflight.delete(key);
  };
  run.then(cleanup, cleanup);
  return run;
}

/**
 * True when a capture for the content ID may (re)try: no attempt yet, or the
 * last attempt is inside the ~30s window. Older attempts are abandoned.
 */
export async function shouldRetry(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<boolean> {
  const last = await storage.get(attemptKey(projectID, contentID));
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last <= RETRY_WINDOW_MS;
}

/** Record a capture attempt timestamp. */
export async function markAttempt(
  storage: LedgerStorage,
  projectID: string,
  contentID: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(attemptKey(projectID, contentID), now);
  });
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Uncurated scratchpad captures since the last apply (0 when unset). */
export async function getPending(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  return asCount(await storage.get(pendingKey(projectID)));
}

/** Increment the pending count (read-modify-write under the mutex). */
export async function incPending(
  storage: LedgerStorage,
  projectID: string,
  by = 1,
): Promise<number> {
  if (!Number.isInteger(by) || by <= 0) {
    throw new Error("[memory] ledger incPending delta must be a positive int");
  }
  return withWriteLock(async () => {
    const next = asCount(await storage.get(pendingKey(projectID))) + by;
    await storage.set(pendingKey(projectID), next);
    return next;
  });
}

/** Reset pending to 0 (memory_apply completion, incl. empty candidates). */
export async function resetPending(
  storage: LedgerStorage,
  projectID: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(pendingKey(projectID), 0);
  });
}

/** Rotation marker count, or `undefined` when no rotation is pending. */
export async function getRotated(
  storage: LedgerStorage,
  projectID: string,
): Promise<number | undefined> {
  const value = await storage.get(rotatedKey(projectID));
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Record how many blocks rotated out of `activeContext.md`. */
export async function setRotated(
  storage: LedgerStorage,
  projectID: string,
  count: number,
): Promise<void> {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("[memory] ledger rotated count must be a positive int");
  }
  await withWriteLock(async () => {
    await storage.set(rotatedKey(projectID), count);
  });
}

/** Clear the rotation marker after `statusLine()` reports it. */
export async function clearRotated(
  storage: LedgerStorage,
  projectID: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.remove(rotatedKey(projectID));
  });
}

/** Last snapshot content hash for the session, if any. */
export async function getSnapshotHash(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<string | undefined> {
  const value = await storage.get(snapshotKey(projectID, sessionID));
  return typeof value === "string" ? value : undefined;
}

/** Persist the snapshot content hash for hash-guarded idempotency. */
export async function setSnapshotHash(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  hash: string,
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(snapshotKey(projectID, sessionID), hash);
  });
}

/** Last fallback-snapshot timestamp for the session, if any. */
export async function getThrottle(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
): Promise<number | undefined> {
  const value = await storage.get(throttleKey(projectID, sessionID));
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Persist the fallback-snapshot timestamp for the session. */
export async function setThrottle(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(throttleKey(projectID, sessionID), now);
  });
}

/** True when the hint for this prompt was already emitted. */
export async function hasHint(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  promptHash: string,
): Promise<boolean> {
  return (await storage.get(hintKey(projectID, sessionID, promptHash))) != null;
}

/** Record that the hint for this prompt was emitted. */
export async function setHint(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  promptHash: string,
  now: number = Date.now(),
): Promise<void> {
  await withWriteLock(async () => {
    await storage.set(hintKey(projectID, sessionID, promptHash), now);
  });
}

/**
 * Bound the `seen` set to `SEEN_LIMIT` entries: paginate `scan` via
 * `after`/`next` over `<projectID>/seen/`, evict oldest-first by stored
 * timestamp (missing/non-numeric = oldest, key order breaks ties), and remove
 * only this project's `seen` keys. Resolves the number of entries removed.
 */
export async function pruneSeenTo500(
  storage: LedgerStorage,
  projectID: string,
): Promise<number> {
  const prefix = `${projectPrefix(projectID)}seen/`;
  const all: Array<{ key: string; seenAt: number }> = [];
  let after: string | undefined;
  for (;;) {
    const page =
      after === undefined
        ? await storage.scan({ prefix })
        : await storage.scan({ prefix, after });
    for (const entry of page.entries) {
      all.push({
        key: entry.key,
        seenAt:
          typeof entry.value === "number" && Number.isFinite(entry.value)
            ? entry.value
            : 0,
      });
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  const overflow = all.length - SEEN_LIMIT;
  if (overflow <= 0) return 0;
  all.sort((a, b) =>
    a.seenAt === b.seenAt
      ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      : a.seenAt - b.seenAt,
  );
  const victims = all.slice(0, overflow);
  await withWriteLock(async () => {
    for (const victim of victims) {
      await storage.remove(victim.key);
    }
  });
  return victims.length;
}

/* ------------------------------------------------------------------ */
/* captureFailure (spec §5.3 + c4-04 tool-hook contract, G4 baseline)  */
/* ------------------------------------------------------------------ */

/** Max chars of the message-derived summary line (spec §5.2). */
export const FAILURE_SUMMARY_CHARS = 120;

/** Max recall-only detail lines, written only when the event carries output. */
export const FAILURE_DETAIL_LINES = 20;

const KNOWN_ERRORS_HEADING_LINE = "## Known errors";

const ACTIVE_CONTEXT_SCAFFOLD = `# Active context — current slice (append-until-60, then rotate)

## Goal
- (what this session is trying to do)

## Pending
- (open items)

## Next
- (immediate next steps)

## Known errors
`;

const METADATA_OUTPUT_KEYS = [
  "output",
  "stdout",
  "stderr",
  "text",
  "body",
  "logs",
  "log",
  "outputText",
  "detail",
] as const;

export type CaptureReason =
  | "captured"
  | "duplicate"
  | "skipped"
  | "retry-later"
  | "failed";

export interface CaptureOutcome {
  readonly reason: CaptureReason;
  readonly contentID?: string;
}

export interface CaptureFailureOptions extends CappedFileOptions {
  readonly now?: number;
  readonly log?: (error: unknown) => void;
}

/** Collapse whitespace/newlines and cap at `FAILURE_SUMMARY_CHARS`. */
function summaryLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "unknown error";
  return collapsed.slice(0, FAILURE_SUMMARY_CHARS);
}

/**
 * Best-effort `<cmd>` from untyped `event.input` (shell-tool-dependent;
 * G4 never assumes it). Returns `undefined` when nothing yields a command.
 */
function commandOf(input: unknown): string | undefined {
  try {
    if (typeof input !== "object" || input === null) {
      return typeof input === "string" && input.trim().length > 0
        ? input.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 60)
        : undefined;
    }
    const record = input as Record<string, unknown>;
    // Only real command spellings — never the `tool` name (e.g. "bash"),
    // which is not a command and would mislabel the summary prefix.
    for (const key of ["command", "cmd"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const cmd = value
          .split("\n")[0]!
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        if (cmd.length > 0) return cmd;
      }
    }
    const args = record["args"];
    if (
      Array.isArray(args) &&
      args.every((a) => typeof a === "string") &&
      args.length > 0
    ) {
      const cmd = (args as string[])
        .join(" ")
        .split("\n")[0]!
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (cmd.length > 0) return cmd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Optional recall-only detail: the sole candidate source is untyped
 * `error.metadata` inspection — never assumed present. Returns at most the
 * last `FAILURE_DETAIL_LINES` lines, or `undefined` when no output is found.
 */
function detailOf(metadata: unknown): string[] | undefined {
  try {
    let output: string | undefined;
    if (typeof metadata === "string") {
      output = metadata;
    } else if (typeof metadata === "object" && metadata !== null) {
      const record = metadata as Record<string, unknown>;
      for (const key of METADATA_OUTPUT_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          output = value;
          break;
        }
      }
      if (output === undefined) {
        for (const value of Object.values(record)) {
          if (typeof value === "string" && value.trim().length > 0) {
            output = value;
            break;
          }
        }
      }
    }
    if (output === undefined || output.trim().length === 0) return undefined;
    const lines = output.split("\n");
    return lines.slice(-FAILURE_DETAIL_LINES);
  } catch {
    return undefined;
  }
}

/** Stable content ID over the redacted summary + detail. */
export function failureContentID(summary: string, detail: string): string {
  return createHash("sha256")
    .update(`${summary}\n${detail}`, "utf8")
    .digest("hex");
}

async function listArchive(root: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(join(root, "handoffs", "archive")));
  } catch {
    return new Set();
  }
}

/**
 * Failure-only capture for the `execute.after` tool hook (spec §5.3).
 *
 * Builds a `source:tool` message-derived summary line (`error.message`
 * first line, ≤120 chars) with a `<cmd>:` prefix only when untyped
 * `event.input` yields one, plus an optional ≤20-line recall-only detail
 * block only when `error.metadata` carries output. Redacts, ledger-dedupes
 * by stable content ID (~30s retry), appends under Known Errors via
 * `writeCapped`, marks seen + attempt, increments scratchpad-only pending,
 * and sets the rotated marker when the append rotated. Advisory
 * `flagInjection` flags travel with the entry. Never throws.
 */
export async function captureFailure(
  event: unknown,
  storage: LedgerStorage,
  projectID: string,
  memoryRoot?: string,
  options?: CaptureFailureOptions,
): Promise<CaptureOutcome> {
  const log = options?.log ?? (() => undefined);
  const fail = (error: unknown): CaptureOutcome => {
    try {
      log(error);
    } catch {
      // Logging must never break the tool hook.
    }
    return { reason: "failed" };
  };
  try {
    if (typeof event !== "object" || event === null) {
      return { reason: "skipped" };
    }
    const record = event as Record<string, unknown>;
    const status = record["status"];
    const errorValue = record["error"];
    // Failures only: prefer `status`, fall back to `error != null` (G4).
    if (status !== undefined) {
      if (status !== "error") return { reason: "skipped" };
    } else if (errorValue === null || errorValue === undefined) {
      return { reason: "skipped" };
    }

    const errorRecord =
      typeof errorValue === "object" && errorValue !== null
        ? (errorValue as Record<string, unknown>)
        : undefined;
    const rawMessage =
      typeof errorRecord?.["message"] === "string"
        ? (errorRecord["message"] as string)
        : typeof errorValue === "string"
          ? errorValue
          : "unknown error";
    const messageFirst = rawMessage.split("\n")[0] ?? "";
    const cmd = commandOf(record["input"]);
    const summary = summaryLine(
      cmd !== undefined ? `${cmd}: ${messageFirst}` : messageFirst,
    );
    const detailLines = detailOf(errorRecord?.["metadata"]);
    const detail = detailLines?.join("\n") ?? "";

    const redactedSummary = redact(summary);
    const redactedDetail = redact(detail);
    const contentID = failureContentID(redactedSummary, redactedDetail);

    if (await hasSeen(storage, projectID, contentID)) {
      return { reason: "duplicate", contentID };
    }
    const flightKey = captureFlightKey(projectID, contentID);
    if (captureInflight.has(flightKey)) {
      return { reason: "duplicate", contentID };
    }
    captureInflight.add(flightKey);
    try {
      if (!(await shouldRetry(storage, projectID, contentID, options?.now))) {
        return { reason: "retry-later", contentID };
      }
      await markAttempt(storage, projectID, contentID, options?.now);

    const flags = flagInjection(`${redactedSummary}\n${redactedDetail}`);
    const block: string[] = [`- ${redactedSummary} source:tool`];
    if (redactedDetail.length > 0) {
      for (const line of redactedDetail.split("\n")) block.push(`  ${line}`);
    }
    if (flags.length > 0) {
      block.push(`  <!-- flags: ${flags.join(", ")} (advisory) -->`);
    }
    const entry = `${block.join("\n")}\n`;

    const root = resolveMemoryRoot(memoryRoot);
    const before = await listArchive(root);
    // Atomic read-modify-write inside the choke-point lock: concurrent
    // failure captures must not read the same base and drop each other.
    await updateCapped(
      "activeContext.md",
      {
        memoryRoot,
        fileLines: options?.fileLines,
        indexLines: options?.indexLines,
      },
      (current) => {
        if (current.length === 0) return `${ACTIVE_CONTEXT_SCAFFOLD}${entry}`;
        const withNewline = current.endsWith("\n") ? current : `${current}\n`;
        return /^##\s+known errors\s*$/im.test(current)
          ? `${withNewline}${entry}`
          : `${withNewline}\n${KNOWN_ERRORS_HEADING_LINE}\n${entry}`;
      },
    );
    await markSeen(storage, projectID, contentID, options?.now);
    await incPending(storage, projectID);

    // Bound the seen set: fire-and-forget off the write mutex (prune takes
    // its own lock); never throws, logging is best-effort.
    void pruneSeenTo500(storage, projectID).catch((error) => {
      try {
        log(error);
      } catch {
        // Logging must never break the tool hook.
      }
    });

    // Rotation marker for the status line: a fresh archive file means this
    // append rotated the oldest Known-Errors block(s) out.
    try {
      const after = await listArchive(root);
      const fresh = [...after].filter((name) => !before.has(name));
      if (fresh.length > 0) {
        let blocks = 0;
        for (const name of fresh) {
          try {
            const archived = await readFile(
              join(root, "handoffs", "archive", name),
              "utf8",
            );
            blocks += archived
              .split("\n")
              .filter((line) => /^\s*-\s+/.test(line)).length;
          } catch {
            // Fall through to the file-count fallback below.
          }
        }
        await setRotated(storage, projectID, blocks > 0 ? blocks : fresh.length);
      }
    } catch {
      // Rotation reporting is best-effort; the capture already landed.
    }
    return { reason: "captured", contentID };
    } finally {
      captureInflight.delete(captureFlightKey(projectID, contentID));
    }
  } catch (error) {
    return fail(error);
  }
}

/* ------------------------------------------------------------------ */
/* Task 8: idle/compaction capture + VCS adapter (spec §§5.7, 5.9)     */
/* ------------------------------------------------------------------ */

/**
 * Plugin project identity for location isolation. `directory` is the
 * normalized project root (`canonical ?? directory`, no trailing slash);
 * `projectID` is `ctx.location.project.id` when present.
 */
export interface PluginLocation {
  readonly directory: string;
  readonly projectID?: string;
}

/**
 * Minimal structural surface of `ctx.vcs` the snapshots need. Deliberately
 * loose: the live docs prose shows a flat `branches()` while the 2.0.29
 * client types expose `branch.list()` — both are accepted (prefer
 * `branch.list()`), and every call is `.data`-unwrapped with a warn-only
 * shape check that never throws.
 */
export interface VcsPort {
  readonly get?: () => Promise<unknown>;
  readonly status?: () => Promise<unknown>;
  readonly branch?: { readonly list?: () => Promise<unknown> };
  readonly branches?: () => Promise<unknown>;
  readonly diff?: (input: {
    readonly mode: string;
    readonly base?: string;
    readonly context?: number;
  }) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * True when the subscribed event belongs to this plugin instance.
 * `ctx.event.subscribe` is the server-wide stream, so `event.location`
 * carries other projects too: a present `event.location.directory` must
 * equal the plugin directory, and a present `data.projectID` must equal
 * the plugin project ID. Location-less events pass here — the
 * unknown-session drop for `session.idle` lives in
 * `snapshotHandoffIfChanged`, which has the ledger to judge known-ness.
 * Never throws.
 */
export function isThisLocation(
  event: unknown,
  plugin: PluginLocation,
): boolean {
  try {
    const record = asRecord(event);
    if (record === undefined) return false;
    const dir = asRecord(record["location"])?.["directory"];
    if (typeof dir === "string" && dir.length > 0) {
      if (stripTrailingSlashes(dir) !== stripTrailingSlashes(plugin.directory)) {
        return false;
      }
    }
    const projectID = asRecord(record["data"])?.["projectID"];
    if (typeof projectID === "string" && projectID.length > 0) {
      if (
        typeof plugin.projectID === "string" &&
        plugin.projectID.length > 0 &&
        projectID !== plugin.projectID
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Event-type prefixes worth one diagnostic log line (sample allowlist). */
const KNOWN_DIAGNOSTIC_PREFIXES = [
  "session.",
  "permission.",
  "vcs.",
  "mcp.",
  "project.",
  "worktree.",
  "command.",
] as const;

/**
 * True for sampled diagnostics only. `tui.*` chatter and unknown/vendor
 * event noise are dropped by default (the loop stays silent for them).
 * `session.compaction.*` is routed before this check, so overlap is fine.
 * Never throws.
 */
export function isKnownDiagnostic(event: unknown): boolean {
  try {
    const type = asRecord(event)?.["type"];
    if (typeof type !== "string" || type.length === 0) return false;
    if (type.startsWith("tui.")) return false;
    return KNOWN_DIAGNOSTIC_PREFIXES.some((prefix) =>
      type.startsWith(prefix),
    );
  } catch {
    return false;
  }
}

/** Branch + normalized open-change file list behind the VCS adapter. */
export interface VcsSnapshot {
  readonly branch: string;
  readonly changes: readonly string[];
}

/** Unwrap the `{ location, data }` envelope; tolerate bare payloads. */
function unwrapData(envelope: unknown): unknown {
  const record = asRecord(envelope);
  if (record !== undefined && "data" in record) return record["data"];
  return envelope;
}

/**
 * Normalize `FileStatus[]` and the `FileDiff[]` fallback to sorted unique
 * file-path strings before hashing (the fallback changes the element
 * shape, so raw values must never reach the hash).
 */
function normalizeChanges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.length > 0) out.push(entry);
    } else {
      const file = asRecord(entry)?.["file"];
      if (typeof file === "string" && file.length > 0) {
        out.push(file);
      } else if (entry !== null && entry !== undefined) {
        try {
          out.push(JSON.stringify(entry));
        } catch {
          // Unstringifiable entries carry no hashable signal; skip.
        }
      }
    }
  }
  return [...new Set(out)].sort();
}

async function readDiffFallback(
  vcs: VcsPort | undefined,
  warn: (error: unknown) => void,
): Promise<string[]> {
  if (typeof vcs?.diff !== "function") {
    warn(new Error("[memory] vcs.diff missing; no open-change signal"));
    return [];
  }
  const raw = unwrapData(await vcs.diff({ mode: "working", context: 3 }));
  if (!Array.isArray(raw)) {
    warn(new Error("[memory] vcs diff shape unexpected"));
    return [];
  }
  return normalizeChanges(raw);
}

/**
 * The one VCS adapter: branch via `(await vcs.get()).data.branch.current`
 * (fallback `(await (vcs.branch?.list ?? vcs.branches)()).data[0] ??
 * "unknown"`, warn-only); open changes via `(await
 * vcs.status()).data` (fallback `(await vcs.diff({ mode: "working",
 * context: 3 })).data`, normalized to strings). Shape drift is warn-only —
 * this never throws; worst case is `{ branch: "unknown", changes: [] }`.
 */
export async function readVcsSnapshot(
  vcs: VcsPort | undefined,
  log?: (error: unknown) => void,
): Promise<VcsSnapshot> {
  const warn = (error: unknown): void => {
    try {
      (log ?? (() => undefined))(error);
    } catch {
      // Logging must never break capture.
    }
  };
  let branch = "unknown";
  try {
    if (vcs?.get === undefined) {
      warn(new Error("[memory] vcs.get missing"));
    } else {
      const current = asRecord(
        asRecord(unwrapData(await vcs.get()))?.["branch"],
      )?.["current"];
      if (typeof current === "string" && current.length > 0) {
        branch = current;
      } else {
        const list = vcs.branch?.list;
        const legacy = vcs.branches;
        let listed: unknown;
        if (typeof list === "function") listed = unwrapData(await list());
        else if (typeof legacy === "function") {
          listed = unwrapData(await legacy());
        } else {
          warn(
            new Error(
              "[memory] vcs branch source missing (branch.list/branches)",
            ),
          );
        }
        if (listed !== undefined) {
          const first = Array.isArray(listed) ? listed[0] : undefined;
          if (typeof first === "string" && first.length > 0) branch = first;
          else warn(new Error("[memory] vcs branch list shape unexpected"));
        }
      }
    }
  } catch (error) {
    warn(error);
  }
  let changes: string[] = [];
  let statusOk = false;
  try {
    if (vcs?.status === undefined) {
      warn(new Error("[memory] vcs.status missing; trying diff fallback"));
    } else {
      const raw = unwrapData(await vcs.status());
      if (Array.isArray(raw)) {
        changes = normalizeChanges(raw);
        statusOk = true;
      } else {
        warn(
          new Error("[memory] vcs status shape unexpected; trying diff fallback"),
        );
      }
    }
  } catch (error) {
    warn(error);
  }
  if (!statusOk) {
    try {
      changes = await readDiffFallback(vcs, warn);
    } catch (error) {
      warn(error);
      changes = [];
    }
  }
  return { branch, changes };
}

function eventDirectoryOf(event: Record<string, unknown>): string | undefined {
  const dir = asRecord(event["location"])?.["directory"];
  return typeof dir === "string" && dir.length > 0 ? dir : undefined;
}

function eventSessionIDOf(
  event: Record<string, unknown>,
): string | undefined {
  const id = asRecord(event["data"])?.["sessionID"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function eventTimeOf(event: Record<string, unknown>, now: number): number {
  const created = event["created"];
  return typeof created === "number" && Number.isFinite(created)
    ? created
    : now;
}

function handoffStamp(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Last-6 of the session ID, sanitized for the handoff allowlist. */
function sessionSuffix(sessionID: string): string {
  return sessionID.slice(-6).replace(/[^A-Za-z0-9._-]/g, "-") || "session";
}

/** Immutable newest-wins name: `handoffs/YYYY-MM-DD-HHmmss-<session6>.md`. */
export function handoffName(sessionID: string, now: number): string {
  return `handoffs/${handoffStamp(now)}-${sessionSuffix(sessionID)}.md`;
}

/** Collision suffix: fixed-width `-NN`, so suffixed names keep a stable
 * lexicographic order (`-01` < `-02`; never bare `-1`, which would sort
 * before the unsuffixed base since `-` < `.`). */
function suffixedHandoffName(base: string, seq: number): string {
  return `${base.slice(0, -".md".length)}-${String(seq).padStart(2, "0")}.md`;
}

/**
 * Write a handoff without ever overwriting an existing file. The base name
 * keeps the spec format; only a genuine same-name/different-content
 * collision (same session, same second, e.g. an idle snapshot racing a
 * compaction handoff) mints a `-01`, `-02`, … sibling. Same content
 * resolves to the existing file (dedupe, no duplicate). Returns the file
 * that now holds the content. Throws past 99 siblings (unreachable in
 * practice; the caller reports `failed` and its guards stay unset so a
 * retry can proceed).
 */
export async function writeHandoffUnique(
  baseFile: string,
  body: string,
  opts?: CappedFileOptions,
): Promise<string> {
  const wanted = redact(body);
  for (let seq = 0; seq <= 99; seq += 1) {
    const file = seq === 0 ? baseFile : suffixedHandoffName(baseFile, seq);
    const outcome = await writeNewCapped(file, body, opts);
    if (outcome === "created") return file;
    const root = resolveMemoryRoot(opts?.memoryRoot);
    let current: string;
    try {
      current = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (current === wanted) return file;
  }
  throw new Error(
    `[memory] write rejected: too many handoff siblings for ${baseFile}`,
  );
}

/** Stable content hash over branch + normalized status + pending count. */
export function snapshotContentHash(
  branch: string,
  changes: readonly string[],
  pending: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ branch, changes: [...changes], pending }),
      "utf8",
    )
    .digest("hex");
}

/** Resolve the memory root for the event's session/location (never cached). */
function resolveSnapshotRoot(
  event: Record<string, unknown>,
  fallbackMemoryRoot?: string,
): string {
  const dir = eventDirectoryOf(event);
  if (dir !== undefined) return resolveMemoryRoot(join(dir, ".opencode", "memory"));
  return resolveMemoryRoot(fallbackMemoryRoot);
}

function fitLines(lines: string[], cap: number): string {
  const limit =
    Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MEMORY_OPTIONS.fileLines;
  if (lines.length <= limit) return `${lines.join("\n")}\n`;
  const kept = lines.slice(0, limit);
  kept[limit - 1] =
    `[truncated: showing first ${limit - 1} of ${lines.length} lines]`;
  return `${kept.join("\n")}\n`;
}

/** Max open-change lines listed in an idle handoff (hash covers all). */
const IDLE_DISPLAY_CHANGES = 40;

function buildIdleHandoff(input: {
  readonly sessionID: string;
  readonly branch: string;
  readonly changes: readonly string[];
  readonly pending: number;
  readonly now: number;
  readonly fileLines?: number;
}): string {
  const lines = [
    `# Handoff ${new Date(input.now).toISOString()} (source:snapshot)`,
    ``,
    `- session: ${input.sessionID}`,
    `- branch: ${input.branch}`,
    `- pending-captures: ${input.pending}`,
    ``,
    `## Open changes`,
  ];
  if (input.changes.length === 0) {
    lines.push(`- (clean)`);
  } else {
    for (const file of input.changes.slice(0, IDLE_DISPLAY_CHANGES)) {
      lines.push(`- ${file}`);
    }
    if (input.changes.length > IDLE_DISPLAY_CHANGES) {
      lines.push(`- (+${input.changes.length - IDLE_DISPLAY_CHANGES} more)`);
    }
  }
  lines.push(``, `## Next`, `- (resume here; newest handoff wins)`);
  return fitLines(lines, input.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines);
}

/** Max summary/recent lines carried in a compaction handoff. */
const COMPACTION_TEXT_LINES = 40;
const COMPACTION_RECENT_LINES = 8;

function cappedSection(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [
    ...lines.slice(0, max),
    `[truncated: showing first ${max} of ${lines.length} lines]`,
  ];
}

function buildCompactionHandoff(input: {
  readonly sessionID: string;
  readonly reason: string;
  readonly branch: string;
  readonly text: string;
  readonly recent: string;
  readonly now: number;
  readonly fileLines?: number;
}): string {
  const lines = [
    `# Handoff ${new Date(input.now).toISOString()} (source:snapshot, compaction)`,
    ``,
    `- session: ${input.sessionID}`,
    `- reason: ${input.reason}`,
    `- branch: ${input.branch}`,
    ``,
    `## Summary`,
    ...cappedSection(input.text.split("\n"), COMPACTION_TEXT_LINES),
  ];
  if (input.recent.trim().length > 0) {
    lines.push(
      ``,
      `## Recent`,
      ...cappedSection(input.recent.split("\n"), COMPACTION_RECENT_LINES),
    );
  }
  return fitLines(lines, input.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines);
}

function buildPointerHandoff(input: {
  readonly sessionID: string;
  readonly reason: string;
  readonly branch: string;
  readonly now: number;
  readonly fileLines?: number;
}): string {
  return fitLines(
    [
      `# Handoff ${new Date(input.now).toISOString()} (source:snapshot, compaction)`,
      ``,
      `- session: ${input.sessionID}`,
      `- reason: ${input.reason}`,
      `- branch: ${input.branch}`,
      ``,
      `compaction occurred (summary unavailable; run /memory-review).`,
    ],
    input.fileLines ?? DEFAULT_MEMORY_OPTIONS.fileLines,
  );
}

export interface SnapshotDeps {
  readonly vcs?: VcsPort;
  readonly storage: LedgerStorage;
  readonly projectID: string;
  /** Fallback (ctx) memory root; the event location wins when present. */
  readonly memoryRoot?: string;
  readonly fileLines?: number;
  readonly now?: number;
  readonly log?: (error: unknown) => void;
}

export type SnapshotReason =
  | "written"
  | "unchanged"
  | "skipped"
  | "dropped"
  | "failed";

export interface SnapshotOutcome {
  readonly reason: SnapshotReason;
  readonly file?: string;
}

/**
 * Idle snapshot writer (spec §5.7/§5.9 D-A).
 *
 * Resolves the memory root for the event's session/location
 * (`event.location.directory`, fallback `deps.memoryRoot`) — never from a
 * root captured once at load. Branch/changes come from the VCS adapter;
 * `hash(branch + status + pending)` equal to
 * `<projectID>/snapshot/<sessionID>` is a no-op, otherwise an immutable
 * `handoffs/YYYY-MM-DD-HHmmss-<session6>.md` is written (newest wins).
 * Location-less `idle` for a session with neither a snapshot nor a
 * throttle key is dropped + debug-logged. Serialized via `writeCapped`'s
 * mutex; never throws.
 */
export async function snapshotHandoffIfChanged(
  event: unknown,
  deps: SnapshotDeps,
): Promise<SnapshotOutcome> {
  const log = deps.log ?? (() => undefined);
  const fail = (error: unknown): SnapshotOutcome => {
    try {
      log(error);
    } catch {
      // Logging must never break capture.
    }
    return { reason: "failed" };
  };
  try {
    const record = asRecord(event);
    if (record === undefined) return { reason: "skipped" };
    if (record["type"] !== undefined && record["type"] !== "session.idle") {
      return { reason: "skipped" };
    }
    const sessionID = eventSessionIDOf(record);
    if (sessionID === undefined) return { reason: "skipped" };
    if (eventDirectoryOf(record) === undefined) {
      let known = false;
      try {
        known =
          (await getSnapshotHash(deps.storage, deps.projectID, sessionID)) !==
            undefined ||
          (await getThrottle(deps.storage, deps.projectID, sessionID)) !==
            undefined;
      } catch (error) {
        return fail(error);
      }
      if (!known) {
        try {
          log(`[memory] dropping location-less idle for unknown session`);
        } catch {
          // Logging must never break capture.
        }
        return { reason: "dropped" };
      }
    }
    const now = deps.now ?? Date.now();
    const at = eventTimeOf(record, now);
    const { branch, changes } = await readVcsSnapshot(deps.vcs, log);
    let pending = 0;
    try {
      pending = await getPending(deps.storage, deps.projectID);
    } catch (error) {
      return fail(error);
    }
    const hash = snapshotContentHash(branch, changes, pending);
    try {
      if ((await getSnapshotHash(deps.storage, deps.projectID, sessionID)) === hash) {
        return { reason: "unchanged" };
      }
    } catch (error) {
      return fail(error);
    }
    const root = resolveSnapshotRoot(record, deps.memoryRoot);
    const file = await writeHandoffUnique(
      handoffName(sessionID, at),
      buildIdleHandoff({
        sessionID,
        branch,
        changes,
        pending,
        now: at,
        fileLines: deps.fileLines,
      }),
      { memoryRoot: root, fileLines: deps.fileLines },
    );
    try {
      await setSnapshotHash(deps.storage, deps.projectID, sessionID, hash);
    } catch (error) {
      return fail(error);
    }
    return { reason: "written", file };
  } catch (error) {
    return fail(error);
  }
}

export interface CompactionDeps {
  readonly vcs?: VcsPort;
  readonly storage: LedgerStorage;
  readonly projectID: string;
  /** Fallback (ctx) memory root; the event location wins when present. */
  readonly memoryRoot?: string;
  readonly fileLines?: number;
  readonly now?: number;
  readonly log?: (error: unknown) => void;
}

export type CompactionReason =
  | "captured"
  | "duplicate"
  | "skipped"
  | "dropped"
  | "failed";

export interface CompactionOutcome {
  readonly reason: CompactionReason;
  readonly file?: string;
}

/**
 * Produced-summary capture (spec §5.9 D-B): `session.compaction.ended`
 * `data.text` (+ kept-tail `data.recent`) → `handoffs/`, replay-guarded via
 * `<projectID>/seen/<event.id>` (`ended` is durable, `subscribe` replays
 * redeliver it). When the produced text is missing, a pointer-only handoff
 * (timestamp + branch + "compaction occurred") is written instead. Never
 * throws.
 */
export async function captureCompactionOutcome(
  event: unknown,
  deps: CompactionDeps,
): Promise<CompactionOutcome> {
  const log = deps.log ?? (() => undefined);
  const fail = (error: unknown): CompactionOutcome => {
    try {
      log(error);
    } catch {
      // Logging must never break capture.
    }
    return { reason: "failed" };
  };
  try {
    const record = asRecord(event);
    if (record === undefined) return { reason: "skipped" };
    if (
      record["type"] !== undefined &&
      record["type"] !== "session.compaction.ended"
    ) {
      return { reason: "skipped" };
    }
    const id = record["id"];
    if (typeof id !== "string" || id.length === 0) return { reason: "skipped" };
    const data = asRecord(record["data"]);
    const sessionID =
      typeof data?.["sessionID"] === "string" && data["sessionID"].length > 0
        ? (data["sessionID"] as string)
        : undefined;
    if (sessionID === undefined) return { reason: "skipped" };
    // M-4: location-less `compaction.ended` for an unknown session is
    // dropped (symmetric with the idle path). Without an event directory the
    // root falls back to the receiver's memoryRoot, which would poison the
    // receiver's handoffs/ + seen ledger under the receiver's projectID.
    if (eventDirectoryOf(record) === undefined) {
      let known = false;
      try {
        known =
          (await getSnapshotHash(deps.storage, deps.projectID, sessionID)) !==
            undefined ||
          (await getThrottle(deps.storage, deps.projectID, sessionID)) !==
            undefined;
      } catch (error) {
        return fail(error);
      }
      if (!known) {
        try {
          log(`[memory] dropping location-less compaction for unknown session`);
        } catch {
          // Logging must never break capture.
        }
        return { reason: "dropped" };
      }
    }
    let fresh: boolean;
    try {
      fresh = !(await hasSeen(deps.storage, deps.projectID, id));
    } catch (error) {
      return fail(error);
    }
    if (!fresh) return { reason: "duplicate" };
    const flightKey = compactionFlightKey(deps.projectID, id);
    if (compactionInflight.has(flightKey)) return { reason: "duplicate" };
    compactionInflight.add(flightKey);
    try {
    const now = eventTimeOf(record, deps.now ?? Date.now());
    const { branch } = await readVcsSnapshot(deps.vcs, log);
    const reason =
      typeof data?.["reason"] === "string" && data["reason"].length > 0
        ? (data["reason"] as string)
        : "unknown";
    const text =
      typeof data?.["text"] === "string" ? (data["text"] as string) : "";
    const recent =
      typeof data?.["recent"] === "string" ? (data["recent"] as string) : "";
    const root = resolveSnapshotRoot(record, deps.memoryRoot);
    const body =
      text.trim().length > 0
        ? buildCompactionHandoff({
            sessionID,
            reason,
            branch,
            text,
            recent,
            now,
            fileLines: deps.fileLines,
          })
        : buildPointerHandoff({
            sessionID,
            reason,
            branch,
            now,
            fileLines: deps.fileLines,
          });
    // Exclusive, never-overwriting write: a same-name idle snapshot cannot
    // replace the produced summary (and replay stays able to restore it,
    // since `seen` is marked only after the write lands below).
    const file = await writeHandoffUnique(handoffName(sessionID, now), body, {
      memoryRoot: root,
      fileLines: deps.fileLines,
    });
    try {
      // Mark seen only after the handoff lands: a failed write must stay
      // replayable, otherwise the produced summary is lost for good.
      await markSeen(deps.storage, deps.projectID, id, deps.now);
    } catch (error) {
      return fail(error);
    }
    // Bound the seen set: fire-and-forget off the write mutex (prune takes
    // its own lock); never throws, logging is best-effort.
    void pruneSeenTo500(deps.storage, deps.projectID).catch((error) => {
      try {
        log(error);
      } catch {
        // Logging must never break capture.
      }
    });
    return { reason: "captured", file };
    } finally {
      compactionInflight.delete(flightKey);
    }
  } catch (error) {
    return fail(error);
  }
}

export interface EventDispatchDeps extends SnapshotDeps {
  /** Normalized plugin project directory (`canonical ?? directory`). */
  readonly directory: string;
}

/**
 * Route one subscribed event (spec §5.9): drop foreign locations before
 * any write, then `session.idle` → snapshot, `session.compaction.ended` →
 * produced-summary capture, other `session.compaction.*` → diagnostic log,
 * other sampled diagnostics → diagnostic log, everything else (foreign/TUI
 * noise) → silent drop. Each handler carries its own catch (M1); this
 * never throws.
 */
export async function dispatchEvent(
  event: unknown,
  deps: EventDispatchDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const report = (error: unknown): void => {
    try {
      log(error);
    } catch {
      // Logging must never break the loop.
    }
  };
  try {
    if (
      !isThisLocation(event, {
        directory: deps.directory,
        projectID: deps.projectID,
      })
    ) {
      return;
    }
    const type = asRecord(event)?.["type"];
    if (type === "session.idle") {
      await snapshotHandoffIfChanged(event, deps).catch(report);
    } else if (type === "session.compaction.ended") {
      await captureCompactionOutcome(event, deps).catch(report);
    } else if (
      typeof type === "string" &&
      type.startsWith("session.compaction.")
    ) {
      report(event);
    } else if (isKnownDiagnostic(event)) {
      report(event);
    }
  } catch (error) {
    report(error);
  }
}

export interface EventLoopOptions {
  readonly signal: AbortSignal;
  readonly handleEvent: (event: unknown) => Promise<void> | void;
  readonly log?: (error: unknown) => void;
}

/**
 * Consume `subscribe({ signal })` until the stream ends or aborts. Each
 * dispatch is individually caught (a throw on event N never stops N+1) and
 * the loop itself is caught, so the returned promise never rejects
 * unhandled. Abortion surfaces as the iterator ending/throwing, which is
 * logged and swallowed.
 */
export async function startEventLoop(
  subscribe: (options: {
    readonly signal: AbortSignal;
  }) => AsyncIterable<unknown>,
  options: EventLoopOptions,
): Promise<void> {
  const log = options.log ?? (() => undefined);
  const report = (error: unknown): void => {
    try {
      log(error);
    } catch {
      // Logging must never break unload.
    }
  };
  try {
    for await (const event of subscribe({ signal: options.signal })) {
      try {
        await options.handleEvent(event);
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
}

/* ------------------------------------------------------------------ */
/* snapshotIfDue — context-hook throttle gate (spec §§5.2, 5.9 D-A)   */
/* ------------------------------------------------------------------ */

export interface SnapshotIfDueOptions {
  readonly now?: number;
  readonly throttleMinutes?: number;
  readonly vcs?: VcsPort;
  readonly memoryRoot?: string;
  readonly fileLines?: number;
  readonly log?: (error: unknown) => void;
}

/**
 * Context-hook fallback snapshot writer (spec §5.9 D-A): throttle-gate
 * (`<projectID>/snapshotThrottle/<sessionID>`) around
 * `snapshotHandoffIfChanged` — at most once per `snapshotThrottleMinutes`
 * per session AND only when the content hash changed.
 *
 * The throttle slot is claimed atomically under the write mutex, so
 * concurrent `context` invocations (tool-driven continuations) share one
 * slot and never interleave `handoffs/` writes. Claiming the slot first
 * also makes this location-less synthesis a known session, so the
 * unknown-session drop never fires for it. Without a `vcs` the slot is
 * still recorded (stub-compatible) but nothing is written. When a `vcs` is
 * present the content hash is pre-checked before claiming (L-3), so an
 * unchanged poll does not burn the 10-min slot. Never throws.
 */
export async function snapshotIfDue(
  storage: LedgerStorage,
  projectID: string,
  sessionID: string,
  options?: SnapshotIfDueOptions,
): Promise<boolean> {
  try {
    if (typeof sessionID !== "string" || sessionID.length === 0) return false;
    const now = options?.now ?? Date.now();
    const minutes =
      options?.throttleMinutes ??
      DEFAULT_MEMORY_OPTIONS.snapshotThrottleMinutes;
    const windowMs =
      Number.isInteger(minutes) && minutes > 0 ? minutes * 60_000 : 0;
    // L-3: when a VCS is present, skip the throttle burn on a provably
    // unchanged poll. The hash covers branch + changes + pending; an equal
    // stored hash means snapshotHandoffIfChanged would be a no-op, so return
    // before claiming. Errors fall through to the claim path (which handles
    // them), preserving the known-session + stub-compatible behavior. The
    // cheap throttle read comes first so throttled polls skip the VCS read
    // entirely; the locked claim below re-checks for concurrent callers.
    if (options?.vcs !== undefined) {
      try {
        const last = await storage.get(throttleKey(projectID, sessionID));
        if (
          typeof last === "number" &&
          Number.isFinite(last) &&
          now - last < windowMs
        ) {
          return false;
        }
      } catch {
        // Fall through to the claim path below.
      }
      try {
        const { branch, changes } = await readVcsSnapshot(
          options.vcs,
          options.log,
        );
        let pending = 0;
        try {
          pending = await getPending(storage, projectID);
        } catch {
          pending = -1;
        }
        if (pending >= 0) {
          const hash = snapshotContentHash(branch, changes, pending);
          let stored: string | undefined;
          try {
            stored = await getSnapshotHash(storage, projectID, sessionID);
          } catch {
            stored = undefined;
          }
          if (stored !== undefined && stored === hash) return false;
        }
      } catch {
        // Fall through to the claim path below.
      }
    }
    const proceed = await withWriteLock(async () => {
      const last = await storage.get(throttleKey(projectID, sessionID));
      if (
        typeof last === "number" &&
        Number.isFinite(last) &&
        now - last < windowMs
      ) {
        return false;
      }
      await storage.set(throttleKey(projectID, sessionID), now);
      return true;
    });
    if (!proceed) return false;
    if (options?.vcs === undefined) return false;
    const outcome = await snapshotHandoffIfChanged(
      { type: "session.idle", data: { sessionID } },
      {
        vcs: options.vcs,
        storage,
        projectID,
        memoryRoot: options.memoryRoot,
        fileLines: options.fileLines,
        now,
        log: options.log,
      },
    );
    return outcome.reason === "written";
  } catch {
    return false;
  }
}
