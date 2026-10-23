import { acquireWriteLock } from "../../src/lock.js";

const root = process.env.MEMORY_ROOT;
if (!root) throw new Error("lock-holder requires MEMORY_ROOT");
const release = await acquireWriteLock(root, { timeoutMs: 10_000 });
process.stdout.write("locked\n");
const stop = async (): Promise<void> => {
  await release();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
setInterval(() => undefined, 1_000);
