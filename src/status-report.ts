/**
 * `/memory-status` + `memory_status` — read-only install/health doctor
 * (spec §5.13, Tier 1 E2).
 *
 * Answers the questions a new user otherwise assembles by hand: is the memory
 * directory scaffolded, is INDEX.md small enough to attach, is the AGENTS.md
 * protocol block installed, is the memory_write → ask rule declared, is the
 * optional memory-manager agent present, and has idle/compaction capture ever
 * fired. It reads only counters, line/entry counts, and install markers; it
 * never emits a memory body and never writes. No `status.*` counters exist —
 * the §5.12/ADR-0008 vocabulary is frozen.
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { listHandoffs } from "./brief.js";
import type { LedgerStorage } from "./capture.js";
import { parseMemoryOptions } from "./config.js";
import {
  collectHealth,
  readSince,
  readTotals,
  type MemoryHealth,
} from "./metrics.js";
import { hasMemoryProtocolBlock } from "./templates.js";
import { toolResult } from "./tools.js";

/** Fixed memory root, relative to the project (spec ADR-0006). */
const MEMORY_DIR = ".opencode/memory";

/** Message for the `/memory-status` synthetic-post fallback (§5.5 pattern). */
export const STATUS_FALLBACK_ASK =
  "The status report could not be delivered as a synthetic post. Call the memory_status tool and echo the report it returns verbatim — every check, count, and next action in place. Add no commentary.";

export const MEMORY_STATUS_COMMAND_NAME = "memory-status";
export const MEMORY_STATUS_COMMAND_DESCRIPTION =
  "Read-only memory plugin status: install checks, budgets, capture activity, and next actions";

export const MEMORY_STATUS_DESCRIPTION =
  "Read-only install/health report for the memory plugin: scaffold presence, INDEX attachability, AGENTS.md protocol block, memory_write ask rule, optional memory-manager agent, capture activity, and next actions. Use for onboarding, troubleshooting, or after changing memory config. Writes nothing.";

export const MEMORY_STATUS_INPUT = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/** Best-effort diagnostic log; logging must never break a hook or command. */
function logDiagnostic(error: unknown): void {
  try {
    console.warn("[memory] status diagnostic:", error);
  } catch {
    // Logging must never break plugin load or a hook.
  }
}

export type ProtocolStatus = "present" | "missing" | "no-file" | "unreadable";
export type AgentStatus = "present" | "absent" | "unknown";
export type PermissionStatus = "declared" | "not-found";

export interface StatusReportCaps {
  readonly indexLines: number;
  readonly fileLines: number;
  readonly injectBudgetLines: number;
}

export interface StatusReportDeps {
  /** Absolute path to `.opencode/memory`. */
  readonly memoryRoot: string;
  /** Absolute project root (AGENTS.md + config heuristics). */
  readonly projectRoot: string;
  readonly storage: LedgerStorage;
  readonly projectID: string;
  readonly caps: StatusReportCaps;
  /** `ctx.app.version`; undefined when the host did not expose it. */
  readonly version?: string;
  /** Resolved agent names/ids; undefined = lookup unavailable. */
  readonly agentNames?: readonly string[];
  /** Home directory for the global config scan (test seam). */
  readonly home?: string;
}

export interface StatusReport {
  readonly version?: string;
  readonly versionSupported?: boolean;
  readonly budgets: StatusReportCaps;
  readonly memoryDirExists: boolean;
  readonly indexExists: boolean;
  readonly health: MemoryHealth;
  readonly protocol: ProtocolStatus;
  readonly permission: PermissionStatus;
  readonly permissionEvidence: readonly string[];
  readonly agent: AgentStatus;
  readonly snapshotsWritten: number;
  readonly compactionCaptures: number;
  readonly snapshotFailed: number;
  readonly compactionFailed: number;
  readonly since?: string;
  readonly newestHandoff?: string;
  readonly actions: readonly string[];
}

type StatusReportBase = Omit<StatusReport, "actions">;

/** Collapse whitespace so one hostile string cannot add report lines. */
function oneLine(value: string, max = 200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function protocolStatusOf(projectRoot: string): Promise<ProtocolStatus> {
  try {
    const text = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    return hasMemoryProtocolBlock(text) ? "present" : "missing";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "no-file"
      : "unreadable";
  }
}

function configCandidates(projectRoot: string, home: string): string[] {
  return [
    join(projectRoot, "opencode.jsonc"),
    join(projectRoot, "opencode.json"),
    join(projectRoot, ".opencode", "opencode.jsonc"),
    join(projectRoot, ".opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
  ];
}

function displayPath(path: string, projectRoot: string, home: string): string {
  const rel = relative(projectRoot, path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return oneLine(rel);
  }
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  if (path === home || path.startsWith(homePrefix)) {
    return oneLine(`~${path.slice(home.length)}`);
  }
  return oneLine(path);
}

/** Strip JSONC line/block comments without touching quoted strings. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Remove trailing commas before `}`/`]` without touching quoted strings. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** Parse the common JSONC config shape; undefined means "advisory skip". */
function parseJsonc(text: string): unknown | undefined {
  try {
    const withoutBom = text.replace(/^\uFEFF/, "");
    return JSON.parse(stripTrailingCommas(stripJsonComments(withoutBom)));
  } catch {
    return undefined;
  }
}

/** True when one object directly declares the documented ask rule. */
function hasAskPermission(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAskPermission);
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (object.action === "memory_write" && object.effect === "ask") return true;
  return Object.values(object).some(hasAskPermission);
}

async function permissionRuleOf(
  projectRoot: string,
  home: string,
): Promise<{ status: PermissionStatus; evidence: string[] }> {
  const evidence: string[] = [];
  for (const path of configCandidates(projectRoot, home)) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseJsonc(text);
    if (parsed !== undefined && hasAskPermission(parsed)) {
      evidence.push(displayPath(path, projectRoot, home));
    }
  }
  return {
    status: evidence.length > 0 ? "declared" : "not-found",
    evidence,
  };
}

async function newestHandoffName(
  memoryRoot: string,
): Promise<string | undefined> {
  const listing = await listHandoffs(memoryRoot, "root", 1);
  return listing.names[0];
}

function deriveActions(report: StatusReportBase): string[] {
  const actions: string[] = [];
  if (report.versionSupported === false) {
    actions.push(
      `upgrade or pin OpenCode to the supported 2.0.x range (running ${report.version})`,
    );
  }
  if (!report.memoryDirExists) {
    actions.push("restart/reload the plugin to scaffold .opencode/memory");
  } else if (!report.indexExists) {
    actions.push(
      "restore .opencode/memory/INDEX.md (not attached while missing)",
    );
  }
  if (report.protocol === "no-file" || report.protocol === "missing") {
    actions.push("install the AGENTS.md protocol block (README install)");
  }
  if (report.protocol === "unreadable") {
    actions.push("check AGENTS.md readability (protocol block unverified)");
  }
  if (report.permission === "not-found") {
    actions.push(
      "declare the memory_write -> ask permission rule (README install; effective rules are unverifiable here)",
    );
  }
  for (const row of report.health.files) {
    if (row.cap === undefined || row.lines <= row.cap) continue;
    const suffix =
      row.file === "INDEX.md" ? " — not attached until within cap" : "";
    actions.push(`trim ${row.file} (${row.lines}/${row.cap} lines)${suffix}`);
  }
  if (report.health.pending >= 5) {
    actions.push(
      `run /memory-review (${report.health.pending} uncurated captures)`,
    );
  }
  if (report.snapshotsWritten + report.compactionCaptures === 0) {
    actions.push(
      "no idle/compaction captures observed yet — use the session normally, then re-check",
    );
  }
  if (report.agent === "absent") {
    actions.push(
      "optional: install agents/memory-manager.md for read-only review delegation",
    );
  }
  if (actions.length === 0) actions.push("(none — memory is healthy)");
  return actions;
}

/**
 * Collect the status report from fs/storage. Missing files/dirs resolve to
 * zero counts (a fresh install is not an error); storage/reader failures
 * propagate so the command/tool host can decide how to surface them.
 */
export async function collectStatus(
  deps: StatusReportDeps,
): Promise<StatusReport> {
  const home = deps.home ?? homedir();
  const [
    health,
    protocol,
    permission,
    since,
    totals,
    newestHandoff,
    exists,
    indexExists,
  ] = await Promise.all([
    collectHealth(deps.memoryRoot, deps.storage, deps.projectID, deps.caps),
    protocolStatusOf(deps.projectRoot),
    permissionRuleOf(deps.projectRoot, home),
    readSince(deps.storage, deps.projectID),
    readTotals(deps.storage, deps.projectID),
    newestHandoffName(deps.memoryRoot),
    pathExists(deps.memoryRoot),
    pathExists(join(deps.memoryRoot, "INDEX.md")),
  ]);

  const version =
    typeof deps.version === "string" && deps.version.length > 0
      ? oneLine(deps.version, 80)
      : undefined;
  const agent: AgentStatus =
    deps.agentNames === undefined
      ? "unknown"
      : deps.agentNames.some((name) => name === "memory-manager")
        ? "present"
        : "absent";

  const base: StatusReportBase = {
    version,
    versionSupported:
      version === undefined ? undefined : /^2\.0\./.test(version),
    budgets: deps.caps,
    memoryDirExists: exists,
    indexExists,
    health,
    protocol,
    permission: permission.status,
    permissionEvidence: permission.evidence,
    agent,
    snapshotsWritten: totals["snapshot.written"] ?? 0,
    compactionCaptures: totals["compactionCapture.captured"] ?? 0,
    snapshotFailed: totals["snapshot.failed"] ?? 0,
    compactionFailed: totals["compactionCapture.failed"] ?? 0,
    since,
    newestHandoff,
  };
  return { ...base, actions: deriveActions(base) };
}

function protocolLabel(status: ProtocolStatus): string {
  switch (status) {
    case "present":
      return "present";
    case "missing":
      return "missing (AGENTS.md has no protocol block)";
    case "no-file":
      return "no AGENTS.md found";
    case "unreadable":
      return "unreadable";
  }
}

function permissionLabel(report: StatusReport): string {
  return report.permission === "declared"
    ? `declared in ${report.permissionEvidence.join(", ")}`
    : "not found in readable configs (advisory)";
}

function agentLabel(status: AgentStatus): string {
  switch (status) {
    case "present":
      return "present";
    case "absent":
      return "absent (optional)";
    case "unknown":
      return "unknown (agent lookup unavailable)";
  }
}

function activityLabel(report: StatusReport): string {
  if (report.snapshotsWritten + report.compactionCaptures === 0) {
    return "none observed yet";
  }
  return `${report.snapshotsWritten} snapshot(s), ${report.compactionCaptures} compaction capture(s)`;
}

/** Pure deterministic markdown renderer (no fs, storage, or clock inside). */
export function renderStatusReport(report: StatusReport): string {
  const indexRow = report.health.files.find((row) => row.file === "INDEX.md");
  const indexLines = indexRow?.lines ?? 0;
  const indexCap = indexRow?.cap;
  const indexOver = indexRow?.cap !== undefined && indexRow.lines > indexRow.cap;
  const indexCount = report.indexExists
    ? `${indexLines}/${indexCap ?? "-"} lines — `
    : "";
  const indexState = !report.indexExists
    ? "missing — not attached"
    : indexOver
      ? "over cap, not attached"
      : "within cap (attached when budget allows)";

  const lines: string[] = [];
  lines.push("# [memory] status (local-only)");
  lines.push("Memory root: .opencode/memory");
  lines.push(
    `Budgets: INDEX ≤ ${report.budgets.indexLines} lines, files ≤ ${report.budgets.fileLines}, injected ≤ ${report.budgets.injectBudgetLines}`,
  );
  lines.push(
    `OpenCode: ${report.version ?? "unknown"}${
      report.versionSupported === false
        ? " (outside supported 2.0.x)"
        : report.versionSupported === true
          ? " (supported: 2.0.x)"
          : ""
    }`,
  );
  lines.push(`Since: ${report.since ?? "-"}`);
  lines.push(
    `Latest handoff: ${report.newestHandoff ? `handoffs/${report.newestHandoff}` : "-"}`,
  );
  lines.push("");
  lines.push("## Checks");
  lines.push("| check | result |");
  lines.push("| --- | --- |");
  lines.push(
    `| memory directory | ${report.memoryDirExists ? "present" : "missing — scaffolds on first run"} |`,
  );
  lines.push(`| INDEX.md | ${indexCount}${indexState} |`);
  lines.push(
    `| AGENTS.md protocol block | ${protocolLabel(report.protocol)} |`,
  );
  lines.push(`| memory_write -> ask rule | ${permissionLabel(report)} |`);
  lines.push(`| memory-manager agent | ${agentLabel(report.agent)} |`);
  lines.push(`| idle/compaction capture | ${activityLabel(report)} |`);
  lines.push("");
  lines.push("## Memory files");
  lines.push("| file | lines | cap | status |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of report.health.files) {
    const cap = row.cap === undefined ? "-" : String(row.cap);
    const status =
      row.file === "INDEX.md" && !report.indexExists
        ? "missing"
        : row.cap === undefined || row.lines <= row.cap
          ? "ok"
          : "over";
    lines.push(`| ${row.file} | ${row.lines} | ${cap} | ${status} |`);
  }
  lines.push("");
  lines.push("## Activity");
  lines.push("| item | count |");
  lines.push("| --- | --- |");
  lines.push(`| snapshots written | ${report.snapshotsWritten} |`);
  lines.push(`| compaction captures | ${report.compactionCaptures} |`);
  lines.push(`| snapshot failures | ${report.snapshotFailed} |`);
  lines.push(`| compaction failures | ${report.compactionFailed} |`);
  lines.push(`| handoffs | ${report.health.handoffs} |`);
  lines.push(`| archive | ${report.health.archive} |`);
  lines.push(`| pending captures | ${report.health.pending} |`);
  lines.push(`| seen entries | ${report.health.seen} |`);
  lines.push("");
  lines.push("## Next actions");
  for (const action of report.actions) lines.push(`- ${action}`);
  return lines.join("\n");
}

function projectRootOf(ctx: Plugin.Context): string {
  return (ctx.location.project?.canonical ?? ctx.location.directory).replace(
    /\/+$/,
    "",
  );
}

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

async function agentNamesOf(
  ctx: Plugin.Context,
): Promise<readonly string[] | undefined> {
  try {
    const list = await ctx.agent.list();
    return list.data
      .map((agent) => agent.name ?? agent.id)
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );
  } catch {
    return undefined;
  }
}

/** Resolve live deps for one call (spec P22), then collect the report. */
export async function buildStatusReport(
  ctx: Plugin.Context,
): Promise<StatusReport> {
  const options = parseMemoryOptions(ctx.options);
  const projectRoot = projectRootOf(ctx);
  return collectStatus({
    memoryRoot: join(projectRoot, MEMORY_DIR),
    projectRoot,
    storage: ledgerOf(ctx),
    projectID: ctx.location.project?.id ?? ctx.location.directory,
    caps: {
      indexLines: options.indexLines,
      fileLines: options.fileLines,
      injectBudgetLines: options.injectBudgetLines,
    },
    version: typeof ctx.app?.version === "string" ? ctx.app.version : undefined,
    agentNames: await agentNamesOf(ctx),
  });
}

/**
 * `/memory-status`: render, then post through `ctx.session.synthetic`; on a
 * rejection degrade to the §5.5 prompt pattern asking the agent to call
 * `memory_status`. Never throws and never bumps a counter.
 */
export function registerStatusCommand(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: MEMORY_STATUS_COMMAND_NAME,
      description: MEMORY_STATUS_COMMAND_DESCRIPTION,
      execute: async ({ sessionID, prompt, delivery }) => {
        try {
          const text = renderStatusReport(await buildStatusReport(ctx));
          try {
            await ctx.session.synthetic({ sessionID, text });
          } catch {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              delivery,
              text: STATUS_FALLBACK_ASK,
            });
          }
        } catch (error) {
          logDiagnostic(error);
        }
      },
    });
  });
}

/** `memory_status`: the same read-only report through the tool envelope. */
export function registerStatusTool(
  ctx: Plugin.Context,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_status",
      description: MEMORY_STATUS_DESCRIPTION,
      input: MEMORY_STATUS_INPUT,
      execute: async () =>
        toolResult(renderStatusReport(await buildStatusReport(ctx))),
    });
  });
}
