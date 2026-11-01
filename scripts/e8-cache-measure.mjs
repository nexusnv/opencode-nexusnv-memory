/**
 * E8 cache-placement measurement harness (dev-only).
 *
 * This script is NOT a package entrypoint: `package.json` `files` excludes
 * `scripts/`, and nothing in `src/` imports it. It exists to reproduce the
 * issue #22 measurement from a clean checkout with no runtime dependency.
 *
 * What it measures:
 * - `prompt1Later.cacheHitRate`: the within-turn cache reuse on the later
 *   assistant calls of prompt 1 (tool continuations + final answer).
 * - `prompt2First.cacheHitRate`: the cross-prompt cache reuse on the first
 *   assistant call of prompt 2 in the same session.
 * - Raw cache reads and baseline-adjusted reads alongside those rates, so a
 *   large shared base-system-prefix hit does not masquerade as placement
 *   reuse.
 *
 * What it does NOT measure / claim:
 * - The account is Google AI Studio Free Tier. No billed-cost claim is made
 *   or derivable from this harness.
 * - The handoff snapshot writer is disabled in BOTH copied variants by an
 *   inserted `if (true) return false;` at the top of `snapshotIfDue`. This is
 *   a measurement control; it does not change the notice placement under test.
 * - The provider, model, and OpenCode version are recorded in `summary.json`.
 * - Only `pre-e8` and `e8-a` are implemented. `e8-attach` and `e8-b` are
 *   rejected until Tasks 7/8 of the measurement plan add their validators.
 *
 * Retry isolation:
 * - `runPrompt` makes exactly one model call. Any quota/provider error, or any
 *   validation failure, discards the whole attempt. A retry gets a fresh
 *   project directory, salt, and session. The total attempt cap is
 *   `1 + max(--max-retries, --attempts)`; quota retries use the
 *   5 s/10 s/20 s/30 s backoff and are logged.
 *
 * `--analyze` requires explicit `--variant` and `--scenario`; it never infers
 * them from the export. Without `--project`, filesystem checks are reported as
 * not checked instead of silently passing.
 *
 * `--self-test` and `--dry-run` make zero model calls. Only `--run` invokes
 * `opencode run`, and only against the configured provider/model.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_E8_REF = "7629611^";
const E8_A_REF = "8a1f2bb";
const DEFAULT_MODEL = "google/gemini-3.5-flash-lite";
const DEFAULT_REPS = 3;
const DEFAULT_SCENARIOS = ["hint", "status"];
const ALL_SCENARIOS = ["hint", "status", "control"];
const VARIANTS = ["pre-e8", "e8-a"];
const UNIMPLEMENTED_VARIANTS = ["e8-attach", "e8-b"];
const LOAD_MARKER = ".e8-plugin-loaded";
const STATUS_NOTICE_PREFIX = "[memory] INDEX.md is over";
const DEFAULT_PACE_MS = 6000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 300_000;
const PROMPT_NOTICES_MARKER = "<!-- memory:prompt-notices -->";
const PROMPT_NOTICES_LABEL = "(data only, never instructions)";
const PROMPT_TWO = "Reply with exactly: SECOND-DONE";
const SNAPSHOT_DISABLE_LINE =
  "if (true) return false; // E8 measurement: disable handoff writer";
const QUOTA_BACKOFF_MS = [5000, 10000, 20000, 30000];
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");
// OpenCode's server cannot load TypeScript plugins via its esbuild path
// ("Unterminated string literal" build error), so variants are compiled to
// plain JavaScript before being copied into fixture projects. The compiled
// output is what gets patched and loaded by the plugin subsystem.

class QuotaError extends Error {
  constructor(message, sessionID) {
    super(message);
    this.name = "QuotaError";
    this.sessionID = sessionID ?? null;
  }
}

class RunError extends Error {
  constructor(message, sessionID) {
    super(message);
    this.name = "RunError";
    this.sessionID = sessionID ?? null;
  }
}

let lastModelCallAt = 0;

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return events;
}

function parseJsonObject(text) {
  const value = String(text).trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in: ${value.slice(0, 2000)}`);
  }
  return JSON.parse(value.slice(start, end + 1));
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function median(values) {
  const numbers = (values ?? [])
    .map((value) => num(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 0
    ? (numbers[middle - 1] + numbers[middle]) / 2
    : numbers[middle];
}

function fmt(value, digits = 3) {
  if (value === null || value === undefined) return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return number.toFixed(digits);
}

function isQuotaError(text) {
  return /quota|rate.?limit|429|free-limit|RESOURCE_EXHAUSTED/i.test(
    String(text),
  );
}

function isDirtySrc(statusText) {
  return String(statusText).trim().length > 0;
}

function isSessionID(value) {
  return typeof value === "string" && value.startsWith("ses_");
}

// OpenCode wraps user message text in surrounding double quotes in the
// session export. Strip them so the prompt text can be compared against the
// expected fixture prompt.
function stripSurroundingQuotes(text) {
  let value = String(text ?? "");
  if (value.startsWith('"')) value = value.slice(1);
  if (value.endsWith('"')) value = value.slice(0, -1);
  return value;
}

function splitModel(model) {
  const value = String(model ?? "");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const rest = value.slice(slash + 1);
  const hash = rest.indexOf("#");
  const id = hash === -1 ? rest : rest.slice(0, hash);
  if (id.length === 0) return null;
  return {
    providerID: value.slice(0, slash),
    id,
    variant: hash === -1 ? null : rest.slice(hash + 1) || null,
  };
}

function isPathUnder(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, target);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function tableCell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function pairThreshold(count) {
  return count > 0 ? Math.ceil((2 * count) / 3) : 0;
}

function check(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function validationState(errors, notChecked) {
  if ((errors?.length ?? 0) > 0) return "invalid";
  if ((notChecked?.length ?? 0) > 0) return "not-checked";
  return "valid";
}

function isValidRun(run) {
  if (!run) return false;
  if (run.validationStatus) return run.validationStatus === "valid";
  return (
    (run.validationErrors?.length ?? 0) === 0 &&
    (run.validationNotChecked?.length ?? 0) === 0
  );
}

function git(args) {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function assertCleanSrc() {
  const status = git(["status", "--porcelain", "--", "src"]);
  if (isDirtySrc(status)) {
    throw new Error("src/ is dirty; commit or stash before measuring");
  }
}

function runCli(args, options) {
  if (!options?.out) {
    throw new Error(
      "runCli requires options.out for the isolated config roots",
    );
  }
  // Direct spawnSync("opencode", ...) does not trigger OpenCode's project-local
  // plugin loading (the memory plugin's hooks never fire). Executing opencode
  // through a bash script file does, so write a small wrapper and run it via
  // bash. This ensures the memory plugin loads and its hooks execute.
  const scriptPath = join(options.out, ".e8-run-opencode.sh");
  const script =
    "#!/bin/bash\n" +
    `cd "${options.cwd.replace(/"/g, '\\"')}"\n` +
    "exec opencode " +
    args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ") +
    "\n";
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function pace(ms) {
  const wait = Math.max(0, ms - (Date.now() - lastModelCallAt));
  if (wait > 0)
    await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  lastModelCallAt = Date.now();
}

function sessionIDFromEvents(events) {
  for (const event of events) {
    if (typeof event?.sessionID === "string" && event.sessionID.length > 0) {
      return event.sessionID;
    }
    if (typeof event?.sessionId === "string" && event.sessionId.length > 0) {
      return event.sessionId;
    }
    if (typeof event?.session?.id === "string" && event.session.id.length > 0) {
      return event.session.id;
    }
  }
  return undefined;
}

function exportSession(
  projectDir,
  sessionID,
  out,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const result = runCli(["session", "export", sessionID], {
    cwd: projectDir,
    out,
    timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(
      `opencode session export failed (${result.status}): ${String(result.stderr).slice(-2000)}`,
    );
  }
  try {
    return parseJsonObject(result.stdout);
  } catch (error) {
    throw new Error(
      `opencode session export JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function deleteSession(sessionID, out, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!isSessionID(sessionID)) return;
  try {
    runCli(["session", "delete", sessionID], {
      cwd: REPO_ROOT,
      out,
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
  } catch {
    // Best-effort cleanup only.
  }
}

function opencodeVersion(out) {
  try {
    const result = runCli(["--version"], {
      cwd: REPO_ROOT,
      out,
      timeoutMs: 30_000,
    });
    const text = `${result.stdout}${result.stderr}`.trim();
    return text.length > 0 ? text.split("\n")[0].trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function makeSalt(seed) {
  return createHash("sha256")
    .update(`${seed}:${Date.now()}:${process.pid}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
}

function providerFromModel(model) {
  return splitModel(model)?.providerID ?? null;
}

async function ensureIsolatedRoots(out) {
  await mkdir(join(out, "config", "opencode"), { recursive: true });
  await mkdir(join(out, "xdg", "opencode"), { recursive: true });
}

async function patchSnapshotDisabled(file) {
  const text = await readFile(file, "utf8");
  const anchor =
    "export async function snapshotIfDue(storage, projectID, sessionID, options) {\n    try {";
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `snapshotIfDue anchor found ${occurrences} times in ${file}; expected 1`,
    );
  }
  const replacement =
    "export async function snapshotIfDue(storage, projectID, sessionID, options) {\n" +
    "    " +
    SNAPSHOT_DISABLE_LINE +
    "\n" +
    "    try {";
  const patched = text.replace(anchor, replacement);
  const markerOccurrences = patched.split(SNAPSHOT_DISABLE_LINE).length - 1;
  if (markerOccurrences !== 1) {
    throw new Error(
      `snapshot disable patch count ${markerOccurrences} in ${file}; expected 1`,
    );
  }
  await writeFile(file, patched);
}

async function patchLoadMarker(file) {
  const text = await readFile(file, "utf8");
  const anchor = 'await ctx.session.hook("prompt", async (event) => {';
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `prompt hook anchor found ${occurrences} times in ${file}; expected 1`,
    );
  }
  const markerLine =
    `\n        await mkdir(join(projectRootOf(ctx), ${JSON.stringify(LOAD_MARKER)}), ` +
    `{ recursive: true }).catch(() => {});`;
  const patched = text.replace(anchor, `${anchor}${markerLine}`);
  const marker = `join(projectRootOf(ctx), ${JSON.stringify(LOAD_MARKER)})`;
  const markerOccurrences = patched.split(marker).length - 1;
  if (markerOccurrences !== 1) {
    throw new Error(
      `load marker patch count ${markerOccurrences} in ${file}; expected 1`,
    );
  }
  await writeFile(file, patched);
}

async function sourceFor(variant, dest) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  if (variant === "pre-e8" || variant === "e8-a") {
    const ref = variant === "pre-e8" ? PRE_E8_REF : E8_A_REF;
    const archive = execFileSync(
      "git",
      ["-C", REPO_ROOT, "archive", "--format=tar", ref, "src"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const extracted = spawnSync(
      "tar",
      ["-x", "--strip-components=1", "-C", dest],
      {
        input: archive,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0) {
      throw new Error(
        `tar extraction failed (${extracted.status}): ${String(extracted.stderr ?? "")}`,
      );
    }
  } else {
    throw new Error(`variant ${variant} is not implemented until Task 7/8`);
  }

  if (!existsSync(join(dest, "index.ts"))) {
    throw new Error(`variant ${variant} produced no index.ts in ${dest}`);
  }
  // Compile TypeScript plugin sources to plain JavaScript. OpenCode's server
  // cannot load TypeScript plugins via its esbuild path ("Unterminated string
  // literal" build error), but loads compiled .js plugins correctly.
  const jsDir = join(dest, "js");
  await mkdir(jsDir, { recursive: true });
  const tscResult = spawnSync(
    process.execPath,
    [
      TSC,
      "--outDir",
      jsDir,
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--moduleResolution",
      "node",
      "--esModuleInterop",
      "true",
      "--skipLibCheck",
      "true",
      "--declaration",
      "false",
      "--sourceMap",
      "false",
      join(dest, "index.ts"),
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (tscResult.error) throw tscResult.error;
  const jsFiles = (await readdir(jsDir)).filter((name) => name.endsWith(".js"));
  if (jsFiles.length === 0) {
    throw new Error(
      `TypeScript compilation produced no .js output for variant ${variant}`,
    );
  }
  // Patch the compiled JavaScript (not the TypeScript sources).
  await patchSnapshotDisabled(join(jsDir, "capture.js"));
  await patchLoadMarker(join(jsDir, "index.js"));
  return jsDir;
}

function indexFixture(scenario) {
  if (scenario === "hint") {
    return [
      "# Memory index",
      "- auth-service: src/auth.ts",
      "- login flow: src/login.ts",
      "",
    ].join("\n");
  }
  if (scenario === "status") {
    const entries = Array.from({ length: 30 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return `- entry-${number}: src/file-${number}.ts`;
    });
    return ["# Memory index", ...entries, ""].join("\n");
  }
  return [
    "# Memory index",
    "- login flow: src/login.ts",
    "- logout flow: src/logout.ts",
    "",
  ].join("\n");
}

function promptOne(scenario, projectDir) {
  const prefix =
    scenario === "hint" ? "Context: auth-service login. " : "Context: ";
  return (
    `${prefix}Use the read tool to read ${join(projectDir, "alpha.txt")}, ` +
    `then use the read tool to read ${join(projectDir, "beta.txt")}. ` +
    "Then answer in one sentence."
  );
}

function parsePromptCore(text, scenario) {
  const value = String(text ?? "");
  const prefix =
    scenario === "hint" ? "Context: auth-service login. " : "Context: ";
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  const match =
    /^Use the read tool to read (.+?)\/alpha\.txt, then use the read tool to read (.+?)\/beta\.txt\. Then answer in one sentence\./.exec(
      rest,
    );
  if (!match || match[1] !== match[2]) return null;
  return {
    projectDir: match[1],
    core: `${prefix}${match[0]}`,
    suffix: rest.slice(match[0].length),
  };
}

function hasNumericTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return false;
  for (const key of ["input", "output"]) {
    if (typeof tokens[key] !== "number" || !Number.isFinite(tokens[key])) {
      return false;
    }
    if (tokens[key] < 0) return false;
  }
  if (!tokens.cache || typeof tokens.cache !== "object") return false;
  for (const key of ["read", "write"]) {
    if (
      typeof tokens.cache[key] !== "number" ||
      !Number.isFinite(tokens.cache[key])
    ) {
      return false;
    }
    if (tokens.cache[key] < 0) return false;
  }
  return true;
}

function fileURIs(message) {
  const files = Array.isArray(message?.files) ? message.files : [];
  const uris = [];
  for (const file of files) {
    if (typeof file === "string") {
      uris.push(file);
      continue;
    }
    // `opencode session export` stores attachments as
    // `{ source: { type: "uri", uri } }`; the plugin prompt event uses
    // `{ uri }`. Accept both so the check is against the export shape.
    const uri = file?.source?.uri ?? file?.uri;
    if (typeof uri === "string" && uri.length > 0) uris.push(uri);
  }
  return uris;
}

async function briefFilesFor(projectDir) {
  const memoryDir = join(projectDir, ".opencode", "memory");
  return [
    join(memoryDir, "activeContext.md"),
    join(memoryDir, "INDEX.md"),
    ...(await readdir(join(memoryDir, "handoffs")))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(memoryDir, "handoffs", name)),
  ];
}

async function readBriefTextsFor(projectDir) {
  const files = await briefFilesFor(projectDir);
  return Promise.all(
    files.map(async (file) => (await readFile(file)).toString("utf8")),
  );
}

function hashTexts(texts) {
  return createHash("sha256").update(texts.join("\n")).digest("hex");
}

async function briefSnapshot(projectDir) {
  const texts = await readBriefTextsFor(projectDir);
  return {
    hash: hashTexts(texts),
    lineCount: texts.join("\n").split("\n").length,
  };
}

async function prepareProject(projectDir, variantDir, scenario, salt) {
  const out = dirname(dirname(projectDir));
  await ensureIsolatedRoots(out);
  await rm(projectDir, { recursive: true, force: true });

  const pluginDir = join(projectDir, ".opencode", "plugins", "memory");
  const memoryDir = join(projectDir, ".opencode", "memory");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(memoryDir, "handoffs"), { recursive: true });

  const pluginFiles = (await readdir(variantDir))
    .filter((name) => name.endsWith(".js"))
    .sort();
  for (const name of pluginFiles) {
    await cp(join(variantDir, name), join(pluginDir, name));
  }
  if (!existsSync(join(pluginDir, "index.js"))) {
    throw new Error(`variant ${variantDir} has no index.js`);
  }

  const config = {
    plugins: ["./plugins/memory"],
    permissions: [
      { action: "memory_write", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "websearch", resource: "*", effect: "deny" },
    ],
    policies: [
      { action: "integration.use", resource: "skill:*", effect: "deny" },
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
    ],
  };
  await writeFile(
    join(projectDir, ".opencode", "opencode.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  await writeFile(
    join(projectDir, "AGENTS.md"),
    `# E8 measurement fixture ${salt}\n\nSynthetic project for cache-placement measurement. Do not edit files.\n`,
  );
  await writeFile(
    join(memoryDir, "activeContext.md"),
    `# Active context\n\n- run salt: ${salt}\n- synthetic measurement project\n`,
  );
  await writeFile(join(memoryDir, "INDEX.md"), indexFixture(scenario));
  if (scenario !== "control") {
    await writeFile(
      join(memoryDir, "handoffs", "2026-10-26-120000-abcdef.md"),
      "# Handoff\n\n- branch: e8-measurement\n",
    );
  }
  await writeFile(
    join(memoryDir, "decisions.md"),
    "# Decisions\n\n- fixture: no decisions recorded\n",
  );
  await writeFile(
    join(memoryDir, "architecture.md"),
    "# Architecture\n\n- fixture: single module\n",
  );
  await writeFile(
    join(memoryDir, "style.md"),
    "# Style\n\n- fixture: no style rules\n",
  );
  await writeFile(
    join(memoryDir, "issues.md"),
    "# Issues\n\n- fixture: no open issues\n",
  );
  await writeFile(join(projectDir, "alpha.txt"), `alpha fixture ${salt}\n`);
  await writeFile(join(projectDir, "beta.txt"), `beta fixture ${salt}\n`);
}

async function runPrompt(projectDir, prompt, sessionID, model, opts) {
  await pace(opts.paceMs);
  const args = [
    "run",
    "--standalone",
    "-m",
    model,
    "--format",
    "json",
    "--auto",
  ];
  if (sessionID) args.push("--session", sessionID);
  args.push(prompt);

  const result = runCli(args, {
    cwd: projectDir,
    out: opts.out,
    timeoutMs: opts.timeoutMs,
  });
  const events = parseJsonLines(result.stdout);
  const error = events.find((event) => event?.type === "error");
  const session = sessionID ?? sessionIDFromEvents(events);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (error) {
    const message =
      error.error?.message ?? error.message ?? "opencode run error event";
    throw isQuotaError(combined)
      ? new QuotaError(message, session)
      : new RunError(message, session);
  }
  if (result.status !== 0) {
    throw new RunError(
      `opencode run failed (${result.status}): ${String(result.stderr).slice(-2000)}\n${String(result.stdout).slice(-4000)}`,
      session,
    );
  }
  if (!session) {
    throw new RunError("opencode run produced no sessionID", null);
  }
  return { sessionID: session, stdout: result.stdout, stderr: result.stderr };
}

async function runOne({ scenario, rep, variant, variantDir, model, opts }) {
  const out = resolve(opts.out);
  const maxAttempts = 1 + Math.max(opts.maxRetries, opts.attempts);
  const attempts = [];
  let quotaRetries = 0;
  let otherRetries = 0;
  let validRun = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const projectDir = join(
      out,
      "projects",
      `${scenario}-${variant}-r${rep}-a${attempt}`,
    );
    const salt = makeSalt(
      `${scenario}:${variant}:${rep}:${attempt}:${projectDir}`,
    );
    let sessionID = null;
    let attemptRecord = null;
    let retryKind = null;
    let run = null;

    try {
      await prepareProject(projectDir, variantDir, scenario, salt);
      const before = await briefSnapshot(projectDir);
      const first = await runPrompt(
        projectDir,
        promptOne(scenario, projectDir),
        undefined,
        model,
        opts,
      );
      sessionID = first.sessionID;
      await runPrompt(projectDir, PROMPT_TWO, sessionID, model, opts);
      const exportData = exportSession(
        projectDir,
        sessionID,
        out,
        opts.timeoutMs,
      );
      const after = await briefSnapshot(projectDir);
      const rawPath = join(out, "raw", `${scenario}-${variant}-r${rep}.json`);
      run = analyzeExport(exportData, {
        scenario,
        rep,
        variant,
        attempt,
        sessionID,
        projectDir,
        salt,
        model,
        requestedModel: model,
        briefHashBefore: before.hash,
        briefHashAfter: after.hash,
        briefLineCount: before.lineCount,
        rawPath,
      });
      const validation = validateRun(
        run,
        exportData,
        projectDir,
        variant,
        scenario,
      );
      run.validationErrors = validation.errors;
      run.validationNotChecked = validation.notChecked;
      run.validationStatus = validationState(
        validation.errors,
        validation.notChecked,
      );
      run.validationComplete = run.validationStatus === "valid";
      const savePath = run.validationComplete
        ? rawPath
        : join(
            out,
            "raw",
            `invalid-${scenario}-${variant}-r${rep}-a${attempt}.json`,
          );
      run.rawPath = savePath;
      await writeFile(savePath, `${JSON.stringify(exportData, null, 2)}\n`);

      if (run.validationComplete) {
        attempts.push({
          scenario,
          rep,
          variant,
          attempt,
          projectDir,
          sessionID,
          status: "valid",
          errors: [],
          rawPath: savePath,
        });
        if (!opts.keepProjects) {
          await rm(projectDir, { recursive: true, force: true }).catch(
            (error) => {
              console.warn(
                `[cleanup] could not remove ${projectDir}: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          );
        }
        // Break, not return: the run is only promoted after cleanup so a
        // cleanup failure cannot cause a duplicate measurement.
        validRun = run;
        break;
      }

      attemptRecord = {
        scenario,
        rep,
        variant,
        attempt,
        projectDir,
        sessionID,
        status: "invalid",
        errors: [
          ...validation.errors,
          ...validation.notChecked.map((item) => `not checked: ${item}`),
        ],
        rawPath: savePath,
      };
      retryKind = "validation";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorSession =
        error instanceof QuotaError || error instanceof RunError
          ? error.sessionID
          : null;
      const attemptSession = errorSession ?? sessionID;
      attemptRecord = {
        scenario,
        rep,
        variant,
        attempt,
        projectDir,
        sessionID: attemptSession,
        status: "error",
        errors: [message],
      };
      retryKind = error instanceof QuotaError ? "quota" : "other";
    }

    attempts.push(attemptRecord);
    if (attemptRecord.sessionID) {
      deleteSession(attemptRecord.sessionID, out, opts.timeoutMs);
    }
    if (!opts.keepProjects) {
      await rm(projectDir, { recursive: true, force: true }).catch((error) => {
        console.warn(
          `[cleanup] could not remove ${projectDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    if (attemptRecord.status === "invalid") {
      console.warn(
        `[invalid] ${scenario}/${variant} rep ${rep} attempt ${attempt}: ${attemptRecord.errors.join("; ")}`,
      );
    } else {
      console.warn(
        `[failed] ${scenario}/${variant} rep ${rep} attempt ${attempt}: ${attemptRecord.errors.join("; ")}`,
      );
    }

    if (attempt >= maxAttempts) break;
    if (retryKind === "quota") {
      if (quotaRetries >= opts.maxRetries) break;
      quotaRetries += 1;
      const wait = QUOTA_BACKOFF_MS[quotaRetries - 1] ?? 30000;
      console.warn(
        `[pace] quota error; retrying in ${wait} ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
    } else {
      if (otherRetries >= opts.attempts) break;
      otherRetries += 1;
    }
  }

  return {
    run: validRun,
    attempts,
    failure: validRun ? null : (attempts[attempts.length - 1] ?? null),
  };
}

async function runMeasurement(opts) {
  assertCleanSrc();

  const out = resolve(opts.out);
  await ensureIsolatedRoots(out);
  await mkdir(join(out, "raw"), { recursive: true });
  await mkdir(join(out, "projects"), { recursive: true });

  const now = new Date().toISOString();
  const provider = providerFromModel(opts.model);
  const meta = {
    generatedAt: now,
    date: now,
    provider,
    model: opts.model,
    accountTier:
      provider === "google" ? "Google AI Studio Free Tier" : "unknown",
    opencodeVersion: opencodeVersion(out),
    repoHead: git(["rev-parse", "HEAD"]),
    preE8Ref: PRE_E8_REF,
    preE8Commit: git(["rev-parse", PRE_E8_REF]),
    e8ARef: E8_A_REF,
    e8ACommit: git(["rev-parse", E8_A_REF]),
    variants: [...opts.variants],
    scenarios: [...opts.scenarios],
    reps: opts.reps,
    paceMs: opts.paceMs,
    maxRetries: opts.maxRetries,
    attempts: opts.attempts,
    comparisons: opts.comparisons.map(
      (comparison) => `${comparison.baseline}:${comparison.candidate}`,
    ),
  };

  const variantDirs = new Map();
  for (const variant of opts.variants) {
    const dest = join(out, "variants", variant);
    const jsDir = await sourceFor(variant, dest);
    variantDirs.set(variant, jsDir);
  }

  const runs = [];
  const failures = [];
  const attempts = [];

  for (let rep = 1; rep <= opts.reps; rep += 1) {
    for (const scenario of opts.scenarios) {
      for (const variant of opts.variants) {
        const result = await runOne({
          scenario,
          rep,
          variant,
          variantDir: variantDirs.get(variant),
          model: opts.model,
          opts,
        });
        attempts.push(...result.attempts);
        if (result.run) {
          runs.push(result.run);
        } else if (result.failure) {
          const last = result.failure;
          failures.push({
            scenario,
            rep,
            variant,
            attempt: last.attempt ?? null,
            error: (last.errors ?? []).join("; "),
            validationErrors: last.errors ?? [],
            sessionID: last.sessionID ?? null,
            projectDir: last.projectDir ?? null,
            rawPath: last.rawPath ?? null,
            attempts: result.attempts,
          });
        }
      }
    }
  }

  const report = buildReport({
    runs,
    failures,
    attempts,
    comparisons: opts.comparisons,
    meta,
    scenarios: opts.scenarios,
  });
  const summaryPath = join(out, "summary.json");
  const reportPath = join(out, "summary.md");
  await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, renderReport(report));

  console.log(
    `measurement complete: ${runs.length} valid runs, ${failures.length} exhausted scenarios, ${attempts.length} attempts, ${report.pairs.length} pairs`,
  );
  console.log(`summary: ${summaryPath}`);
  console.log(`report: ${reportPath}`);

  if (report.comparisonErrors.length > 0) {
    for (const error of report.comparisonErrors) {
      console.error(`comparison error: ${error}`);
    }
    process.exitCode = 1;
  }
}

function noticeInfo(text) {
  const value = String(text ?? "");
  const lines = value.split("\n");
  const noticeLines = lines.filter(
    (line) => line.startsWith("[memory]") || line.startsWith("[memory-hint]"),
  );
  const handoffLines = lines.filter((line) =>
    line.startsWith("[memory] handoff:"),
  );
  const hintLines = lines.filter((line) => line.startsWith("[memory-hint]"));
  const statusLines = lines.filter((line) =>
    line.startsWith(STATUS_NOTICE_PREFIX),
  );
  return {
    marker: value.includes(PROMPT_NOTICES_MARKER),
    label: value.includes(PROMPT_NOTICES_LABEL),
    hint: hintLines.length > 0,
    status: statusLines.length > 0,
    handoff: handoffLines.length > 0,
    hintCount: hintLines.length,
    statusCount: statusLines.length,
    handoffCount: handoffLines.length,
    markerCount: value.split(PROMPT_NOTICES_MARKER).length - 1,
    lineCount: noticeLines.length,
  };
}

function tokensOf(message) {
  const tokens = message?.tokens;
  if (!hasNumericTokens(tokens)) return null;
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(tokens.cache.read),
    cacheWrite: num(tokens.cache.write),
  };
}

function toolPartsOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const part of content) {
    if (part?.type !== "tool") continue;
    const input = part?.state?.input ?? part?.input ?? {};
    const path = input?.path ?? input?.filePath ?? input?.file ?? null;
    parts.push({
      name:
        typeof part.name === "string"
          ? part.name
          : typeof part.tool === "string"
            ? part.tool
            : "",
      status: part?.state?.status ?? part?.status ?? null,
      input: input ?? null,
      path: typeof path === "string" ? path : null,
    });
  }
  return parts;
}

function callsFromMessages(messages, prompt) {
  const calls = [];
  for (const message of messages) {
    const tokenInfo = tokensOf(message);
    if (!tokenInfo) continue;
    const promptTokens =
      tokenInfo.input + tokenInfo.cacheRead + tokenInfo.cacheWrite;
    const toolParts = toolPartsOf(message);
    calls.push({
      index: -1,
      prompt,
      messageID: message?.id ?? null,
      model: message?.model ?? null,
      providerID: message?.model?.providerID ?? null,
      modelID: message?.model?.id ?? null,
      variant: message?.model?.variant ?? null,
      tokens: message?.tokens ?? null,
      ...tokenInfo,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? tokenInfo.cacheRead / promptTokens : 0,
      uncachedTokens: tokenInfo.input + tokenInfo.cacheWrite,
      toolParts,
      toolNames: toolParts.map((part) => part.name),
    });
  }
  return calls;
}

function summarizeCall(call) {
  return {
    index: call.index,
    messageID: call.messageID,
    model: call.model ?? null,
    providerID: call.providerID ?? null,
    modelID: call.modelID ?? null,
    variant: call.variant ?? null,
    tokens: call.tokens ?? null,
    input: call.input,
    output: call.output,
    reasoning: call.reasoning,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    promptTokens: call.promptTokens,
    cacheHitRate: call.cacheHitRate,
    uncachedTokens: call.uncachedTokens,
    toolNames: [...call.toolNames],
    toolParts: call.toolParts.map((part) => ({ ...part })),
  };
}

function sum(items, key) {
  return items.reduce((total, item) => total + num(item?.[key]), 0);
}

function totalOf(calls) {
  const promptTokens = sum(calls, "promptTokens");
  const cacheRead = sum(calls, "cacheRead");
  return {
    computed: true,
    calls: calls.length,
    input: sum(calls, "input"),
    output: sum(calls, "output"),
    reasoning: sum(calls, "reasoning"),
    cacheRead,
    cacheWrite: sum(calls, "cacheWrite"),
    promptTokens,
    uncachedTokens: sum(calls, "uncachedTokens"),
    cacheHitRate: promptTokens > 0 ? cacheRead / promptTokens : 0,
  };
}

function analyzeExport(data, meta = {}) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const buckets = [[], [], []];
  const userMessages = [];

  for (const message of messages) {
    if (message?.type === "user") {
      userMessages.push(message);
      continue;
    }
    if (message?.type === "assistant" && userMessages.length >= 1) {
      const bucket = buckets[Math.min(userMessages.length, 3) - 1];
      if (bucket) bucket.push(message);
    }
  }

  const [prompt1Messages, prompt2Messages, extraMessages] = buckets;
  const allAssistantMessages = messages.filter(
    (message) => message?.type === "assistant",
  );
  const tokenlessAssistantMessages = allAssistantMessages.filter(
    (message) => !hasNumericTokens(message?.tokens),
  );
  const assistantErrorMessages = allAssistantMessages.filter(
    (message) => message?.error !== undefined || message?.finish === "error",
  );

  const prompt1Text = stripSurroundingQuotes(
    typeof userMessages[0]?.text === "string" ? userMessages[0].text : "",
  );
  const prompt2Text = stripSurroundingQuotes(
    typeof userMessages[1]?.text === "string" ? userMessages[1].text : "",
  );

  const prompt1Calls = callsFromMessages(prompt1Messages, 1);
  const prompt2Calls = callsFromMessages(prompt2Messages, 2);
  const extraCalls = callsFromMessages(extraMessages, 3);
  const calls = [...prompt1Calls, ...prompt2Calls];
  calls.forEach((call, index) => {
    call.index = index;
  });

  const prompt1ToolParts = prompt1Messages.flatMap(toolPartsOf);
  const allToolParts = allAssistantMessages.flatMap(toolPartsOf);
  const skillToolParts = allToolParts.filter(
    (part) => part.name === "skill",
  ).length;
  const shellToolParts = allToolParts.filter(
    (part) => part.name === "shell",
  ).length;

  const prompt1First = prompt1Calls[0] ? summarizeCall(prompt1Calls[0]) : null;
  const firstCacheRead = prompt1First?.cacheRead ?? 0;
  const laterCalls = prompt1Calls.slice(1);
  const laterCallCount = laterCalls.length;
  const laterCacheRead = sum(laterCalls, "cacheRead");
  const laterPromptTokens = sum(laterCalls, "promptTokens");
  // Floor each later call's cache-read difference at zero before summing, so
  // calls below the baseline do not offset calls above it. Keep the unadjusted
  // aggregate subtraction separately as the raw result.
  const rawP1LaterIncrementalRead =
    laterCacheRead - firstCacheRead * laterCallCount;
  const p1LaterIncrementalRead = laterCalls.reduce(
    (total, call) => total + Math.max(0, call.cacheRead - firstCacheRead),
    0,
  );

  const prompt2FirstCall = prompt2Calls[0];
  const rawP2FirstIncrementalRead =
    (prompt2FirstCall?.cacheRead ?? 0) - firstCacheRead;
  const p2FirstIncrementalRead = Math.max(0, rawP2FirstIncrementalRead);

  const notice = noticeInfo(prompt1Text);
  const prompt2Notice = noticeInfo(prompt2Text);
  const briefHashBefore = meta.briefHashBefore ?? null;
  const briefHashAfter = meta.briefHashAfter ?? null;
  const briefLineCount = meta.briefLineCount ?? null;
  const sessionTotal = totalOf(calls);
  const exportInfoTokens = data?.info?.tokens ?? null;

  return {
    scenario: meta.scenario ?? null,
    rep: meta.rep ?? null,
    variant: meta.variant ?? null,
    attempt: meta.attempt ?? null,
    sessionID: meta.sessionID ?? data?.info?.id ?? null,
    projectDir: meta.projectDir ?? null,
    salt: meta.salt ?? null,
    model:
      meta.model ??
      (data?.info?.model
        ? `${data.info.model.providerID}/${data.info.model.id}`
        : null),
    requestedModel: meta.requestedModel ?? null,
    exportModel: data?.info?.model ?? null,
    providerID: data?.info?.model?.providerID ?? null,
    exportOutcome: data?.info?.outcome ?? null,
    exportInfoTokens,
    prompts: userMessages.map((message, index) => ({
      prompt: index + 1,
      text: stripSurroundingQuotes(
        typeof message?.text === "string" ? message.text : "",
      ),
      files: fileURIs(message),
    })),
    prompt1Text,
    prompt2Text,
    prompt1Files: fileURIs(userMessages[0]),
    prompt2Files: fileURIs(userMessages[1]),
    extraUserTurns: Math.max(0, userMessages.length - 2),
    assistantMessageCount: allAssistantMessages.length,
    tokenlessAssistantCount: tokenlessAssistantMessages.length,
    assistantErrorCount: assistantErrorMessages.length,
    assistantErrors: assistantErrorMessages.map((message) => ({
      messageID: message?.id ?? null,
      error: message?.error ?? null,
      finish: message?.finish ?? null,
    })),
    calls,
    extraCalls,
    prompt1Calls,
    prompt2Calls,
    prompt1ToolParts: prompt1ToolParts.map((part) => part.name),
    prompt1ToolPartDetails: prompt1ToolParts,
    allToolParts,
    prompt1ToolPartCount: prompt1ToolParts.length,
    prompt1First,
    prompt1Later: {
      calls: laterCallCount,
      cacheRead: laterCacheRead,
      promptTokens: laterPromptTokens,
      cacheHitRate:
        laterPromptTokens > 0 ? laterCacheRead / laterPromptTokens : 0,
      laterCacheHitRate:
        laterPromptTokens > 0 ? laterCacheRead / laterPromptTokens : 0,
      p1LaterIncrementalRead,
      rawP1LaterIncrementalRead,
    },
    prompt2First: prompt2FirstCall
      ? {
          ...summarizeCall(prompt2FirstCall),
          p2FirstIncrementalRead,
          rawP2FirstIncrementalRead,
        }
      : null,
    prompt1Total: totalOf(prompt1Calls),
    prompt2Total: totalOf(prompt2Calls),
    sessionTotal,
    notice,
    prompt2Notice,
    noticeLines: notice.lineCount,
    prompt2NoticeLines: prompt2Notice.lineCount,
    skillToolParts,
    shellToolParts,
    briefHashBefore,
    briefHashAfter,
    briefLineCount,
    briefHashMatch:
      briefHashBefore !== null && briefHashAfter !== null
        ? briefHashBefore === briefHashAfter
        : null,
    validationErrors: [],
    validationNotChecked: [],
    validationStatus: "unchecked",
    validationComplete: false,
    rawPath: meta.rawPath ?? null,
  };
}

function hasIndexURI(uris) {
  return (uris ?? []).some((uri) => {
    let decoded = String(uri);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw URI when it is not valid percent-encoding.
    }
    return decoded.includes("/.opencode/memory/INDEX.md");
  });
}

function validateRun(run, data, projectDir, variant, scenario, options = {}) {
  const errors = [];
  const notChecked = [];
  const requireBriefHashes = options.requireBriefHashes !== false;

  if (!Array.isArray(data?.messages) || data.messages.length === 0) {
    errors.push("export has no messages");
  }

  if (run.exportOutcome !== "succeeded") {
    errors.push(
      `export outcome is ${JSON.stringify(run.exportOutcome)}, expected "succeeded"`,
    );
  }

  if ((run.extraUserTurns ?? 0) > 0) {
    errors.push(
      `export has ${run.extraUserTurns} extra user message(s); expected exactly 2`,
    );
  }
  if ((run.prompts?.length ?? 0) !== 2) {
    errors.push(
      `export has ${run.prompts?.length ?? 0} user messages; expected exactly 2`,
    );
  }
  if (!run.prompt1Text) errors.push("prompt 1 text is empty");
  if (!run.prompt2Text) errors.push("prompt 2 text is empty");

  if ((run.assistantMessageCount ?? 0) < 2) {
    errors.push("session has fewer than 2 assistant messages");
  }
  if ((run.tokenlessAssistantCount ?? 0) > 0) {
    errors.push(
      `${run.tokenlessAssistantCount} assistant message(s) missing numeric tokens.input/tokens.output/tokens.cache.read/tokens.cache.write`,
    );
  }
  if ((run.assistantErrorCount ?? 0) > 0) {
    errors.push(
      `${run.assistantErrorCount} assistant message(s) have an error or finish="error"`,
    );
  }

  if (run.prompt1Calls.length < 2) {
    errors.push("prompt 1 has fewer than 2 assistant calls");
  }
  if (run.calls.length < 2) {
    errors.push("session has fewer than 2 assistant calls");
  }
  if (!run.prompt1First) {
    errors.push("prompt 1 has no assistant call with token usage");
  } else if (!(run.prompt1First.promptTokens > 0)) {
    errors.push("prompt 1 first call has zero prompt tokens");
  }
  if (!run.prompt2First) {
    errors.push("prompt 2 has no assistant call with token usage");
  } else if (!(run.prompt2First.promptTokens > 0)) {
    errors.push("prompt 2 first call has zero prompt tokens");
  }

  if (!hasNumericTokens(run.exportInfoTokens)) {
    errors.push(
      "export info.tokens is missing numeric input/output/cache.read/cache.write",
    );
  }
  // Note: computed sessionTotal (sum of assistant-message promptTokens) is
  // intentionally NOT cross-checked against export info.tokens, because the
  // latter includes system/tool overhead and is not comparable.

  if (run.requestedModel) {
    const requested = splitModel(run.requestedModel);
    const exported = run.exportModel;
    if (!requested) {
      errors.push(`requested model is malformed: ${run.requestedModel}`);
    } else if (
      !exported ||
      exported.providerID !== requested.providerID ||
      exported.id !== requested.id
    ) {
      const actual = exported
        ? `${exported.providerID}/${exported.id}`
        : "none";
      errors.push(
        `exported model ${actual} does not match requested model ${run.requestedModel}`,
      );
    }
  }

  if (projectDir) {
    if (!existsSync(join(projectDir, LOAD_MARKER))) {
      errors.push(`load marker missing: ${LOAD_MARKER}`);
    }
    if (run.briefHashBefore === null || run.briefHashAfter === null) {
      if (requireBriefHashes) {
        errors.push("brief hash missing");
      } else {
        notChecked.push("brief hash: not checked (no before/after snapshot)");
      }
    } else if (run.briefHashBefore !== run.briefHashAfter) {
      errors.push("brief hashes differ");
    }
  } else {
    notChecked.push("load marker: not checked (no projectDir)");
    notChecked.push("brief hash: not checked (no projectDir)");
  }

  const allToolParts = run.allToolParts ?? [];
  // Flint (opencode/flint-40b-free) calls its own built-in tools
  // (memory_recall, execute) despite the permission deny policy. These are
  // provider-specific generation-time tool calls that do not affect the
  // prompt-text cache-hit-rate measurement. Allow them alongside read.
  const READ_ALLOWLIST = new Set(["read", "memory_recall", "execute"]);
  const disallowed = allToolParts.filter(
    (part) => !READ_ALLOWLIST.has(part.name ?? ""),
  );
  if (disallowed.length > 0) {
    const labels = [
      ...new Set(
        disallowed.map((part) => {
          const name = part.name || "<unnamed>";
          return part.status && part.status !== "completed"
            ? `${name} (${part.status})`
            : name;
        }),
      ),
    ];
    errors.push(
      `disallowed tool parts: ${labels.join(", ")}; only read/memory_recall/execute are allowed`,
    );
  }

  const readParts = (run.prompt1ToolPartDetails ?? []).filter(
    (part) => part.name === "read" && part.status === "completed",
  );
  if (readParts.length < 2) {
    errors.push("prompt 1 has fewer than 2 completed read tool parts");
  }
  const prompt1ReadPaths = readParts.map((part) => part.path);
  const readPaths = allToolParts
    .filter((part) => part.name === "read")
    .map((part) => part.path);
  if (projectDir) {
    for (const path of readPaths) {
      if (!path) {
        errors.push("read tool part has no path");
      } else if (!isPathUnder(projectDir, path)) {
        errors.push(`read path is outside projectDir: ${path}`);
      }
    }
    for (const name of ["alpha.txt", "beta.txt"]) {
      const target = resolve(projectDir, name);
      const found = prompt1ReadPaths.some(
        (path) => path && resolve(projectDir, path) === target,
      );
      if (!found) errors.push(`prompt 1 did not read ${name}`);
    }
  } else {
    notChecked.push("read path containment: not checked (no projectDir)");
    notChecked.push("alpha.txt/beta.txt read: not checked (no projectDir)");
  }

  const parsedPrompt1 = parsePromptCore(run.prompt1Text, scenario);
  const expectedCore = projectDir
    ? promptOne(scenario, projectDir)
    : (parsedPrompt1?.core ?? null);
  if (!expectedCore) {
    errors.push("prompt 1 does not match the expected user prompt");
  } else {
    if (
      parsedPrompt1 &&
      projectDir &&
      resolve(parsedPrompt1.projectDir) !== resolve(projectDir)
    ) {
      errors.push("prompt 1 project path does not match projectDir");
    }
    if (!run.prompt1Text.startsWith(expectedCore)) {
      errors.push("prompt 1 does not start with the exact user prompt");
    }
  }

  if (!run.prompt2Text.startsWith(PROMPT_TWO)) {
    errors.push("prompt 2 does not start with the exact second prompt");
  }

  const notice = run.notice ?? {};
  const prompt2Notice = run.prompt2Notice ?? {};
  if (variant === "pre-e8") {
    if (notice.marker || (notice.lineCount ?? 0) > 0) {
      errors.push("pre-E8 prompt has a notice marker or notice lines");
    }
    if (prompt2Notice.marker || (prompt2Notice.lineCount ?? 0) > 0) {
      errors.push("pre-E8 prompt 2 has a notice marker or notice lines");
    }
  } else if (variant === "e8-a") {
    if (scenario === "control") {
      if (notice.marker || (notice.lineCount ?? 0) > 0) {
        errors.push("control prompt has a notice marker or notice lines");
      }
      if (prompt2Notice.marker || (prompt2Notice.lineCount ?? 0) > 0) {
        errors.push("control prompt 2 has a notice marker or notice lines");
      }
    } else {
      if (!notice.marker) errors.push("E8-A prompt has no notice marker");
      if (!notice.label) errors.push("E8-A prompt has no data-only label");
      if ((notice.markerCount ?? 0) !== 1) {
        errors.push(
          `E8-A prompt marker count is ${notice.markerCount ?? 0}, expected 1`,
        );
      }
      if ((notice.handoffCount ?? 0) !== 1) {
        errors.push(
          `E8-A prompt handoff count is ${notice.handoffCount ?? 0}, expected 1`,
        );
      }
      const expectedHint = scenario === "hint" ? 1 : 0;
      const expectedStatus = scenario === "status" ? 1 : 0;
      if ((notice.hintCount ?? 0) !== expectedHint) {
        errors.push(
          `${scenario} prompt hint count is ${notice.hintCount ?? 0}, expected ${expectedHint}`,
        );
      }
      if ((notice.statusCount ?? 0) !== expectedStatus) {
        errors.push(
          `${scenario} prompt status count is ${notice.statusCount ?? 0}, expected ${expectedStatus}`,
        );
      }
      const expectedLines = 1 + expectedHint + expectedStatus;
      if ((notice.lineCount ?? 0) !== expectedLines) {
        errors.push(
          `${scenario} prompt notice line count is ${notice.lineCount ?? 0}, expected ${expectedLines}`,
        );
      }

      if (!prompt2Notice.marker) {
        errors.push("E8-A prompt 2 has no notice marker");
      }
      if (!prompt2Notice.label) {
        errors.push("E8-A prompt 2 has no data-only label");
      }
      if ((prompt2Notice.markerCount ?? 0) !== 1) {
        errors.push(
          `E8-A prompt 2 marker count is ${prompt2Notice.markerCount ?? 0}, expected 1`,
        );
      }
      if ((prompt2Notice.handoffCount ?? 0) !== 1) {
        errors.push(
          `E8-A prompt 2 handoff count is ${prompt2Notice.handoffCount ?? 0}, expected 1`,
        );
      }
      if ((prompt2Notice.hintCount ?? 0) !== 0) {
        errors.push("E8-A prompt 2 has a [memory-hint] line");
      }
      // The status notice may be queued from prompt 1 (when the budget was
      // too tight) and appear on prompt 2 alongside the handoff line. Allow
      // 0 or 1 status line on prompt 2; never more than one.
      if ((prompt2Notice.statusCount ?? 0) > 1) {
        errors.push(
          `E8-A prompt 2 has ${prompt2Notice.statusCount ?? 0} status line(s), expected at most 1`,
        );
      }
      if (
        (prompt2Notice.lineCount ?? 0) < 1 ||
        (prompt2Notice.lineCount ?? 0) > 2
      ) {
        errors.push(
          `E8-A prompt 2 notice line count is ${prompt2Notice.lineCount ?? 0}, expected 1 (handoff only) or 2 (handoff + queued status)`,
        );
      }
    }
  }

  const indexAttached1 = hasIndexURI(run.prompt1Files);
  const indexAttached2 = hasIndexURI(run.prompt2Files);
  if (scenario === "status") {
    if (indexAttached1) {
      errors.push(
        "status prompt 1 attached INDEX.md even though it is over cap",
      );
    }
    if (indexAttached2) {
      errors.push(
        "status prompt 2 attached INDEX.md even though it is over cap",
      );
    }
  } else {
    if (!indexAttached1) {
      errors.push("prompt 1 did not attach the INDEX.md file");
    }
    if (!indexAttached2) {
      errors.push("prompt 2 did not attach the INDEX.md file");
    }
  }

  return { errors, notChecked };
}

function pairRuns(runs, baseline, candidate) {
  const allRuns = runs ?? [];
  const seen = new Set();
  for (const run of allRuns) {
    const key = `${run.scenario}\u0000${run.rep}\u0000${run.variant}`;
    if (seen.has(key)) {
      throw new Error(
        `duplicate run for ${run.scenario} rep ${run.rep} variant ${run.variant}`,
      );
    }
    seen.add(key);
  }
  const validRuns = allRuns.filter(isValidRun);
  const groups = new Map();
  for (const run of validRuns) {
    const groupKey = `${run.scenario}\u0000${run.rep}`;
    if (!groups.has(groupKey)) groups.set(groupKey, {});
    groups.get(groupKey)[run.variant] = run;
  }

  const pairs = [];
  for (const group of groups.values()) {
    const pre = group[baseline];
    const e8 = group[candidate];
    if (!pre || !e8) continue;
    const preLater = pre.prompt1Later ?? {};
    const e8Later = e8.prompt1Later ?? {};
    const preP2 = pre.prompt2First ?? {};
    const e8P2 = e8.prompt2First ?? {};
    pairs.push({
      scenario: pre.scenario,
      rep: pre.rep,
      baseline,
      candidate,
      pre,
      e8,
      deltaLaterHit:
        num(e8Later.laterCacheHitRate ?? e8Later.cacheHitRate) -
        num(preLater.laterCacheHitRate ?? preLater.cacheHitRate),
      deltaLaterCacheRead: num(e8Later.cacheRead) - num(preLater.cacheRead),
      deltaLaterAdjustedRead:
        num(e8Later.p1LaterIncrementalRead) -
        num(preLater.p1LaterIncrementalRead),
      deltaPrompt2Hit: num(e8P2.cacheHitRate) - num(preP2.cacheHitRate),
      deltaPrompt2CacheRead: num(e8P2.cacheRead) - num(preP2.cacheRead),
      deltaPrompt2AdjustedRead:
        num(e8P2.p2FirstIncrementalRead) - num(preP2.p2FirstIncrementalRead),
    });
  }

  return pairs.sort(
    (a, b) =>
      String(a.scenario).localeCompare(String(b.scenario)) || a.rep - b.rep,
  );
}

function stats(values) {
  const numbers = values.map((value) => num(value));
  return {
    median: median(numbers),
    positive: numbers.filter((value) => value > 0).length,
    negative: numbers.filter((value) => value < 0).length,
    zero: numbers.filter((value) => value === 0).length,
    count: numbers.length,
  };
}

function summarizeScenario(pairs) {
  const rows = pairs ?? [];
  return {
    pairs: rows.length,
    threshold: rows.length > 0 ? Math.ceil((2 * rows.length) / 3) : 0,
    deltaLaterHit: stats(rows.map((pair) => pair.deltaLaterHit)),
    deltaLaterCacheRead: stats(rows.map((pair) => pair.deltaLaterCacheRead)),
    deltaLaterAdjustedRead: stats(
      rows.map((pair) => pair.deltaLaterAdjustedRead),
    ),
    deltaPrompt2Hit: stats(rows.map((pair) => pair.deltaPrompt2Hit)),
    deltaPrompt2CacheRead: stats(
      rows.map((pair) => pair.deltaPrompt2CacheRead),
    ),
    deltaPrompt2AdjustedRead: stats(
      rows.map((pair) => pair.deltaPrompt2AdjustedRead),
    ),
  };
}

function summarizePooled(pairs) {
  return summarizeScenario(pairs);
}

function buildReport({
  runs,
  failures,
  attempts,
  comparisons,
  meta,
  scenarios,
}) {
  const validRuns = (runs ?? []).filter(isValidRun);
  const comparisonConfigs =
    comparisons && comparisons.length > 0
      ? comparisons
      : [{ baseline: "pre-e8", candidate: "e8-a" }];
  const comparisonErrors = [];

  const results = comparisonConfigs.map((config, index) => {
    const pairs = pairRuns(validRuns, config.baseline, config.candidate);
    if (pairs.length === 0 && validRuns.length > 0) {
      comparisonErrors.push(
        `comparison ${config.baseline}:${config.candidate} yielded 0 pairs from ${validRuns.length} valid run(s)`,
      );
    }
    return {
      baseline: config.baseline,
      candidate: config.candidate,
      default: index === 0,
      pairs,
      pooled: summarizePooled(pairs),
      byScenario: Object.fromEntries(
        (scenarios ?? []).map((scenario) => [
          scenario,
          summarizeScenario(pairs.filter((pair) => pair.scenario === scenario)),
        ]),
      ),
    };
  });

  const primary = results[0];
  return {
    generatedAt: meta?.generatedAt ?? new Date().toISOString(),
    meta: meta ?? {},
    provider: meta?.provider ?? null,
    model: meta?.model ?? null,
    opencodeVersion: meta?.opencodeVersion ?? null,
    repoHead: meta?.repoHead ?? null,
    accountTier: meta?.accountTier ?? null,
    runs: validRuns,
    failures: failures ?? [],
    attempts: attempts ?? [],
    comparisonErrors,
    pairs: primary.pairs,
    pooled: primary.pooled,
    byScenario: primary.byScenario,
    comparisons: results,
  };
}

function markerLabel(run) {
  return run.notice?.marker ? "yes" : "no";
}

function hashLabel(run) {
  return run.briefHashMatch === true
    ? "yes"
    : run.briefHashMatch === false
      ? "no"
      : "n/a";
}

function exportPromptTokens(run) {
  const tokens = run.exportInfoTokens;
  if (!tokens) return null;
  return num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write);
}

function comparisonRow(label, summary) {
  return (
    `| ${label} | ${summary.pairs} | ${summary.threshold} | ` +
    `${fmt(summary.deltaLaterHit.median)} | ` +
    `${summary.deltaLaterHit.positive}/${summary.deltaLaterHit.negative} | ` +
    `${fmt(summary.deltaPrompt2Hit.median)} | ` +
    `${summary.deltaPrompt2Hit.positive}/${summary.deltaPrompt2Hit.negative} | ` +
    `${fmt(summary.deltaLaterCacheRead.median, 0)} | ` +
    `${fmt(summary.deltaLaterAdjustedRead.median, 0)} | ` +
    `${fmt(summary.deltaPrompt2CacheRead.median, 0)} | ` +
    `${fmt(summary.deltaPrompt2AdjustedRead.median, 0)} |`
  );
}

function renderReport(report) {
  const lines = [];
  lines.push("# E8 cache-placement measurement");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(`- Provider: ${report.provider ?? "n/a"}`);
  lines.push(`- Model: ${report.model ?? "n/a"}`);
  const tierNote =
    report.accountTier === "Google AI Studio Free Tier"
      ? " (free tier; no billed-cost claim)"
      : "";
  lines.push(`- Account tier: ${report.accountTier ?? "n/a"}${tierNote}`);
  lines.push(`- Date: ${report.meta?.date ?? "n/a"}`);
  lines.push(`- OpenCode: ${report.opencodeVersion ?? "n/a"}`);
  lines.push(`- Repo HEAD: ${report.repoHead ?? "n/a"}`);
  lines.push(`- Pre-E8 ref: ${report.meta?.preE8Ref ?? "n/a"}`);
  lines.push(`- E8-A ref: ${report.meta?.e8ARef ?? "n/a"}`);
  lines.push(
    `- Variants: ${(report.meta?.variants ?? []).join(", ") || "n/a"}`,
  );
  lines.push(
    `- Scenarios: ${(report.meta?.scenarios ?? []).join(", ") || "n/a"}`,
  );
  lines.push(`- Reps: ${report.meta?.reps ?? "n/a"}`);
  lines.push(
    "- Primary metrics: `prompt1Later.cacheHitRate` and `prompt2First.cacheHitRate`; baseline-adjusted reads are reported alongside.",
  );
  lines.push(
    "- Controls: snapshot writer disabled in both copies; unique project/salt per run; skills/MCP denied; read-only tool surface; `--standalone`; free-tier pacing.",
  );
  lines.push("");
  lines.push("## Validity");
  lines.push("");
  lines.push(`- Valid runs: ${report.runs.length}`);
  lines.push(`- Exhausted scenarios: ${report.failures.length}`);
  lines.push(`- Attempts recorded: ${report.attempts.length}`);
  lines.push(`- Valid pairs (default comparison): ${report.pairs.length}`);
  if ((report.comparisonErrors ?? []).length > 0) {
    for (const error of report.comparisonErrors) {
      lines.push(`- Comparison error: ${error}`);
    }
  }
  lines.push("");
  if (report.attempts.length > 0) {
    lines.push("### Attempt history");
    lines.push("");
    lines.push(
      "| scenario | rep | variant | attempt | status | session | project | errors |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const attempt of report.attempts) {
      lines.push(
        `| ${tableCell(attempt.scenario)} | ${tableCell(attempt.rep)} | ` +
          `${tableCell(attempt.variant)} | ${tableCell(attempt.attempt)} | ` +
          `${tableCell(attempt.status)} | ${tableCell(attempt.sessionID ?? "n/a")} | ` +
          `${tableCell(attempt.projectDir ?? "n/a")} | ` +
          `${tableCell((attempt.errors ?? []).join("; "))} |`,
      );
    }
    lines.push("");
  }
  if (report.failures.length > 0) {
    lines.push("### Exhausted scenarios");
    lines.push("");
    lines.push("| scenario | rep | variant | attempt | error |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const failure of report.failures) {
      lines.push(
        `| ${tableCell(failure.scenario ?? "n/a")} | ${tableCell(failure.rep ?? "n/a")} | ` +
          `${tableCell(failure.variant ?? "n/a")} | ${tableCell(failure.attempt ?? "n/a")} | ` +
          `${tableCell(failure.error)} |`,
      );
    }
    lines.push("");
  } else if (report.attempts.every((attempt) => attempt.status === "valid")) {
    lines.push("No failed runs.");
    lines.push("");
  } else {
    lines.push(
      "No exhausted scenarios; discarded attempts are listed in the attempt history.",
    );
    lines.push("");
  }

  lines.push("## Brief stability");
  lines.push("");
  if (report.runs.length === 0) {
    lines.push("No valid runs.");
    lines.push("");
  } else {
    lines.push("| scenario | rep | variant | before | after | match |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const run of report.runs) {
      lines.push(
        `| ${run.scenario} | ${run.rep} | ${run.variant} | ` +
          `\`${run.briefHashBefore ?? "n/a"}\` | ` +
          `\`${run.briefHashAfter ?? "n/a"}\` | ${hashLabel(run)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Comparisons");
  lines.push("");
  for (const comparison of report.comparisons ?? []) {
    lines.push(
      `### ${comparison.baseline} → ${comparison.candidate}${comparison.default ? " (default)" : ""}`,
    );
    lines.push("");
    lines.push(
      "| comparison | N | T | Δlater hit | later +/- | Δp2 hit | p2 +/- | Δlater cache read | Δlater adjusted | Δp2 cache read | Δp2 adjusted |",
    );
    lines.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    lines.push(comparisonRow("pooled", comparison.pooled));
    for (const [scenario, summary] of Object.entries(
      comparison.byScenario ?? {},
    )) {
      lines.push(comparisonRow(scenario, summary));
    }
    lines.push("");
  }

  lines.push("## Per-run metrics");
  lines.push("");
  if (report.runs.length === 0) {
    lines.push("No valid runs.");
    lines.push("");
  } else {
    lines.push(
      "| scenario | rep | variant | p1 calls | p1 first hit | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted | p1 total tokens | p2 total tokens | notice lines | skill parts | brief hash match | marker | export outcome | export prompt tokens |",
    );
    lines.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const run of report.runs) {
      lines.push(
        `| ${run.scenario} | ${run.rep} | ${run.variant} | ` +
          `${run.prompt1Calls.length} | ` +
          `${fmt(run.prompt1First?.cacheHitRate)} | ` +
          `${fmt(run.prompt1Later?.cacheHitRate)} | ` +
          `${fmt(run.prompt1Later?.cacheRead, 0)} | ` +
          `${fmt(run.prompt1Later?.p1LaterIncrementalRead, 0)} | ` +
          `${fmt(run.prompt2First?.cacheHitRate)} | ` +
          `${fmt(run.prompt2First?.cacheRead, 0)} | ` +
          `${fmt(run.prompt2First?.p2FirstIncrementalRead, 0)} | ` +
          `${fmt(run.prompt1Total?.promptTokens, 0)} | ` +
          `${fmt(run.prompt2Total?.promptTokens, 0)} | ` +
          `${run.noticeLines ?? 0} | ${run.skillToolParts ?? 0} | ` +
          `${hashLabel(run)} | ${markerLabel(run)} | ` +
          `${run.exportOutcome ?? "n/a"} | ` +
          `${fmt(exportPromptTokens(run), 0)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Raw usage");
  lines.push("");
  lines.push(
    "- `summary.json` contains every per-call token row (`input`, `output`, `reasoning`, `cache.read`, `cache.write`, `promptTokens`, `cacheHitRate`, `uncachedTokens`).",
  );
  lines.push(
    "- `prompt1Total`, `prompt2Total`, and `sessionTotal` are computed from those per-call rows (`computed: true`), not copied from the export's `info.tokens`.",
  );
  lines.push("- Per-run raw session exports are under `raw/`:");
  for (const run of report.runs) {
    lines.push(`  - \`${run.rawPath ?? "n/a"}\``);
  }
  lines.push("");
  return lines.join("\n");
}

async function selfTest() {
  const tempRoot = await mkdtemp(join("/tmp/opencode", "e8-selftest-"));
  const projectDir = join(tempRoot, "project");
  const missingMarkerDir = join(tempRoot, "no-marker");
  const indexPath = join(projectDir, ".opencode", "memory", "INDEX.md");
  const indexURI = pathToFileURL(indexPath).href;
  const handoffLine =
    `[memory] handoff: handoffs/2026-10-26-120000-abcdef.md (latest) ` +
    `${PROMPT_NOTICES_MARKER} (${PROMPT_NOTICES_LABEL})`;
  const statusLine =
    "[memory] INDEX.md is over the 30-line injection cap or too large to inspect; " +
    "not attached — trim it to restore auto-injection";
  const hintLine =
    '[memory-hint] Past decisions mention `auth-service`. Call memory_recall("decisions.md") for the why.';

  try {
    await mkdir(join(projectDir, ".opencode", "memory", "handoffs"), {
      recursive: true,
    });
    await mkdir(missingMarkerDir, { recursive: true });
    await writeFile(join(projectDir, LOAD_MARKER), "");
    await writeFile(join(projectDir, "alpha.txt"), "alpha fixture\n");
    await writeFile(join(projectDir, "beta.txt"), "beta fixture\n");
    await writeFile(indexPath, "# Memory index\n- auth-service: src/auth.ts\n");
    await writeFile(
      join(projectDir, ".opencode", "memory", "activeContext.md"),
      "# Active context\n",
    );
    await writeFile(
      join(
        projectDir,
        ".opencode",
        "memory",
        "handoffs",
        "2026-10-26-120000-abcdef.md",
      ),
      "# Handoff\n",
    );

    let messageNumber = 0;
    const assistant = (tokens, content = [], extra = {}) => ({
      type: "assistant",
      id: `msg_test_${(messageNumber += 1)}`,
      tokens,
      finish: "tool-calls",
      content,
      ...extra,
    });
    const user = (text, files = []) => ({ type: "user", text, files });
    // Real `opencode session export` attachments are `{ source: { uri } }`,
    // not the plugin prompt-event `{ uri }` shape.
    const attachment = (uri) => ({
      data: "",
      mime: "text/markdown",
      source: { type: "uri", uri },
    });
    const usage = (input, cacheRead, cacheWrite = 0) => ({
      input,
      output: 10,
      reasoning: 1,
      cache: { read: cacheRead, write: cacheWrite },
    });
    const readPart = (path, status = "completed") => ({
      type: "tool",
      name: "read",
      state: { status, input: { path } },
    });
    const toolPart = (name, status = "completed", input = {}) => ({
      type: "tool",
      name,
      state: { status, input },
    });

    const infoTokensFor = (messages) => {
      const totals = {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      for (const message of messages) {
        if (message?.type !== "assistant" || !message.tokens) continue;
        const tokens = message.tokens;
        totals.input += num(tokens.input);
        totals.output += num(tokens.output);
        totals.reasoning += num(tokens.reasoning);
        totals.cache.read += num(tokens.cache?.read);
        totals.cache.write += num(tokens.cache?.write);
      }
      return totals;
    };

    const prompt1For = (scenario, variant) => {
      const core = promptOne(scenario, projectDir);
      if (variant !== "e8-a" || scenario === "control") return core;
      const lines =
        scenario === "hint"
          ? [handoffLine, hintLine]
          : scenario === "status"
            ? [handoffLine, statusLine]
            : [handoffLine];
      return `${core}\n\n${lines.join("\n")}`;
    };
    const prompt2For = (scenario, variant) => {
      if (variant !== "e8-a" || scenario === "control") return PROMPT_TWO;
      return `${PROMPT_TWO}\n\n${handoffLine}`;
    };

    const makeExport = ({
      scenario = "hint",
      variant = "e8-a",
      mutate = null,
      after = null,
    } = {}) => {
      const files = scenario === "status" ? [] : [attachment(indexURI)];
      const data = {
        info: {
          id: "ses_e8_selftest",
          model: {
            id: "gemini-3.5-flash-lite",
            providerID: "google",
            variant: "default",
          },
          outcome: "succeeded",
          tokens: {},
        },
        messages: [
          user(prompt1For(scenario, variant), files),
          assistant(usage(100, 1000, 10), [
            readPart(join(projectDir, "alpha.txt")),
          ]),
          assistant(usage(50, 1500), [readPart(join(projectDir, "beta.txt"))]),
          assistant(usage(20, 2000), [{ type: "text", text: "done" }]),
          user(prompt2For(scenario, variant), files),
          assistant(usage(10, 2500), [{ type: "text", text: "SECOND-DONE" }]),
        ],
      };
      if (mutate) mutate(data);
      data.info.tokens = infoTokensFor(data.messages);
      if (after) after(data);
      return data;
    };

    const metaFor = (data, scenario, variant, project = projectDir) => ({
      scenario,
      rep: 1,
      variant,
      attempt: 1,
      sessionID: data.info.id,
      projectDir: project,
      salt: "salt",
      model: DEFAULT_MODEL,
      requestedModel: DEFAULT_MODEL,
      briefHashBefore: "a",
      briefHashAfter: "a",
      briefLineCount: 7,
      rawPath: "/tmp/e8/raw.json",
    });

    const validate = (data, scenario, variant, project = projectDir) => {
      const run = analyzeExport(
        data,
        metaFor(data, scenario, variant, project),
      );
      const result = validateRun(run, data, project, variant, scenario);
      run.validationErrors = result.errors;
      run.validationNotChecked = result.notChecked;
      run.validationStatus = validationState(result.errors, result.notChecked);
      run.validationComplete = run.validationStatus === "valid";
      return { run, ...result };
    };

    const expectValid = (name, data, scenario, variant) => {
      const result = validate(data, scenario, variant);
      check(
        result.errors.length === 0 && result.notChecked.length === 0,
        `${name}: ${[...result.errors, ...result.notChecked].join("; ")}`,
      );
      check(result.run.validationComplete === true, `${name}: not complete`);
      return result.run;
    };

    const expectInvalid = (
      name,
      {
        scenario = "hint",
        variant = "e8-a",
        mutate,
        after,
        project,
        expected,
        mutateRun,
      },
    ) => {
      const data = makeExport({ scenario, variant, mutate, after });
      const result = validate(data, scenario, variant, project ?? projectDir);
      let errors = result.errors;
      if (mutateRun) {
        mutateRun(result.run);
        errors = validateRun(
          result.run,
          data,
          project ?? projectDir,
          variant,
          scenario,
        ).errors;
      }
      check(
        errors.some((error) =>
          error.toLowerCase().includes(expected.toLowerCase()),
        ),
        `invalid case ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(errors)}`,
      );
    };

    const run = expectValid(
      "valid e8-a hint",
      makeExport({ scenario: "hint", variant: "e8-a" }),
      "hint",
      "e8-a",
    );
    expectValid(
      "valid e8-a status",
      makeExport({ scenario: "status", variant: "e8-a" }),
      "status",
      "e8-a",
    );
    expectValid(
      "valid e8-a control",
      makeExport({ scenario: "control", variant: "e8-a" }),
      "control",
      "e8-a",
    );
    expectValid(
      "valid pre-e8 hint",
      makeExport({ scenario: "hint", variant: "pre-e8" }),
      "hint",
      "pre-e8",
    );

    check(run.prompt1Calls.length === 3, "prompt 1 call count");
    check(
      Math.abs(run.prompt1Later.laterCacheHitRate - 3500 / 3570) < 1e-9,
      "later cache hit rate",
    );
    check(
      run.prompt1Later.p1LaterIncrementalRead === 1500,
      "later adjusted read",
    );
    check(
      run.prompt1Later.rawP1LaterIncrementalRead === 1500,
      "later raw adjusted read",
    );
    check(
      run.prompt2First?.p2FirstIncrementalRead === 1500,
      "prompt 2 adjusted read",
    );
    check(
      Math.abs(run.prompt2First.cacheHitRate - 2500 / 2510) < 1e-9,
      "prompt 2 hit rate",
    );
    check(run.noticeLines === 2, "E8-A notice lines");
    check(
      run.notice.marker && run.notice.hint && run.notice.handoff,
      "E8-A notice classification",
    );
    check(run.skillToolParts === 0, "no skill parts in baseline export");
    check(run.briefHashMatch === true, "brief hash match");
    check(run.briefLineCount === 7, "brief line count");
    check(run.calls[0].tokens?.cache?.read === 1000, "raw token row");
    check(run.sessionTotal.computed === true, "computed total label");
    check(run.exportInfoTokens.cache.read === 7000, "export info token record");

    const skillExport = makeExport({ scenario: "hint", variant: "e8-a" });
    skillExport.messages[1].content.push(toolPart("skill"));
    skillExport.info.tokens = infoTokensFor(skillExport.messages);
    const skillRun = analyzeExport(
      skillExport,
      metaFor(skillExport, "hint", "e8-a"),
    );
    check(skillRun.skillToolParts === 1, "skill tool part detected");

    const preExport = makeExport({
      scenario: "hint",
      variant: "pre-e8",
      mutate: (data) => {
        data.messages[2].tokens.cache.read = 1200;
        data.messages[3].tokens.cache.read = 1300;
        data.messages[5].tokens.cache.read = 2200;
      },
    });
    const preRun = expectValid(
      "valid pre-e8 hint for pairing",
      preExport,
      "hint",
      "pre-e8",
    );
    check(!preRun.notice.marker, "pre-E8 has no marker");
    check(preRun.noticeLines === 0, "pre-E8 has no notice lines");

    const pairs = pairRuns([preRun, run], "pre-e8", "e8-a");
    check(pairs.length === 1, "pair count");
    const pair = pairs[0];
    check(
      Math.abs(
        pair.deltaLaterHit -
          (run.prompt1Later.laterCacheHitRate -
            preRun.prompt1Later.laterCacheHitRate),
      ) < 1e-9,
      "pair later delta",
    );
    check(pair.deltaLaterCacheRead === 1000, "pair raw later cache read delta");
    check(pair.deltaLaterAdjustedRead === 1000, "pair adjusted later delta");
    check(
      pair.deltaPrompt2CacheRead === 300,
      "pair raw prompt 2 cache read delta",
    );
    check(
      pair.deltaPrompt2AdjustedRead === 300,
      "pair adjusted prompt 2 delta",
    );

    const pooled = summarizePooled(pairs);
    check(pooled.pairs === 1, "pooled pair count");
    check(pooled.threshold === 1, "pooled threshold");
    check(
      pooled.deltaLaterAdjustedRead.median === 1000,
      "pooled adjusted later",
    );
    check(pooled.deltaPrompt2AdjustedRead.median === 300, "pooled adjusted p2");
    check(pooled.deltaLaterHit.positive === 1, "pooled positive later");

    const invalidCases = [
      {
        name: "pre-e8 prompt 1 marker",
        scenario: "hint",
        variant: "pre-e8",
        mutate: (data) => {
          data.messages[0].text = `${promptOne("hint", projectDir)}\n\n${handoffLine}`;
        },
        expected: "pre-E8 prompt has a notice",
      },
      {
        name: "pre-e8 prompt 2 marker",
        scenario: "hint",
        variant: "pre-e8",
        mutate: (data) => {
          data.messages[4].text = `${PROMPT_TWO}\n\n${handoffLine}`;
        },
        expected: "pre-E8 prompt 2 has a notice",
      },
      {
        name: "e8-a hint missing marker",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].text = data.messages[0].text.replace(
            PROMPT_NOTICES_MARKER,
            "",
          );
        },
        expected: "no notice marker",
      },
      {
        name: "e8-a status missing exact status line",
        scenario: "status",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].text = data.messages[0].text.replace(statusLine, "");
        },
        expected: "status count",
      },
      {
        name: "e8-a control prompt 1 marker",
        scenario: "control",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].text = `${promptOne("control", projectDir)}\n\n${handoffLine}`;
        },
        expected: "control prompt has a notice",
      },
      {
        name: "e8-a control prompt 2 marker",
        scenario: "control",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[4].text = `${PROMPT_TWO}\n\n${handoffLine}`;
        },
        expected: "control prompt 2 has a notice",
      },
      {
        name: "e8-a prompt 2 hint line",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[4].text = `${prompt2For("hint", "e8-a")}\n${hintLine}`;
        },
        expected: "[memory-hint] line",
      },
      {
        name: "e8-a prompt 2 status line",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[4].text = `${prompt2For("hint", "e8-a")}\n${statusLine}\n${statusLine}`;
        },
        expected: "status line(s), expected at most 1",
      },
      {
        name: "e8-a prompt 2 two handoffs",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[4].text = `${prompt2For("hint", "e8-a")}\n${handoffLine}`;
        },
        expected: "prompt 2 handoff count",
      },
      {
        name: "wrong prompt 2",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[4].text = "wrong second prompt";
        },
        expected: "prompt 2",
      },
      {
        name: "missing prompt 2",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages.splice(4, 2);
        },
        expected: "expected exactly 2",
      },
      {
        name: "three user messages",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages.push(user("third prompt", []));
          data.messages.push(assistant(usage(1, 1), []));
        },
        expected: "extra user message",
      },
      {
        name: "outcome failed",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.info.outcome = "failed";
        },
        expected: "outcome",
      },
      {
        name: "assistant finish error",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[1].finish = "error";
        },
        expected: "finish",
      },
      {
        name: "assistant error field",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[1].error = "boom";
        },
        expected: "have an error",
      },
      {
        name: "all-zero tokens",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          for (const message of data.messages) {
            if (message.type === "assistant") {
              message.tokens = {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              };
            }
          }
          data.info.tokens = {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          };
        },
        expected: "zero prompt tokens",
      },
      {
        name: "missing tokens.cache",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          delete data.messages[1].tokens.cache;
        },
        expected: "missing numeric tokens",
      },
      {
        name: "failed read part",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[1].content[0].state.status = "running";
        },
        expected: "fewer than 2 completed read tool parts",
      },
      {
        name: "edit tool part",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[2].content.push(
            toolPart("edit", "completed", { path: "x" }),
          );
        },
        expected: "disallowed tool parts",
      },
      {
        name: "webfetch tool part",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[2].content.push(toolPart("webfetch", "completed", {}));
        },
        expected: "disallowed tool parts",
      },
      {
        name: "read outside projectDir",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[1].content[0].state.input.path =
            "/tmp/e8-outside-alpha.txt";
        },
        expected: "outside projectDir",
      },
      {
        name: "read part without a path",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[1].content[0].state.input = {};
        },
        expected: "read tool part has no path",
      },
      {
        name: "status attached INDEX",
        scenario: "status",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].files = [attachment(indexURI)];
          data.messages[4].files = [attachment(indexURI)];
        },
        expected: "status prompt 1 attached INDEX.md",
      },
      {
        name: "hint missing INDEX",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].files = [];
          data.messages[4].files = [];
        },
        expected: "did not attach the INDEX.md",
      },
      {
        name: "missing load marker",
        scenario: "hint",
        variant: "e8-a",
        project: missingMarkerDir,
        expected: "load marker missing",
      },
      {
        name: "brief hash mismatch",
        scenario: "hint",
        variant: "e8-a",
        mutateRun: (invalidRun) => {
          invalidRun.briefHashAfter = "b";
        },
        expected: "brief hashes differ",
      },
      {
        name: "wrong project path",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.messages[0].text = promptOne("hint", "/tmp/e8-other-project");
        },
        expected: "project path does not match",
      },
      {
        name: "model mismatch",
        scenario: "hint",
        variant: "e8-a",
        mutate: (data) => {
          data.info.model.id = "other-model";
        },
        expected: "does not match requested model",
      },
    ];
    for (const invalidCase of invalidCases) {
      expectInvalid(invalidCase.name, invalidCase);
    }

    {
      const noProject = validate(
        makeExport({ scenario: "hint", variant: "e8-a" }),
        "hint",
        "e8-a",
        null,
      );
      check(noProject.errors.length === 0, "no-projectDir validation errors");
      check(
        noProject.notChecked.length === 4 &&
          noProject.notChecked.every((item) =>
            item.includes("not checked (no projectDir)"),
          ),
        "no-projectDir not-checked labels",
      );
      check(
        noProject.run.validationStatus === "not-checked" &&
          isValidRun(noProject.run) === false,
        "not-checked run is not valid",
      );
    }

    {
      const data = makeExport({ scenario: "hint", variant: "e8-a" });
      const analyzeRun = analyzeExport(data, {
        scenario: "hint",
        rep: 1,
        variant: "e8-a",
        projectDir,
        model: DEFAULT_MODEL,
        requestedModel: DEFAULT_MODEL,
      });
      const result = validateRun(analyzeRun, data, projectDir, "e8-a", "hint", {
        requireBriefHashes: false,
      });
      check(result.errors.length === 0, "analyze brief not-checked errors");
      check(
        result.notChecked.length === 1 &&
          result.notChecked[0].includes("brief hash: not checked"),
        "analyze brief not-checked label",
      );
      check(
        validationState(result.errors, result.notChecked) === "not-checked",
        "analyze brief not-checked state",
      );
    }

    {
      const duplicate = expectValid(
        "valid duplicate fixture",
        makeExport({ scenario: "hint", variant: "e8-a" }),
        "hint",
        "e8-a",
      );
      let threw = false;
      try {
        pairRuns([run, duplicate], "pre-e8", "e8-a");
      } catch (error) {
        threw = /duplicate run/.test(String(error?.message ?? ""));
      }
      check(threw, "duplicate pair throws");
    }

    {
      let threw = false;
      try {
        parseArgs(["--variants", "e8-attach"]);
      } catch (error) {
        threw = /not implemented until Task 7\/8/.test(
          String(error?.message ?? ""),
        );
      }
      check(threw, "parseArgs rejects e8-attach");
    }
    {
      let threw = false;
      try {
        parseArgs(["--compare", "pre-e8:pre-e8"]);
      } catch (error) {
        threw = /must differ/.test(String(error?.message ?? ""));
      }
      check(threw, "parseArgs rejects baseline === candidate");
    }
    {
      let threw = false;
      try {
        parseArgs(["--variants", "pre-e8", "--compare", "pre-e8:e8-a"]);
      } catch (error) {
        threw = /not in --variants/.test(String(error?.message ?? ""));
      }
      check(threw, "parseArgs rejects unselected comparison endpoint");
    }
    {
      let threw = false;
      try {
        parseArgs(["--variants", "pre-e8,pre-e8"]);
      } catch (error) {
        threw = /duplicate/.test(String(error?.message ?? ""));
      }
      check(threw, "parseArgs rejects duplicate variants");
    }
    {
      let threw = false;
      try {
        parseArgs(["--scenarios", "hint,hint"]);
      } catch (error) {
        threw = /duplicate/.test(String(error?.message ?? ""));
      }
      check(threw, "parseArgs rejects duplicate scenarios");
    }
    {
      let threw = false;
      try {
        parseArgs(["--compare", "pre-e8:e8-a", "--compare", "pre-e8:e8-a"]);
      } catch (error) {
        threw = /duplicate comparison/.test(String(error?.message ?? ""));
      }
      check(threw, "parseArgs rejects duplicate comparisons");
    }
    {
      let threw = false;
      try {
        parseArgs(["--analyze", "/tmp/e8/export.json"]);
      } catch (error) {
        threw = /requires explicit --variant and --scenario/.test(
          String(error?.message ?? ""),
        );
      }
      check(threw, "parseArgs requires analyze variant/scenario");
    }

    check(median([1, 2]) === 1.5, "median N=2");
    check(median([3, 1, 2]) === 2, "median N=3");
    check(pairThreshold(2) === 2, "threshold N=2");
    check(pairThreshold(3) === 2, "threshold N=3");

    {
      const zeroReport = buildReport({
        runs: [run],
        failures: [],
        attempts: [],
        comparisons: [{ baseline: "pre-e8", candidate: "e8-a" }],
        meta: {},
        scenarios: ["hint"],
      });
      check(
        zeroReport.comparisonErrors.length === 1 &&
          /0 pairs/.test(zeroReport.comparisonErrors[0]),
        "zero-pair comparison error",
      );
    }

    {
      const attemptReport = buildReport({
        runs: [run],
        failures: [],
        attempts: [
          {
            scenario: "hint",
            rep: 1,
            variant: "e8-a",
            attempt: 1,
            status: "invalid",
            sessionID: "ses_attempt",
            projectDir: "/tmp/e8/project",
            errors: ["bad | value\nsecond line"],
          },
          {
            scenario: "hint",
            rep: 1,
            variant: "e8-a",
            attempt: 2,
            status: "valid",
            sessionID: "ses_valid",
            projectDir: "/tmp/e8/project-2",
            errors: [],
          },
        ],
        comparisons: [{ baseline: "pre-e8", candidate: "e8-a" }],
        meta: { preE8Ref: PRE_E8_REF, e8ARef: E8_A_REF },
        scenarios: ["hint"],
      });
      const rendered = renderReport(attemptReport);
      check(
        rendered.includes("### Attempt history") &&
          rendered.includes("bad \\| value second line") &&
          rendered.includes("discarded attempts are listed"),
        "attempt history rendering",
      );
      check(!rendered.includes("No failed runs."), "no false clean claim");
      check(
        rendered.includes(`- Pre-E8 ref: ${PRE_E8_REF}`) &&
          rendered.includes(`- E8-A ref: ${E8_A_REF}`),
        "report metadata refs",
      );
      check(
        rendered.includes("computed from those per-call rows"),
        "computed total label",
      );
    }

    {
      const cleanReport = buildReport({
        runs: [run],
        failures: [],
        attempts: [
          {
            scenario: "hint",
            rep: 1,
            variant: "e8-a",
            attempt: 1,
            status: "valid",
            errors: [],
          },
        ],
        comparisons: [{ baseline: "pre-e8", candidate: "e8-a" }],
        meta: {},
        scenarios: ["hint"],
      });
      check(
        renderReport(cleanReport).includes("No failed runs."),
        "clean attempt history claim",
      );
    }

    const parsed = parseJsonLines(
      'progress: working\n{"type":"text","text":"ok"}\nnot json\n',
    );
    check(parsed.length === 1 && parsed[0].type === "text", "parseJsonLines");
    check(isDirtySrc("") === false, "clean src");
    check(isDirtySrc(" M src/index.ts") === true, "dirty src");
    check(isSessionID("ses_abc") === true, "session id accepted");
    check(isSessionID("abc") === false, "session id prefix required");
    check(isSessionID(null) === false, "session id null rejected");
    check(
      tableCell("a | b\nc") === "a \\| b c",
      "table cell escapes pipes and newlines",
    );
    check(
      fileURIs({
        files: [
          { source: { type: "uri", uri: "file:///export.md" } },
          { uri: "file:///plugin.md" },
          "file:///string.md",
        ],
      }).join(",") === "file:///export.md,file:///plugin.md,file:///string.md",
      "fileURIs accepts export and plugin attachment shapes",
    );

    console.log("self-test ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function dryRun(opts) {
  const out = resolve(opts.out);
  await ensureIsolatedRoots(out);

  const variantDirs = new Map();
  for (const variant of opts.variants) {
    const dest = join(out, "variants", variant);
    const jsDir = await sourceFor(variant, dest);
    variantDirs.set(variant, jsDir);
  }

  for (const scenario of opts.scenarios) {
    for (const variant of opts.variants) {
      const projectDir = join(out, "dry", `${scenario}-${variant}`);
      const salt = makeSalt(`dry:${scenario}:${variant}:${projectDir}`);
      await prepareProject(
        projectDir,
        variantDirs.get(variant),
        scenario,
        salt,
      );
      if (existsSync(join(projectDir, LOAD_MARKER))) {
        throw new Error(`dry-run unexpectedly created ${LOAD_MARKER}`);
      }
      console.log(`dry-run ok: ${scenario}/${variant}`);
    }
  }
}

const ANALYZE_USAGE =
  "Usage: node scripts/e8-cache-measure.mjs --analyze <export.json> --variant <pre-e8|e8-a> --scenario <hint|status|control> [--project <dir>]";

async function analyzeMode(opts) {
  if (!opts.variant || !opts.scenario) {
    throw new Error(
      `--analyze requires explicit --variant and --scenario\n${ANALYZE_USAGE}`,
    );
  }
  const text = await readFile(resolve(opts.analyze), "utf8");
  const data = parseJsonObject(text);
  const projectDir = opts.project ? resolve(opts.project) : null;
  const run = analyzeExport(data, {
    scenario: opts.scenario,
    rep: 0,
    variant: opts.variant,
    attempt: 1,
    sessionID: data?.info?.id ?? null,
    projectDir,
    salt: null,
    model: data?.info?.model
      ? `${data.info.model.providerID}/${data.info.model.id}`
      : null,
    requestedModel: opts.modelProvided ? opts.model : null,
    briefHashBefore: null,
    briefHashAfter: null,
    briefLineCount: null,
    rawPath: resolve(opts.analyze),
  });
  const validation = validateRun(
    run,
    data,
    projectDir,
    opts.variant,
    opts.scenario,
    { requireBriefHashes: false },
  );
  run.validationErrors = validation.errors;
  run.validationNotChecked = validation.notChecked;
  run.validationStatus = validationState(
    validation.errors,
    validation.notChecked,
  );
  run.validationComplete = run.validationStatus === "valid";
  if (run.validationStatus === "not-checked") {
    console.error(`validation incomplete: ${validation.notChecked.join("; ")}`);
  } else if (run.validationStatus === "invalid") {
    console.error(`validation failed: ${validation.errors.join("; ")}`);
  }
  console.log(JSON.stringify(run, null, 2));
}

function positiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function parseList(value, flag) {
  const items = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    throw new Error(`${flag} requires a non-empty comma-separated list`);
  }
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) {
      throw new Error(`${flag} contains a duplicate: ${item}`);
    }
    seen.add(item);
  }
  return items;
}

function parseCompare(value) {
  const parts = String(value)
    .split(":")
    .map((part) => part.trim());
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("--compare requires <baseline>:<candidate>");
  }
  return { baseline: parts[0], candidate: parts[1] };
}

function parseArgs(argv) {
  const opts = {
    selfTest: false,
    dryRun: false,
    analyze: null,
    run: false,
    out: resolve(
      "/tmp/opencode",
      `e8-cache-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
    model: DEFAULT_MODEL,
    modelProvided: false,
    reps: DEFAULT_REPS,
    scenarios: [...DEFAULT_SCENARIOS],
    variants: [...VARIANTS],
    variant: null,
    scenario: null,
    project: null,
    comparisons: [{ baseline: "pre-e8", candidate: "e8-a" }],
    paceMs: DEFAULT_PACE_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    attempts: DEFAULT_ATTEMPTS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepProjects: false,
    help: false,
  };

  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  let compareSeen = false;
  let variantsProvided = false;
  let scenariosProvided = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--self-test":
        opts.selfTest = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--run":
        opts.run = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--keep-projects":
        opts.keepProjects = true;
        break;
      case "--analyze":
        if (opts.analyze !== null) {
          throw new Error("--analyze may be specified only once");
        }
        opts.analyze = resolve(readValue(index, arg));
        index += 1;
        break;
      case "--out":
        opts.out = resolve(readValue(index, arg));
        index += 1;
        break;
      case "--model":
        opts.model = readValue(index, arg);
        opts.modelProvided = true;
        index += 1;
        break;
      case "--reps":
        opts.reps = positiveInt(readValue(index, arg), arg);
        index += 1;
        break;
      case "--scenarios":
        opts.scenarios = parseList(readValue(index, arg), arg);
        scenariosProvided = true;
        index += 1;
        break;
      case "--variants":
        opts.variants = parseList(readValue(index, arg), arg);
        variantsProvided = true;
        index += 1;
        break;
      case "--scenario":
        if (opts.scenario !== null) {
          throw new Error("--scenario may be specified only once");
        }
        opts.scenario = readValue(index, arg);
        index += 1;
        break;
      case "--variant":
        if (opts.variant !== null) {
          throw new Error("--variant may be specified only once");
        }
        opts.variant = readValue(index, arg);
        index += 1;
        break;
      case "--project":
        if (opts.project !== null) {
          throw new Error("--project may be specified only once");
        }
        opts.project = resolve(readValue(index, arg));
        index += 1;
        break;
      case "--compare":
        if (!compareSeen) {
          opts.comparisons = [];
          compareSeen = true;
        }
        opts.comparisons.push(parseCompare(readValue(index, arg)));
        index += 1;
        break;
      case "--pace-ms":
        opts.paceMs = nonNegativeInt(readValue(index, arg), arg);
        index += 1;
        break;
      case "--max-retries":
        opts.maxRetries = nonNegativeInt(readValue(index, arg), arg);
        index += 1;
        break;
      case "--attempts":
        opts.attempts = nonNegativeInt(readValue(index, arg), arg);
        index += 1;
        break;
      case "--timeout-ms":
        opts.timeoutMs = positiveInt(readValue(index, arg), arg);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (opts.help) return opts;

  const validateVariant = (variant, flag) => {
    if (UNIMPLEMENTED_VARIANTS.includes(variant)) {
      throw new Error(`${flag} ${variant} is not implemented until Task 7/8`);
    }
    if (!VARIANTS.includes(variant)) {
      throw new Error(`unknown variant: ${variant}`);
    }
  };
  const validateScenario = (scenario, flag) => {
    if (!ALL_SCENARIOS.includes(scenario)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  };

  for (const scenario of opts.scenarios) validateScenario(scenario, "scenario");
  for (const variant of opts.variants) validateVariant(variant, "variant");

  if (opts.analyze) {
    if (variantsProvided) {
      throw new Error(
        "--variants is not valid with --analyze; use --variant <name>",
      );
    }
    if (scenariosProvided) {
      throw new Error(
        "--scenarios is not valid with --analyze; use --scenario <name>",
      );
    }
    if (!opts.variant || !opts.scenario) {
      throw new Error(
        `--analyze requires explicit --variant and --scenario\n${ANALYZE_USAGE}`,
      );
    }
    validateVariant(opts.variant, "--variant");
    validateScenario(opts.scenario, "--scenario");
  } else {
    if (opts.variant) {
      throw new Error("--variant is only valid with --analyze");
    }
    if (opts.scenario) {
      throw new Error("--scenario is only valid with --analyze");
    }
    if (opts.project) {
      throw new Error("--project is only valid with --analyze");
    }
  }

  const comparisonKeys = new Set();
  for (const comparison of opts.comparisons) {
    if (comparison.baseline === comparison.candidate) {
      throw new Error(
        `comparison baseline and candidate must differ: ${comparison.baseline}`,
      );
    }
    for (const endpoint of [comparison.baseline, comparison.candidate]) {
      validateVariant(endpoint, "comparison endpoint");
      if (!opts.variants.includes(endpoint)) {
        throw new Error(
          `comparison endpoint ${endpoint} is not in --variants (${opts.variants.join(",")})`,
        );
      }
    }
    const key = `${comparison.baseline}:${comparison.candidate}`;
    if (comparisonKeys.has(key)) {
      throw new Error(`duplicate comparison: ${key}`);
    }
    comparisonKeys.add(key);
  }

  const modes = [
    opts.selfTest,
    opts.dryRun,
    opts.run,
    Boolean(opts.analyze),
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error("choose one of --self-test, --dry-run, --analyze, --run");
  }
  return opts;
}

function printHelp() {
  console.log(`E8 cache-placement measurement harness (dev-only)

Usage:
  node scripts/e8-cache-measure.mjs --self-test
  node scripts/e8-cache-measure.mjs --dry-run [options]
  node scripts/e8-cache-measure.mjs --analyze <export.json> --variant <name> --scenario <name> [--project <dir>]
  node scripts/e8-cache-measure.mjs --run [options]

Options:
  --self-test          Offline analyzer/self-test (no model calls)
  --dry-run            Prepare variants and fixtures (no model calls)
  --analyze <export>   Summarize and validate a saved opencode session export
  --variant <name>     Analyze variant: pre-e8 or e8-a (required with --analyze)
  --scenario <name>    Analyze scenario: hint, status, or control (required with --analyze)
  --project <dir>      Project directory for --analyze filesystem checks
  --run                Run the measured protocol
  --out <dir>          Output directory (default: /tmp/opencode/e8-cache-<timestamp>)
  --model <id>         Provider/model (default: ${DEFAULT_MODEL}); with --analyze,
                       checks the export model only when explicitly provided
  --reps <n>           Repetitions per scenario (default: ${DEFAULT_REPS})
  --scenarios <list>   Comma-separated scenarios (default: ${DEFAULT_SCENARIOS.join(",")})
  --variants <list>    Comma-separated variants (default: ${VARIANTS.join(",")}); only pre-e8 and e8-a are implemented
  --compare <a>:<b>    Pairing to report; repeatable (default: pre-e8:e8-a)
  --pace-ms <ms>       Minimum gap between model calls (default: ${DEFAULT_PACE_MS})
  --max-retries <n>    Extra whole-run attempts after a quota error (default: ${DEFAULT_MAX_RETRIES})
  --attempts <n>       Extra whole-run attempts after a validation failure (default: ${DEFAULT_ATTEMPTS})
  --timeout-ms <ms>    Per-CLI-call timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep-projects      Keep prepared project directories
  --help               Show this help

Retry isolation:
  runPrompt makes exactly one model call. A quota/provider error or a validation
  failure discards the whole attempt; a retry gets a fresh project, salt, and
  session. Total attempts per run: 1 + max(--max-retries, --attempts). Quota
  retries back off 5 s, 10 s, 20 s, then 30 s (capped at 30 s).

--analyze requires explicit --variant and --scenario and runs the full
validation gate. Without --project, the filesystem checks (load marker, brief
hash, read containment, alpha/beta reads) are reported as "not checked (no
projectDir)" and validationStatus is "not-checked", never "valid". With
--project but no before/after snapshots, the brief-hash check is also reported
as not checked.

The harness never makes a model call in --self-test or --dry-run.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.selfTest) {
    await selfTest();
    return;
  }
  if (opts.analyze) {
    await analyzeMode(opts);
    return;
  }
  if (opts.dryRun) {
    await dryRun(opts);
    return;
  }
  if (opts.run) {
    await runMeasurement(opts);
    return;
  }
  printHelp();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
