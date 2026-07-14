import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

const tarball = process.argv[2];
if (tarball === undefined || !tarball.endsWith(".tgz")) {
  throw new Error("usage: check-package.mjs <package.tgz>");
}
const absolute = resolve(tarball);
const entries = execFileSync("tar", ["-tzf", absolute], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const topLevel = new Set(["package/package.json", "package/README.md", "package/LICENSE", "package/CHANGELOG.md"]);
for (const entry of entries) {
  if (!entry.startsWith("package/dist/") && !topLevel.has(entry)) {
    throw new Error(`unexpected tarball entry: ${entry}`);
  }
  if (entry.includes("..") || entry.startsWith("/")) {
    throw new Error(`unsafe tarball entry: ${entry}`);
  }
}
for (const required of [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/CHANGELOG.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/index.js.map",
  "package/dist/index.d.ts.map",
]) {
  if (!entries.includes(required)) {
    throw new Error(`missing tarball entry: ${required}`);
  }
}
const metadata = JSON.parse(execFileSync("tar", ["-xOf", absolute, "package/package.json"], { encoding: "utf8" }));
if (
  metadata.name !== "fastify-observability" ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(metadata.version) ||
  metadata.private === true
) {
  throw new Error("packed package identity is incorrect");
}
if (basename(absolute) !== `fastify-observability-${metadata.version}.tgz`) {
  throw new Error("tarball filename does not match packed identity");
}
if (metadata.engines?.node !== "24" || metadata.peerDependencies?.fastify !== "^5.10.0") {
  throw new Error("packed compatibility metadata is incorrect");
}
if (Object.keys(metadata.dependencies ?? {}).join(",") !== "fastify-plugin") {
  throw new Error("packed runtime dependency boundary is incorrect");
}
for (const entry of entries.filter((value) => value.endsWith(".map"))) {
  const content = execFileSync("tar", ["-xOf", absolute, entry], { encoding: "utf8" });
  if (content.includes(process.cwd()) || content.includes("/Users/") || content.includes("C:\\")) {
    throw new Error(`source map exposes an absolute local path: ${entry}`);
  }
}
process.stdout.write(`package contents verified: ${basename(absolute)} (${entries.length} files)\n`);
