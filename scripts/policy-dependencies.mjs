import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtime = Object.keys(packageJson.dependencies ?? {});
const peers = Object.keys(packageJson.peerDependencies ?? {});

if (runtime.length !== 1 || runtime[0] !== "fastify-plugin") {
  throw new Error(`unexpected runtime dependencies: ${runtime.join(", ")}`);
}
if (peers.length !== 1 || peers[0] !== "fastify") {
  throw new Error(`unexpected peer dependencies: ${peers.join(", ")}`);
}

const forbidden = ["@fastify/request-context", "@opentelemetry", "pino", "prom-client"];
const allNames = [...runtime, ...peers, ...Object.keys(packageJson.devDependencies ?? {})];
for (const name of allNames) {
  if (forbidden.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))) {
    throw new Error(`forbidden direct dependency: ${name}`);
  }
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const ignored = spawnSync(pnpm, ["ignored-builds"], { encoding: "utf8" });
if (ignored.status !== 0 || !ignored.stdout.includes("None")) {
  process.stderr.write(ignored.stdout);
  process.stderr.write(ignored.stderr);
  throw new Error("dependency build-script policy has unresolved ignored builds");
}

process.stdout.write("dependency policy verified\n");
