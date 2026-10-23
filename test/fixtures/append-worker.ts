import { access, writeFile } from "node:fs/promises";
import { updateCapped } from "../../src/files.js";

const root = process.env.MEMORY_ROOT;
const tag = process.env.WORKER_TAG;
const readyFile = process.env.WORKER_READY;
const startFile = process.env.WORKER_START;
const count = Number.parseInt(process.env.WORKER_COUNT ?? "0", 10);
if (
  !root ||
  !tag ||
  !readyFile ||
  !startFile ||
  !Number.isInteger(count) ||
  count <= 0
) {
  throw new Error(
    "append-worker requires MEMORY_ROOT, WORKER_TAG, WORKER_READY, WORKER_START, WORKER_COUNT",
  );
}

// Start barrier: both workers signal readiness, the parent releases them
// together. The small updater delay widens the read-modify-write overlap so
// the test fails deterministically without a cross-process lock.
await writeFile(readyFile, "ready\n");
for (;;) {
  try {
    await access(startFile);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
for (let i = 0; i < count; i += 1) {
  await updateCapped("decisions.md", { memoryRoot: root }, async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return `${current}- ${tag}-${i}\n`;
  });
}
