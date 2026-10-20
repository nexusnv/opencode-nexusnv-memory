import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireWriteLock } from "../src/lock.js";

const ROOT = resolve(import.meta.dirname!, "..");

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly done: Promise<{ code: number | null; stderr: string }>;
}

function spawnWorker(
  script: string,
  env: Record<string, string>,
): WorkerHandle {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, script)],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stderr: string }>(
    (resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code, stderr }));
    },
  );
  return { child, done };
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${path}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

function spawnHolder(root: string): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "test/fixtures/lock-holder.ts")],
      {
        cwd: ROOT,
        env: { ...process.env, MEMORY_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `lock holder did not become ready; stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, 10_000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("locked\n")) {
        clearTimeout(timer);
        resolvePromise(child);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `lock holder exited before ready: code=${code} stdout=${stdout} ` +
            `stderr=${stderr}`,
        ),
      );
    });
  });
}

describe("cross-process memory writes", () => {
  it("two child processes append without losing lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-xproc-"));
    const coord = await mkdtemp(join(tmpdir(), "memory-xproc-start-"));
    let a: WorkerHandle | undefined;
    let b: WorkerHandle | undefined;
    try {
      await writeFile(join(root, "decisions.md"), "");
      const startFile = join(coord, "start");
      a = spawnWorker("test/fixtures/append-worker.ts", {
        MEMORY_ROOT: root,
        WORKER_TAG: "alpha",
        WORKER_COUNT: "15",
        WORKER_READY: join(coord, "alpha.ready"),
        WORKER_START: startFile,
      });
      b = spawnWorker("test/fixtures/append-worker.ts", {
        MEMORY_ROOT: root,
        WORKER_TAG: "beta",
        WORKER_COUNT: "15",
        WORKER_READY: join(coord, "beta.ready"),
        WORKER_START: startFile,
      });
      const ready = Promise.all([
        waitForFile(join(coord, "alpha.ready")),
        waitForFile(join(coord, "beta.ready")),
      ]);
      const earlyExit = Promise.all([
        a.done.then((result) => {
          if (result.code !== 0) {
            throw new Error(
              `alpha exited before start: ${result.code} ${result.stderr}`,
            );
          }
        }),
        b.done.then((result) => {
          if (result.code !== 0) {
            throw new Error(
              `beta exited before start: ${result.code} ${result.stderr}`,
            );
          }
        }),
      ]);
      await Promise.race([ready, earlyExit]);
      await writeFile(startFile, "go\n");
      const [ra, rb] = await Promise.all([a.done, b.done]);
      expect(ra.code, ra.stderr).toBe(0);
      expect(rb.code, rb.stderr).toBe(0);
      const text = await readFile(join(root, "decisions.md"), "utf8");
      for (const tag of ["alpha", "beta"]) {
        for (let i = 0; i < 15; i += 1) {
          expect(text).toContain(`- ${tag}-${i}`);
        }
      }
      expect(
        text.split("\n").filter((line) => line.startsWith("- ")),
      ).toHaveLength(30);
    } finally {
      a?.child.kill("SIGKILL");
      b?.child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
      await rm(coord, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "SIGKILL recovery: the next writer takes over the dead holder's lock",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-xproc-lock-"));
      let holder: ChildProcess | undefined;
      try {
        holder = await spawnHolder(root);
        await expect(
          acquireWriteLock(root, { timeoutMs: 150, pollMs: 10 }),
        ).rejects.toThrow(/another OpenCode process is writing memory/);
        const closed = new Promise<void>((resolvePromise) => {
          holder!.once("close", () => resolvePromise());
        });
        holder.kill("SIGKILL");
        await closed;
        const release = await acquireWriteLock(root, { timeoutMs: 3_000 });
        await release();
        expect(holder.exitCode ?? holder.signalCode).toBeTruthy();
      } finally {
        holder?.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
