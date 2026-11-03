/**
 * Pack-gate assertion: `npm pack` must produce a tarball that actually
 * contains the `exports` target. `npm pack --dry-run` only lists files, so
 * a packaging change that drops `src/index.ts` would pass CI while the
 * plugin host fails to import the published package.
 *
 * Usage: `node scripts/assert-pack.mjs <tarball.tgz>`
 * Never throws silently — exits non-zero with the missing path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/assert-pack.mjs <tarball.tgz>");
  process.exit(2);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const exports = pkg?.exports ?? {};
const targets = Object.entries(exports)
  .filter(([, value]) => typeof value === "string" && value.length > 0)
  .map(([name, value]) => ({ name, target: value }));
if (targets.length === 0) {
  console.error("package.json exports must contain at least one string target");
  process.exit(1);
}
if (!targets.some((entry) => entry.name === ".")) {
  console.error('package.json exports["."] must be a non-empty string');
  process.exit(1);
}
const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.length > 0);
for (const { name, target } of targets) {
  const want = `package/${target.replace(/^\.\//, "")}`;
  if (!files.includes(want)) {
    console.error(`packed tarball is missing exports["${name}"]: ${want}`);
    process.exit(1);
  }
}
if (!files.includes("package/package.json")) {
  console.error("packed tarball is missing package/package.json");
  process.exit(1);
}
console.log(
  `pack ok: ${targets.map((entry) => entry.target).join(", ")} present in ${tarball}`,
);
