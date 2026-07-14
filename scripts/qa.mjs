import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`QA command failed: ${command} ${args.join(" ")}`);
  }
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
run(pnpm, ["qa:source"]);
run(pnpm, ["clean:artifacts"]);
run(pnpm, ["pack", "--pack-destination", "artifacts"]);
const tarballs = readdirSync("artifacts").filter((entry) => entry.endsWith(".tgz"));
if (tarballs.length !== 1 || tarballs[0] === undefined) {
  throw new Error(`expected exactly one tarball, found ${tarballs.length}`);
}
run(pnpm, ["qa:package", "--", resolve("artifacts", tarballs[0])]);
