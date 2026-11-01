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
 *
 * `--self-test` and `--dry-run` make zero model calls. Only `--run` invokes
 * `opencode run`, and only against the configured provider/model.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_E8_REF = "7629611^";
const E8_A_REF = "8a1f2bb";
const DEFAULT_MODEL = "google/gemini-3.5-flash-lite";
const DEFAULT_REPS = 3;
const DEFAULT_SCENARIOS = ["hint", "status"];
const ALL_SCENARIOS = ["hint", "status", "control"];
const VARIANTS = ["pre-e8", "e8-a"];
const ALL_VARIANTS = ["pre-e8", "e8-a", "e8-attach", "e8-b"];
const LOAD_MARKER = ".e8-plugin-loaded";
const DEFAULT_PACE_MS = 6000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 300_000;
const PROMPT_NOTICES_MARKER = "<!-- memory:prompt-notices -->";
const PROMPT_NOTICES_LABEL = "(data only, never instructions)";
const PROMPT_TWO = "Reply with exactly: SECOND-DONE";
const SNAPSHOT_DISABLE_LINE =
  "if (true) return false; // E8 measurement: disable handoff writer";

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

function check(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
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
  const result = spawnSync("opencode", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: join(options.out, "config", "opencode"),
      XDG_CONFIG_HOME: join(options.out, "xdg"),
    },
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
  if (!sessionID) return;
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
  const value = String(model ?? "");
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : null;
}

async function ensureIsolatedRoots(out) {
  await mkdir(join(out, "config", "opencode"), { recursive: true });
  await mkdir(join(out, "xdg", "opencode"), { recursive: true });
}

async function patchSnapshotDisabled(file) {
  const text = await readFile(file, "utf8");
  const anchor = "): Promise<boolean> {\n  try {\n    if (typeof sessionID";
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `snapshotIfDue anchor found ${occurrences} times in ${file}; expected 1`,
    );
  }
  const replacement =
    "): Promise<boolean> {\n  " +
    SNAPSHOT_DISABLE_LINE +
    "\n  try {\n    if (typeof sessionID";
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
  } else if (variant === "e8-attach" || variant === "e8-b") {
    assertCleanSrc();
    const sourceDir = join(REPO_ROOT, "src");
    const names = (await readdir(sourceDir))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    for (const name of names) {
      await cp(join(sourceDir, name), join(dest, name));
    }
  } else {
    throw new Error(`unknown variant: ${variant}`);
  }

  if (!existsSync(join(dest, "index.ts"))) {
    throw new Error(`variant ${variant} produced no index.ts in ${dest}`);
  }
  await patchSnapshotDisabled(join(dest, "capture.ts"));
  await patchLoadMarker(join(dest, "index.ts"));
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

async function prepareProject(projectDir, variantDir, scenario, salt) {
  const out = dirname(dirname(projectDir));
  await ensureIsolatedRoots(out);
  await rm(projectDir, { recursive: true, force: true });

  const pluginDir = join(projectDir, ".opencode", "plugins", "memory");
  const memoryDir = join(projectDir, ".opencode", "memory");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(memoryDir, "handoffs"), { recursive: true });

  const pluginFiles = (await readdir(variantDir))
    .filter((name) => name.endsWith(".ts"))
    .sort();
  for (const name of pluginFiles) {
    await cp(join(variantDir, name), join(pluginDir, name));
  }
  if (!existsSync(join(pluginDir, "index.ts"))) {
    throw new Error(`variant ${variantDir} has no index.ts`);
  }

  const config = {
    plugins: ["./plugins/memory"],
    permissions: [
      { action: "memory_write", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
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

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt += 1) {
    await pace(opts.paceMs);
    const result = runCli(args, {
      cwd: projectDir,
      out: opts.out,
      timeoutMs: opts.timeoutMs,
    });
    const events = parseJsonLines(result.stdout);
    const error = events.find((event) => event?.type === "error");
    const combined = `${result.stdout}\n${result.stderr}`;
    if ((error || result.status !== 0) && isQuotaError(combined)) {
      if (attempt > opts.maxRetries) {
        throw new Error(
          `quota retries exhausted: ${error?.error?.message ?? String(result.stderr).slice(-2000)}`,
        );
      }
      const wait = [5000, 10000, 20000, 30000][attempt - 1] ?? 30000;
      console.warn(`[pace] quota error; retrying in ${wait} ms`);
      await new Promise((resolveWait) => setTimeout(resolveWait, wait));
      continue;
    }
    if (result.status !== 0) {
      throw new Error(
        `opencode run failed (${result.status}): ${String(result.stderr).slice(-2000)}\n${String(result.stdout).slice(-4000)}`,
      );
    }
    const session = sessionID ?? sessionIDFromEvents(events);
    if (!session) throw new Error("opencode run produced no sessionID");
    return { sessionID: session, stdout: result.stdout, stderr: result.stderr };
  }
  throw new Error("opencode run exhausted retries without a result");
}

async function runOne({
  scenario,
  rep,
  variant,
  attempt,
  variantDir,
  model,
  opts,
}) {
  const out = resolve(opts.out);
  const projectDir = join(
    out,
    "projects",
    `${scenario}-${variant}-r${rep}-a${attempt}`,
  );
  const salt = makeSalt(
    `${scenario}:${variant}:${rep}:${attempt}:${projectDir}`,
  );
  await prepareProject(projectDir, variantDir, scenario, salt);

  const memoryDir = join(projectDir, ".opencode", "memory");
  const briefFiles = [
    join(memoryDir, "activeContext.md"),
    join(memoryDir, "INDEX.md"),
    ...(await readdir(join(memoryDir, "handoffs")))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(memoryDir, "handoffs", name)),
  ];
  const readBriefTexts = async () =>
    Promise.all(
      briefFiles.map(async (file) => (await readFile(file)).toString("utf8")),
    );
  const hashTexts = (texts) =>
    createHash("sha256").update(texts.join("\n")).digest("hex");

  const briefTextsBefore = await readBriefTexts();
  const briefLineCount = briefTextsBefore.join("\n").split("\n").length;
  const briefHashBefore = hashTexts(briefTextsBefore);
  let sessionID = null;
  try {
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
    const briefHashAfter = hashTexts(await readBriefTexts());
    const rawPath = join(out, "raw", `${scenario}-${variant}-r${rep}.json`);
    const run = analyzeExport(exportData, {
      scenario,
      rep,
      variant,
      attempt,
      sessionID,
      projectDir,
      salt,
      model,
      briefHashBefore,
      briefHashAfter,
      briefLineCount,
      rawPath,
    });
    run.validationErrors = validateRun(
      run,
      exportData,
      projectDir,
      variant,
      scenario,
    );
    const savePath =
      run.validationErrors.length === 0
        ? rawPath
        : join(
            out,
            "raw",
            `invalid-${scenario}-${variant}-r${rep}-a${attempt}.json`,
          );
    run.rawPath = savePath;
    await writeFile(savePath, `${JSON.stringify(exportData, null, 2)}\n`);
    return { run, errors: run.validationErrors, projectDir };
  } catch (error) {
    if (sessionID) error.sessionID = sessionID;
    throw error;
  }
}

async function runMeasurement(opts) {
  assertCleanSrc();

  const out = resolve(opts.out);
  await ensureIsolatedRoots(out);
  await mkdir(join(out, "raw"), { recursive: true });
  await mkdir(join(out, "projects"), { recursive: true });

  const meta = {
    generatedAt: new Date().toISOString(),
    provider: providerFromModel(opts.model),
    model: opts.model,
    accountTier: "Google AI Studio Free Tier",
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
    await sourceFor(variant, dest);
    variantDirs.set(variant, dest);
  }

  const runs = [];
  const failures = [];

  for (let rep = 1; rep <= opts.reps; rep += 1) {
    for (const scenario of opts.scenarios) {
      for (const variant of opts.variants) {
        const attemptFailures = [];
        let succeeded = false;

        for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
          const projectDir = join(
            out,
            "projects",
            `${scenario}-${variant}-r${rep}-a${attempt}`,
          );
          try {
            const result = await runOne({
              scenario,
              rep,
              variant,
              attempt,
              variantDir: variantDirs.get(variant),
              model: opts.model,
              opts,
            });
            if (result.errors.length === 0) {
              runs.push(result.run);
              succeeded = true;
              if (!opts.keepProjects) {
                await rm(projectDir, { recursive: true, force: true });
              }
              break;
            }
            const error = result.errors.join("; ");
            attemptFailures.push({
              attempt,
              error,
              validationErrors: result.errors,
              sessionID: result.run.sessionID,
              projectDir,
              rawPath: result.run.rawPath,
            });
            console.warn(
              `[invalid] ${scenario}/${variant} rep ${rep} attempt ${attempt}: ${error}`,
            );
            deleteSession(result.run.sessionID, out, opts.timeoutMs);
            if (!opts.keepProjects) {
              await rm(projectDir, { recursive: true, force: true });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            attemptFailures.push({
              attempt,
              error: message,
              validationErrors: [],
              sessionID: error?.sessionID ?? null,
              projectDir,
              rawPath: null,
            });
            console.warn(
              `[failed] ${scenario}/${variant} rep ${rep} attempt ${attempt}: ${message}`,
            );
            if (error?.sessionID) {
              deleteSession(error.sessionID, out, opts.timeoutMs);
            }
            if (!opts.keepProjects) {
              await rm(projectDir, { recursive: true, force: true });
            }
          }
        }

        if (!succeeded) {
          const last = attemptFailures[attemptFailures.length - 1];
          failures.push({
            scenario,
            rep,
            variant,
            attempt: last?.attempt ?? null,
            error: attemptFailures
              .map((failure) => `attempt ${failure.attempt}: ${failure.error}`)
              .join(" | "),
            validationErrors: last?.validationErrors ?? [],
            sessionID: last?.sessionID ?? null,
            projectDir: last?.projectDir ?? null,
            rawPath: last?.rawPath ?? null,
            attempts: attemptFailures,
          });
        }
      }
    }
  }

  const report = buildReport({
    runs,
    failures,
    comparisons: opts.comparisons,
    meta,
    scenarios: opts.scenarios,
  });
  const summaryPath = join(out, "summary.json");
  const reportPath = join(out, "summary.md");
  await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, renderReport(report));

  console.log(
    `measurement complete: ${runs.length} valid runs, ${failures.length} failures, ${report.pairs.length} pairs`,
  );
  console.log(`summary: ${summaryPath}`);
  console.log(`report: ${reportPath}`);
}

function noticeInfo(text) {
  const value = String(text ?? "");
  const lines = value.split("\n");
  const noticeLines = lines.filter(
    (line) => line.startsWith("[memory]") || line.startsWith("[memory-hint]"),
  );
  return {
    marker: value.includes(PROMPT_NOTICES_MARKER),
    label: value.includes(PROMPT_NOTICES_LABEL),
    hint: lines.some((line) => line.startsWith("[memory-hint]")),
    status: lines.some(
      (line) =>
        line.startsWith("[memory]") && !line.startsWith("[memory] handoff:"),
    ),
    handoff: lines.some((line) => line.startsWith("[memory] handoff:")),
    markerCount: value.split(PROMPT_NOTICES_MARKER).length - 1,
    lineCount: noticeLines.length,
  };
}

function tokensOf(message) {
  const tokens = message?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(tokens.cache?.read),
    cacheWrite: num(tokens.cache?.write),
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
  const prompt1Messages = [];
  const prompt2Messages = [];
  const userMessages = [];
  let bucket = null;

  for (const message of messages) {
    if (message?.type === "user") {
      userMessages.push(message);
      bucket =
        userMessages.length === 1
          ? prompt1Messages
          : userMessages.length === 2
            ? prompt2Messages
            : null;
      continue;
    }
    if (bucket && message?.type === "assistant") bucket.push(message);
  }

  const prompt1Text =
    typeof userMessages[0]?.text === "string" ? userMessages[0].text : "";
  const prompt2Text =
    typeof userMessages[1]?.text === "string" ? userMessages[1].text : "";

  const prompt1Calls = callsFromMessages(prompt1Messages, 1);
  const prompt2Calls = callsFromMessages(prompt2Messages, 2);
  const calls = [...prompt1Calls, ...prompt2Calls];
  calls.forEach((call, index) => {
    call.index = index;
  });

  const prompt1ToolParts = prompt1Messages.flatMap(toolPartsOf);
  const allToolParts = messages
    .filter((message) => message?.type === "assistant")
    .flatMap(toolPartsOf);
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
  const rawP1LaterIncrementalRead =
    laterCacheRead - firstCacheRead * laterCallCount;
  const p1LaterIncrementalRead = Math.max(0, rawP1LaterIncrementalRead);

  const prompt2FirstCall = prompt2Calls[0];
  const rawP2FirstIncrementalRead =
    (prompt2FirstCall?.cacheRead ?? 0) - firstCacheRead;
  const p2FirstIncrementalRead = Math.max(0, rawP2FirstIncrementalRead);

  const notice = noticeInfo(prompt1Text);
  const briefHashBefore = meta.briefHashBefore ?? null;
  const briefHashAfter = meta.briefHashAfter ?? null;
  const briefLineCount = meta.briefLineCount ?? null;

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
    exportModel: data?.info?.model ?? null,
    providerID: data?.info?.model?.providerID ?? null,
    prompts: [
      { prompt: 1, text: prompt1Text },
      { prompt: 2, text: prompt2Text },
    ],
    calls,
    prompt1Calls,
    prompt2Calls,
    prompt1ToolParts: prompt1ToolParts.map((part) => part.name),
    prompt1ToolPartDetails: prompt1ToolParts,
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
    sessionTotal: totalOf(calls),
    notice,
    noticeLines: notice.lineCount,
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
    rawPath: meta.rawPath ?? null,
  };
}

function validateRun(run, data, projectDir, variant, scenario) {
  const errors = [];

  if (!Array.isArray(data?.messages) || data.messages.length === 0) {
    errors.push("export has no messages");
  }
  if (projectDir) {
    if (!existsSync(join(projectDir, LOAD_MARKER))) {
      errors.push(`load marker missing: ${LOAD_MARKER}`);
    }
  }

  if (run.prompt1Calls.length < 2) {
    errors.push("prompt 1 has fewer than 2 assistant calls");
  }
  if (run.calls.length < 2) {
    errors.push("session has fewer than 2 assistant calls");
  }
  if (!run.prompt1First) {
    errors.push("prompt 1 has no assistant call with token usage");
  }
  if (!run.prompt2First) {
    errors.push("prompt 2 has no assistant call with token usage");
  }

  const readParts = (run.prompt1ToolPartDetails ?? []).filter(
    (part) => part.name === "read",
  );
  if (readParts.length < 2) {
    errors.push("prompt 1 has fewer than 2 read tool parts");
  }
  if (projectDir) {
    for (const name of ["alpha.txt", "beta.txt"]) {
      const target = resolve(projectDir, name);
      const found = readParts.some(
        (part) => part.path && resolve(projectDir, part.path) === target,
      );
      if (!found) errors.push(`prompt 1 did not read ${name}`);
    }
  }

  if ((run.skillToolParts ?? 0) > 0) errors.push("skill tool part appeared");
  if ((run.shellToolParts ?? 0) > 0) errors.push("shell tool part appeared");

  if (run.briefHashBefore !== null || run.briefHashAfter !== null) {
    if (run.briefHashBefore === null || run.briefHashAfter === null) {
      errors.push("brief hash missing");
    } else if (run.briefHashBefore !== run.briefHashAfter) {
      errors.push("brief hashes differ");
    }
  } else if (projectDir) {
    errors.push("brief hash missing");
  }

  const notice = run.notice ?? {};
  if (variant === "pre-e8") {
    if (notice.marker) errors.push("pre-E8 prompt has a notice marker");
    if ((run.noticeLines ?? 0) > 0) {
      errors.push("pre-E8 prompt has notice lines");
    }
  } else if (variant === "e8-a") {
    if (scenario === "control") {
      if (notice.marker) errors.push("control prompt has a notice marker");
      if ((run.noticeLines ?? 0) > 0) {
        errors.push("control prompt has notice lines");
      }
    } else {
      if (!notice.marker) errors.push("E8-A prompt has no notice marker");
      if (!notice.label) errors.push("E8-A prompt has no data-only label");
      if ((notice.markerCount ?? 0) !== 1) {
        errors.push(
          `E8-A prompt marker count is ${notice.markerCount ?? 0}, expected 1`,
        );
      }
      if (!notice.handoff) {
        errors.push("E8-A prompt has no [memory] handoff notice");
      }
      if (scenario === "hint" && !notice.hint) {
        errors.push("hint scenario has no [memory-hint] notice");
      }
      if (scenario === "status" && !notice.status) {
        errors.push("status scenario has no [memory] status notice");
      }
    }
  } else if (scenario === "control") {
    if (notice.marker) errors.push("control prompt has a notice marker");
    if ((run.noticeLines ?? 0) > 0) {
      errors.push("control prompt has notice lines");
    }
  }

  return errors;
}

function pairRuns(runs, baseline, candidate) {
  const validRuns = (runs ?? []).filter(
    (run) => (run?.validationErrors?.length ?? 0) === 0,
  );
  const groups = new Map();
  for (const run of validRuns) {
    const key = `${run.scenario}\u0000${run.rep}`;
    if (!groups.has(key)) groups.set(key, {});
    groups.get(key)[run.variant] = run;
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

function buildReport({ runs, failures, comparisons, meta, scenarios }) {
  const validRuns = (runs ?? []).filter(
    (run) => (run?.validationErrors?.length ?? 0) === 0,
  );
  const comparisonConfigs =
    comparisons && comparisons.length > 0
      ? comparisons
      : [{ baseline: "pre-e8", candidate: "e8-a" }];

  const results = comparisonConfigs.map((config, index) => {
    const pairs = pairRuns(validRuns, config.baseline, config.candidate);
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
  lines.push(
    `- Account tier: ${report.accountTier ?? "n/a"} (free tier; no billed-cost claim)`,
  );
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
  lines.push(`- Failures: ${report.failures.length}`);
  lines.push(`- Valid pairs (default comparison): ${report.pairs.length}`);
  lines.push("");
  if (report.failures.length > 0) {
    lines.push("| scenario | rep | variant | attempt | error |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const failure of report.failures) {
      lines.push(
        `| ${failure.scenario ?? "n/a"} | ${failure.rep ?? "n/a"} | ` +
          `${failure.variant ?? "n/a"} | ${failure.attempt ?? "n/a"} | ` +
          `${String(failure.error ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No failed runs.");
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
      "| scenario | rep | variant | p1 calls | p1 first hit | p1 later hit | p1 later cache read | p1 later adjusted | p2 first hit | p2 first cache read | p2 adjusted | p1 total tokens | p2 total tokens | notice lines | skill parts | brief hash match | marker |",
    );
    lines.push(
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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
          `${hashLabel(run)} | ${markerLabel(run)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Raw usage");
  lines.push("");
  lines.push(
    "- `summary.json` contains every per-call token row (`input`, `output`, `reasoning`, `cache.read`, `cache.write`, `promptTokens`, `cacheHitRate`, `uncachedTokens`).",
  );
  lines.push("- Per-run raw session exports are under `raw/`:");
  for (const run of report.runs) {
    lines.push(`  - \`${run.rawPath ?? "n/a"}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function selfTest() {
  const readPart = (path) => ({
    type: "tool",
    name: "read",
    state: { input: { path } },
  });
  const skillPart = () => ({
    type: "tool",
    name: "skill",
    state: { input: {} },
  });
  let messageNumber = 0;
  const assistant = (tokens, content = []) => ({
    type: "assistant",
    id: `msg_test_${(messageNumber += 1)}`,
    tokens,
    content,
  });
  const usage = (input, cacheRead, cacheWrite = 0) => ({
    input,
    output: 10,
    reasoning: 1,
    cache: { read: cacheRead, write: cacheWrite },
  });

  const e8Prompt1 = [
    "Context: auth-service login. Use the read tool to read /tmp/e8/alpha.txt, then use the read tool to read /tmp/e8/beta.txt. Then answer in one sentence.",
    "",
    `[memory] handoff: handoffs/2026-10-26-120000-abcdef.md (latest) ${PROMPT_NOTICES_MARKER} ${PROMPT_NOTICES_LABEL}`,
    '[memory-hint] Past decisions mention `auth-service`. Call memory_recall("decisions.md") for the why.',
  ].join("\n");

  const e8Export = {
    info: {
      id: "ses_e8_test",
      model: {
        id: "gemini-3.5-flash-lite",
        providerID: "google",
        variant: "default",
      },
      tokens: {},
    },
    messages: [
      { type: "user", text: e8Prompt1, files: [] },
      assistant(usage(100, 1000, 10), [readPart("/tmp/e8/alpha.txt")]),
      assistant(usage(50, 1500), [readPart("/tmp/e8/beta.txt")]),
      assistant(usage(20, 2000), [{ type: "text", text: "done" }]),
      { type: "user", text: PROMPT_TWO, files: [] },
      assistant(usage(10, 2500), [{ type: "text", text: "SECOND-DONE" }]),
    ],
  };

  const meta = {
    scenario: "hint",
    rep: 1,
    variant: "e8-a",
    attempt: 1,
    sessionID: "ses_e8_test",
    projectDir: "/tmp/e8/project",
    salt: "salt",
    model: DEFAULT_MODEL,
    briefHashBefore: "a",
    briefHashAfter: "a",
    briefLineCount: 7,
    rawPath: "/tmp/e8/raw.json",
  };
  const run = analyzeExport(e8Export, meta);
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

  const skillExport = structuredClone(e8Export);
  skillExport.messages[1].content.push(skillPart());
  const skillRun = analyzeExport(skillExport, { ...meta, variant: "e8-a" });
  check(skillRun.skillToolParts === 1, "skill tool part detected");

  const preExport = structuredClone(e8Export);
  preExport.messages[0].text =
    "Context: auth-service login. Use the read tool to read /tmp/e8/alpha.txt, then use the read tool to read /tmp/e8/beta.txt. Then answer in one sentence.";
  preExport.messages[2].tokens.cache.read = 1200;
  preExport.messages[3].tokens.cache.read = 1300;
  preExport.messages[5].tokens.cache.read = 2200;
  const preRun = analyzeExport(preExport, { ...meta, variant: "pre-e8" });
  check(!preRun.notice.marker, "pre-E8 has no marker");
  check(preRun.noticeLines === 0, "pre-E8 has no notice lines");

  preRun.validationErrors = [];
  run.validationErrors = [];
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
  check(pair.deltaPrompt2AdjustedRead === 300, "pair adjusted prompt 2 delta");

  const pooled = summarizePooled(pairs);
  check(pooled.pairs === 1, "pooled pair count");
  check(pooled.threshold === 1, "pooled threshold");
  check(pooled.deltaLaterAdjustedRead.median === 1000, "pooled adjusted later");
  check(pooled.deltaPrompt2AdjustedRead.median === 300, "pooled adjusted p2");
  check(pooled.deltaLaterHit.positive === 1, "pooled positive later");

  const parsed = parseJsonLines(
    'progress: working\n{"type":"text","text":"ok"}\nnot json\n',
  );
  check(parsed.length === 1 && parsed[0].type === "text", "parseJsonLines");
  check(isDirtySrc("") === false, "clean src");
  check(isDirtySrc(" M src/index.ts") === true, "dirty src");

  console.log("self-test ok");
}

async function dryRun(opts) {
  const out = resolve(opts.out);
  await ensureIsolatedRoots(out);

  const variantDirs = new Map();
  for (const variant of opts.variants) {
    const dest = join(out, "variants", variant);
    await sourceFor(variant, dest);
    variantDirs.set(variant, dest);
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

async function analyzeMode(opts) {
  const text = await readFile(resolve(opts.analyze), "utf8");
  const data = parseJsonObject(text);
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const prompt1Text =
    messages.find((message) => message?.type === "user")?.text ?? "";
  const notice = noticeInfo(prompt1Text);
  const variant = notice.marker ? "e8-a" : "pre-e8";
  const scenario = /auth-service/i.test(String(prompt1Text))
    ? "hint"
    : "status";
  const run = analyzeExport(data, {
    scenario,
    rep: 0,
    variant,
    attempt: 1,
    sessionID: data?.info?.id ?? null,
    projectDir: null,
    salt: null,
    model: data?.info?.model
      ? `${data.info.model.providerID}/${data.info.model.id}`
      : null,
    briefHashBefore: null,
    briefHashAfter: null,
    briefLineCount: null,
    rawPath: resolve(opts.analyze),
  });
  run.validationErrors = validateRun(run, data, null, variant, scenario);
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
  return [...new Set(items)];
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
    reps: DEFAULT_REPS,
    scenarios: [...DEFAULT_SCENARIOS],
    variants: [...VARIANTS],
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
        opts.analyze = resolve(readValue(index, arg));
        index += 1;
        break;
      case "--out":
        opts.out = resolve(readValue(index, arg));
        index += 1;
        break;
      case "--model":
        opts.model = readValue(index, arg);
        index += 1;
        break;
      case "--reps":
        opts.reps = positiveInt(readValue(index, arg), arg);
        index += 1;
        break;
      case "--scenarios":
        opts.scenarios = parseList(readValue(index, arg), arg);
        index += 1;
        break;
      case "--variants":
        opts.variants = parseList(readValue(index, arg), arg);
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
        opts.attempts = positiveInt(readValue(index, arg), arg);
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

  for (const scenario of opts.scenarios) {
    if (!ALL_SCENARIOS.includes(scenario)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  }
  for (const variant of opts.variants) {
    if (!ALL_VARIANTS.includes(variant)) {
      throw new Error(`unknown variant: ${variant}`);
    }
  }
  for (const comparison of opts.comparisons) {
    if (!ALL_VARIANTS.includes(comparison.baseline)) {
      throw new Error(`unknown comparison baseline: ${comparison.baseline}`);
    }
    if (!ALL_VARIANTS.includes(comparison.candidate)) {
      throw new Error(`unknown comparison candidate: ${comparison.candidate}`);
    }
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
  node scripts/e8-cache-measure.mjs --analyze <export.json>
  node scripts/e8-cache-measure.mjs --run [options]

Options:
  --self-test          Offline analyzer/self-test (no model calls)
  --dry-run            Prepare variants and fixtures (no model calls)
  --analyze <export>   Summarize a saved opencode session export
  --run                Run the measured protocol
  --out <dir>          Output directory (default: /tmp/opencode/e8-cache-<timestamp>)
  --model <id>         Provider/model (default: ${DEFAULT_MODEL})
  --reps <n>           Repetitions per scenario (default: ${DEFAULT_REPS})
  --scenarios <list>   Comma-separated scenarios (default: ${DEFAULT_SCENARIOS.join(",")})
  --variants <list>    Comma-separated variants (default: ${VARIANTS.join(",")})
  --compare <a>:<b>    Pairing to report; repeatable (default: pre-e8:e8-a)
  --pace-ms <ms>       Minimum gap between model calls (default: ${DEFAULT_PACE_MS})
  --max-retries <n>    Retries for a 429/quota error (default: ${DEFAULT_MAX_RETRIES})
  --attempts <n>       Attempts per run after validation failure (default: ${DEFAULT_ATTEMPTS})
  --timeout-ms <ms>    Per-CLI-call timeout (default: ${DEFAULT_TIMEOUT_MS})
  --keep-projects      Keep prepared project directories
  --help               Show this help

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
    selfTest();
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
