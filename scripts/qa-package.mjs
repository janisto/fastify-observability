import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
const tarball = arguments_[0];
if (tarball === undefined || arguments_.length !== 1) {
  throw new Error("usage: pnpm qa:package -- <package.tgz>");
}
const absolute = resolve(tarball);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commands = [
  [process.execPath, [fileURLToPath(new URL("./check-package.mjs", import.meta.url)), absolute]],
  [pnpm, ["exec", "publint", "run", absolute, "--strict"]],
  [pnpm, ["exec", "attw", absolute, "--profile", "esm-only"]],
  [process.execPath, [fileURLToPath(new URL("./smoke-package.mjs", import.meta.url)), absolute]],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`package QA command failed: ${command} ${args.join(" ")}`);
  }
}
