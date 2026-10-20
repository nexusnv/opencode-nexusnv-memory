import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWriteLock,
  WRITE_LOCK_CLAIM_FILE,
  WRITE_LOCK_FILE,
} from "../src/lock.js";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-lock-"));
}

describe("acquireWriteLock", () => {
  it("creates a PID record and releases it", async () => {
    const dir = await root();
    try {
      const release = await acquireWriteLock(dir, {
        pid: 4242,
        timeoutMs: 200,
      });
      expect(await readFile(join(dir, WRITE_LOCK_FILE), "utf8")).toBe("4242\n");
      await release();
      await expect(
        readFile(join(dir, WRITE_LOCK_FILE), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes over a lock whose PID is dead", async () => {
    const dir = await root();
    try {
      await writeFile(join(dir, WRITE_LOCK_FILE), "999999\n");
      const release = await acquireWriteLock(dir, {
        pid: 123,
        isAlive: () => false,
        timeoutMs: 500,
      });
      expect(await readFile(join(dir, WRITE_LOCK_FILE), "utf8")).toBe("123\n");
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a stale claim before taking over", async () => {
    const dir = await root();
    try {
      await writeFile(join(dir, WRITE_LOCK_FILE), "999999\n");
      await writeFile(join(dir, WRITE_LOCK_CLAIM_FILE), "999998\n");
      const release = await acquireWriteLock(dir, {
        pid: 321,
        isAlive: () => false,
        timeoutMs: 500,
      });
      expect(await readFile(join(dir, WRITE_LOCK_FILE), "utf8")).toBe("321\n");
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out with a clear message when a live holder keeps the lock", async () => {
    const dir = await root();
    try {
      await writeFile(join(dir, WRITE_LOCK_FILE), "777\n");
      await expect(
        acquireWriteLock(dir, {
          pid: 888,
          isAlive: (pid) => pid === 777,
          timeoutMs: 80,
          pollMs: 5,
        }),
      ).rejects.toThrow(/another OpenCode process is writing memory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers a malformed lock after the grace period", async () => {
    const dir = await root();
    try {
      const lock = join(dir, WRITE_LOCK_FILE);
      await writeFile(lock, "");
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      const release = await acquireWriteLock(dir, {
        pid: 909,
        isAlive: () => true,
        malformedGraceMs: 10,
        timeoutMs: 500,
      });
      expect(await readFile(lock, "utf8")).toBe("909\n");
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked lock record", async () => {
    const dir = await root();
    const outside = await mkdtemp(join(tmpdir(), "memory-lock-outside-"));
    try {
      await writeFile(join(outside, "record"), "123\n");
      await symlink(join(outside, "record"), join(dir, WRITE_LOCK_FILE));
      await expect(
        acquireWriteLock(dir, { pid: 456, timeoutMs: 100 }),
      ).rejects.toThrow(/non-regular lock record/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("release is idempotent and cannot drop a same-PID reacquire", async () => {
    const dir = await root();
    try {
      const first = await acquireWriteLock(dir, { pid: 111, timeoutMs: 100 });
      await first();
      const second = await acquireWriteLock(dir, { pid: 111, timeoutMs: 100 });
      await first();
      expect(await readFile(join(dir, WRITE_LOCK_FILE), "utf8")).toBe("111\n");
      await second();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names a same-process nested lock instead of blaming another process", async () => {
    const dir = await root();
    try {
      await writeFile(join(dir, WRITE_LOCK_FILE), "111\n");
      await expect(
        acquireWriteLock(dir, {
          pid: 111,
          isAlive: () => true,
          timeoutMs: 30,
          pollMs: 5,
        }),
      ).rejects.toThrow(/this process already holds the memory write lock/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not delete a winner's lock when two contenders race", async () => {
    const dir = await root();
    try {
      await writeFile(join(dir, WRITE_LOCK_FILE), "999999\n");
      const first = await acquireWriteLock(dir, {
        pid: 1,
        isAlive: () => false,
        timeoutMs: 500,
      });
      await expect(
        acquireWriteLock(dir, {
          pid: 2,
          // PID 1 is a live holder for this test; a dead-probe would take over.
          isAlive: (pid) => pid === 1,
          timeoutMs: 60,
          pollMs: 5,
        }),
      ).rejects.toThrow(/another OpenCode process is writing memory/);
      expect(await readFile(join(dir, WRITE_LOCK_FILE), "utf8")).toBe("1\n");
      await first();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
