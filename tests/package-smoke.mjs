import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const modules = ["access", "context", "index", "logger", "plugin", "presets", "request-id", "trace", "types"];
const expectedPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  ...modules.flatMap((name) => [`dist/${name}.d.ts`, `dist/${name}.js`]),
].sort();

function execute(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

rmSync(artifacts, { force: true, recursive: true });
mkdirSync(artifacts, { recursive: true });

const packOutput = execute("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], root, true);
const packed = JSON.parse(packOutput);
assert.equal(packed.length, 1, "npm pack must produce exactly one artifact");
const [artifact] = packed;
assert.equal(artifact.name, "fastify-observability");
assert.equal(artifact.version, packageJson.version);
assert.match(artifact.integrity, /^sha512-/);
const packedPaths = artifact.files.map(({ path }) => path).sort();
assert.deepEqual(packedPaths, expectedPaths, "the npm artifact file set changed");

const readme = readFileSync(join(root, "README.md"), "utf8");
for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
  const destination = match[1];
  if (destination === undefined || destination.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(destination)) {
    continue;
  }
  const target = destination.split("#", 1)[0];
  assert.ok(
    target && packedPaths.includes(target),
    `README relative link target is absent from npm artifact: ${destination}`,
  );
}

const tarball = join(artifacts, artifact.filename);
const consumer = mkdtempSync(join(tmpdir(), "fastify-observability-package-"));

try {
  writeJson(join(consumer, "package.json"), {
    name: "fastify-observability-package-smoke",
    private: true,
    type: "module",
  });
  execute(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
      "fastify@5.10.0",
      "typescript@7.0.2",
      "@types/node@24.13.3",
    ],
    consumer,
  );

  writeJson(join(consumer, "tsconfig.json"), {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      strict: true,
      target: "ES2024",
      types: ["node"],
      verbatimModuleSyntax: true,
    },
    include: ["consumer.ts"],
  });
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  type ObservabilityLogger,
  type RequestObservability,
  type TraceContextLevel,
} from "fastify-observability";

const logger: ObservabilityLogger = createObservabilityLogger({ level: "silent" });
const traceContextLevel: TraceContextLevel = 2;
const child = logger.child({ component: "package-smoke" });
// @ts-expect-error canonical logger binding mutation is blocked at runtime
child.setBindings({ component: "changed" });
const app = Fastify({
  loggerInstance: logger,
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
});
await app.register(fastifyObservability, { traceContextLevel });
app.get("/", (request): RequestObservability => request.observability);
await app.close();
`,
  );
  writeFileSync(
    join(consumer, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { Writable } from "node:stream";
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  parseTraceparent,
  resolveTraceContextLevel,
} from "fastify-observability";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = "00-" + traceId + "-" + parentId + "-03";
assert.equal(resolveTraceContextLevel(2), 2);
assert.equal(parseTraceparent(traceparent, 2)?.traceIdRandom, true);

const chunks = [];
const destination = new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    callback();
  },
});
const logger = createObservabilityLogger({ preset: "gcp", base: null, destination });
const app = Fastify({
  loggerInstance: logger,
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
});

try {
  await app.register(fastifyObservability, { capturePath: true, traceContextLevel: 2 });
  app.get(
    "/smoke/:id",
    { schema: { operationId: "package_smoke" } },
    (request) => ({ context: request.observability, bindings: request.log.bindings() }),
  );
  const response = await app.inject({
    url: "/smoke/42?secret=yes",
    headers: { "x-request-id": "package-smoke", traceparent },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-request-id"], "package-smoke");
  const body = response.json();
  assert.equal(body.context.requestId, "package-smoke");
  assert.equal(body.context.correlationId, traceId);
  assert.equal(body.context.traceContext.traceContextLevel, 2);
  assert.equal(body.context.traceContext.traceIdRandom, true);
  assert.equal(body.bindings.request_id, "package-smoke");
  assert.equal(body.bindings["logging.googleapis.com/trace"], traceId);
  assert.equal(body.bindings.trace_id_random, true);
  assert.equal(body.bindings["logging.googleapis.com/spanId"], undefined);

  const records = chunks.join("").trim().split("\\n").filter(Boolean).map(JSON.parse);
  const terminal = records.filter((record) => record.message === "request completed");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].severity, "INFO");
  assert.equal(terminal[0].path, "/smoke/42");
  assert.equal(terminal[0].path_template, "/smoke/{id}");
  assert.equal(terminal[0].operation_id, "package_smoke");
  assert.equal(terminal[0].status, 200);
  assert.equal(terminal[0]["logging.googleapis.com/trace"], traceId);
  assert.equal(terminal[0].trace_id_random, true);
  assert.equal(terminal[0]["logging.googleapis.com/spanId"], undefined);
  assert.equal(terminal[0].httpRequest.requestUrl, "/smoke/42");
} finally {
  await app.close();
}
`,
  );

  const require = createRequire(join(consumer, "package.json"));
  const tsc = join(dirname(require.resolve("typescript")), "tsc.js");
  execute(process.execPath, [tsc, "--project", "tsconfig.json"], consumer);
  execute(process.execPath, ["smoke.mjs"], consumer);
} finally {
  rmSync(consumer, { force: true, recursive: true });
}
