import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tarball = process.argv[2];
if (tarball === undefined) {
  throw new Error("usage: smoke-package.mjs <package.tgz>");
}
const absolute = resolve(tarball);
const expected = JSON.parse(execFileSync("tar", ["-xOf", absolute, "package/package.json"], { encoding: "utf8" }));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const directory = mkdtempSync(join(tmpdir(), "fastify-observability-smoke-"));
try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync(
    pnpm,
    [
      "add",
      "--ignore-workspace",
      "--ignore-scripts",
      "fastify@5.10.0",
      pathToFileURL(absolute).href,
      "typescript@7.0.2",
      "@types/node@24.13.3",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  writeFileSync(
    join(directory, "smoke.mjs"),
    `import Fastify, { LogController } from "fastify";
import plugin, { createRequestIdGenerator, fastifyObservability } from "fastify-observability";
if (plugin !== fastifyObservability) throw new Error("default and named plugins differ");
const app = Fastify({ logger: false, requestIdHeader: false, genReqId: createRequestIdGenerator(), logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }) });
await app.register(plugin);
app.get("/", request => request.observability);
const response = await app.inject({ url: "/", headers: { "x-request-id": "smoke-id" } });
if (response.statusCode !== 200 || response.headers["x-request-id"] !== "smoke-id") throw new Error("runtime smoke failed");
await app.close();
`,
  );
  execFileSync(process.execPath, [join(directory, "smoke.mjs")], { cwd: directory, stdio: "inherit" });
  writeFileSync(
    join(directory, "types.ts"),
    `import type { FastifyInstance } from "fastify";
import plugin, { type AccessLogLevel, type RequestObservability } from "fastify-observability";
const level: AccessLogLevel = "debug";
const register = (app: FastifyInstance) => app.register(plugin, { levelForStatus: () => level });
const read = (value: RequestObservability) => value.requestId;
void register; void read;
`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
        noEmit: true,
        types: ["node"],
      },
      include: ["types.ts"],
    }),
  );
  execFileSync(pnpm, ["exec", "tsc", "--project", "tsconfig.json"], { cwd: directory, stdio: "inherit" });
  const installed = JSON.parse(
    readFileSync(join(directory, "node_modules/fastify-observability/package.json"), "utf8"),
  );
  if (installed.name !== expected.name || installed.version !== expected.version) {
    throw new Error("clean consumer resolved the wrong package version");
  }
} finally {
  rmSync(directory, { force: true, recursive: true });
}
process.stdout.write("clean runtime and type consumer verified\n");
