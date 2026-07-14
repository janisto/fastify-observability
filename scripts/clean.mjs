import { mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const allowed = new Set(["artifacts", "coverage", "dist"]);
const create = process.argv.includes("--create");
const paths = process.argv.slice(2).filter((value) => value !== "--create");

for (const path of paths) {
  if (!allowed.has(path) || basename(path) !== path) {
    throw new Error(`refusing to clean unexpected path: ${path}`);
  }
  const absolute = resolve(path);
  rmSync(absolute, { force: true, recursive: true });
  if (create) {
    mkdirSync(absolute, { recursive: true });
  }
}
