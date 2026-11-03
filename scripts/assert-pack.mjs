/**
 * Pack-gate assertion: `npm pack` must produce a tarball that actually
 * contains every string `exports` target. `npm pack --dry-run` only lists
 * files, so a packaging change that drops an export target (for example
 * `src/index.ts`) would pass CI while the plugin host fails to import the
 * published package. Non-string export entries fail the gate loudly instead
 * of being skipped silently.
 *
 * Usage: `node scripts/assert-pack.mjs <tarball.tgz>`
 * Never throws silently — exits non-zero naming the offending entry.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tarball = process.argv[2];
if (!tarball) {
  console.error("usage: node scripts/assert-pack.mjs <tarball.tgz>");
  process.exit(2);
}
const pkgPath = new URL("../package.json", import.meta.url);
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (error) {
  console.error(
    `pack gate error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const rawExports = pkg?.exports;
const describe = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

let targets;
if (typeof rawExports === "string") {
  // String shorthand: the whole package is the "." target.
  if (rawExports.length === 0) {
    console.error("package.json exports must be a non-empty string");
    process.exit(1);
  }
  targets = [{ name: ".", target: rawExports }];
} else if (
  rawExports !== null &&
  typeof rawExports === "object" &&
  !Array.isArray(rawExports)
) {
  targets = [];
  for (const [name, value] of Object.entries(rawExports)) {
    if (typeof value !== "string") {
      console.error(
        `package.json exports["${name}"] must be a string path, got ${describe(value)} (conditional exports are not supported by this gate)`,
      );
      process.exit(1);
    }
    if (value.length === 0) {
      console.error(`package.json exports["${name}"] must be a non-empty string`);
      process.exit(1);
    }
    targets.push({ name, target: value });
  }
} else {
  console.error(
    `package.json exports must be a string or an object map of string paths, got ${describe(rawExports)}`,
  );
  process.exit(1);
}
if (targets.length === 0) {
  console.error("package.json exports must contain at least one string target");
  process.exit(1);
}
if (!targets.some((entry) => entry.name === ".")) {
  console.error('package.json exports must define "." with a non-empty string target');
  process.exit(1);
}
let files;
try {
  files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.length > 0);
} catch (error) {
  console.error(
    `pack gate error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
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
