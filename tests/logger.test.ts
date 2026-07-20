import { type EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  getObservabilityLoggerProfile,
} from "fastify-observability";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { JsonLineStream, topLevelKeyOccurrences } from "./helpers.js";

function requiredFastifyOptions() {
  return {
    requestIdHeader: false as const,
    genReqId: createRequestIdGenerator(),
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
  };
}

describe("canonical Pino logger", () => {
  it("writes each event as one LF-terminated NDJSON object", () => {
    const writes: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callback();
      },
    });
    const logger = createObservabilityLogger({ destination });

    logger.info("first\nlogical message");
    logger.error("second message");

    expect(writes).toHaveLength(2);
    const messages = writes.map((write) => {
      expect(write.endsWith("\n")).toBe(true);
      expect(write).not.toContain("\r");
      const line = write.slice(0, -1);
      expect(line).not.toContain("\n");
      const record = JSON.parse(line) as unknown;
      expect(record).toBeTypeOf("object");
      expect(Array.isArray(record)).toBe(false);
      return (record as { message: string }).message;
    });
    expect(messages).toEqual(["first\nlogical message", "second message"]);
  });

  it("owns the envelope and preserves nested bindings without duplicate top-level names", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({
      preset: "gcp",
      level: "debug",
      base: { component: "catalog", service: { name: "api", labels: ["public"] } },
      destination: stream,
    });
    const child = logger.child({ request_id: "fixed" });
    expect(logger.bindings()).toMatchObject({
      component: "catalog",
      service: { name: "api", labels: ["public"] },
    });
    expect(child.bindings()).toMatchObject({
      component: "catalog",
      service: { name: "api", labels: ["public"] },
      request_id: "fixed",
    });
    child.info({ item_id: "42" }, "item loaded");

    expect(stream.records).toHaveLength(1);
    expect(stream.records[0]).toMatchObject({
      severity: "INFO",
      message: "item loaded",
      component: "catalog",
      service: { name: "api", labels: ["public"] },
      request_id: "fixed",
      item_id: "42",
    });
    const line = stream.lines[0];
    if (line === undefined) {
      throw new Error("expected one raw Pino line");
    }
    for (const key of ["severity", "message", "component", "service", "request_id", "item_id"]) {
      expect(topLevelKeyOccurrences(line, key)).toBe(1);
    }
    expect(topLevelKeyOccurrences(line, "msg")).toBe(0);
    expect(topLevelKeyOccurrences(line, "level")).toBe(0);
  });

  it("blocks binding mutation and repeated bindings on every canonical child", () => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    const child = logger.child({ request_id: "fixed" });

    expect(() =>
      (child as unknown as { setBindings(bindings: Record<string, unknown>): void }).setBindings({
        request_id: "changed",
      }),
    ).toThrow("do not allow setBindings");
    expect(() => child.child({ request_id: "duplicate" })).toThrow('duplicate binding "request_id"');
    expect(() => logger.child({ tenant: "second" }).child({ tenant: "duplicate" })).toThrow(
      'duplicate binding "tenant"',
    );
  });

  it("keeps Pino's implicit pid and hostname fields unique", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ destination: stream });
    logger.child({ component: "catalog" }).info("started");

    const line = stream.lines[0];
    if (line === undefined) {
      throw new Error("expected one raw Pino line");
    }
    expect(topLevelKeyOccurrences(line, "pid")).toBe(1);
    expect(topLevelKeyOccurrences(line, "hostname")).toBe(1);
    expect(topLevelKeyOccurrences(line, "component")).toBe(1);
    expect(topLevelKeyOccurrences(line, "level")).toBe(1);
    expect(topLevelKeyOccurrences(line, "message")).toBe(1);
    expect(topLevelKeyOccurrences(line, "severity")).toBe(0);
    expect(stream.records[0]).toMatchObject({ level: 30, message: "started", component: "catalog" });
  });

  it("honors base null by omitting Pino's implicit pid and hostname fields", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ base: null, destination: stream });

    logger.info("without implicit base");

    const line = stream.lines[0];
    if (line === undefined) {
      throw new Error("expected one raw Pino line");
    }
    expect(topLevelKeyOccurrences(line, "pid")).toBe(0);
    expect(topLevelKeyOccurrences(line, "hostname")).toBe(0);
    expect(topLevelKeyOccurrences(line, "level")).toBe(1);
    expect(topLevelKeyOccurrences(line, "message")).toBe(1);
    expect(stream.records[0]).toMatchObject({ level: 30, message: "without implicit base" });
  });

  it("preserves the canonical envelope through Pino's built-in file transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fastify-observability-"));
    const destination = join(directory, "transport.log");
    const logger = createObservabilityLogger({
      preset: "gcp",
      transport: { target: "pino/file", options: { destination } },
    });
    const transport = Reflect.get(logger, pino.symbols.streamSym) as EventEmitter & {
      ready: boolean;
      end(): void;
    };
    let finished = false;
    let completion: Promise<unknown[]> | undefined;
    try {
      if (!transport.ready) {
        await once(transport, "ready");
      }
      logger.info("transported");
      completion = once(transport, "finish");
      transport.end();
      await completion;
      finished = true;

      const line = readFileSync(destination, "utf8").trim();
      expect(JSON.parse(line)).toMatchObject({ severity: "INFO", message: "transported" });
      expect(topLevelKeyOccurrences(line, "severity")).toBe(1);
      expect(topLevelKeyOccurrences(line, "message")).toBe(1);
      expect(topLevelKeyOccurrences(line, "level")).toBe(0);
      expect(topLevelKeyOccurrences(line, "msg")).toBe(0);
    } finally {
      if (!finished) {
        if (completion === undefined) {
          completion = once(transport, "finish");
          transport.end();
        }
        await completion.catch(() => undefined);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects GCP transport.targets with a package-owned configuration error", () => {
    let thrown: unknown;

    try {
      createObservabilityLogger({
        preset: "gcp",
        transport: {
          targets: [
            { target: "pino/file", options: { destination: 1 } },
            { target: "pino/file", options: { destination: 2 } },
          ],
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "logger transport.targets is incompatible with the gcp preset; use transport.target instead",
    );
  });

  it("keeps transport.targets available to presets without GCP level formatting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fastify-observability-"));
    const firstDestination = join(directory, "first.log");
    const secondDestination = join(directory, "second.log");
    const logger = createObservabilityLogger({
      transport: {
        targets: [
          { target: "pino/file", options: { destination: firstDestination } },
          { target: "pino/file", options: { destination: secondDestination } },
        ],
      },
    });
    const transport = Reflect.get(logger, pino.symbols.streamSym) as EventEmitter & {
      ready: boolean;
      end(): void;
    };
    let finished = false;
    let completion: Promise<unknown[]> | undefined;
    try {
      if (!transport.ready) {
        await once(transport, "ready");
      }
      logger.info("transported twice");
      completion = once(transport, "finish");
      transport.end();
      await completion;
      finished = true;

      for (const destination of [firstDestination, secondDestination]) {
        const line = readFileSync(destination, "utf8").trim();
        expect(JSON.parse(line)).toMatchObject({ level: 30, message: "transported twice" });
        expect(topLevelKeyOccurrences(line, "level")).toBe(1);
        expect(topLevelKeyOccurrences(line, "severity")).toBe(0);
      }
    } finally {
      if (!finished) {
        if (completion === undefined) {
          completion = once(transport, "finish");
          transport.end();
        }
        await completion.catch(() => undefined);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "time",
    "timestamp",
    "level",
    "severity",
    "msg",
    "message",
    "pid",
    "hostname",
    "serializers",
    "formatters",
    "customLevels",
  ])("rejects the hidden or Pino-reserved child binding %s", (key) => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    expect(() => logger.child({ [key]: "unsafe" })).toThrow(`reserves Pino child binding "${key}"`);
  });

  it.each([
    "time",
    "timestamp",
    "level",
    "severity",
    "msg",
    "message",
    "pid",
    "hostname",
    "observability_diagnostic",
    "reqId",
    "request_id",
    "correlation_id",
    "trace_id",
    "parent_id",
    "trace_flags",
    "trace_sampled",
    "trace_id_random",
    "logging.googleapis.com/trace",
    "logging.googleapis.com/trace_sampled",
    "logging.googleapis.com/spanId",
    "xray_trace_id",
    "operation_Id",
    "operation_ParentId",
    "method",
    "path",
    "path_template",
    "operation_id",
    "status",
    "duration_ms",
    "peer_ip",
    "remote_ip",
    "user_agent",
    "terminal_reason",
    "err",
    "httpRequest",
    "serializers",
    "formatters",
    "customLevels",
  ])("rejects the protected or ignored Pino base binding %s", (key) => {
    expect(() => createObservabilityLogger({ base: { [key]: "unsafe" } })).toThrow(
      `reserves Pino base binding "${key}"`,
    );
  });

  it.each([
    "formatters",
    "customLevels",
    "msgPrefix",
    "unknown",
  ])("rejects the uncontrolled Pino child option %s", (key) => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    expect(() => logger.child({}, { [key]: "unsafe" } as never)).toThrow(`do not allow child option "${key}"`);
  });

  it("preserves a valid Pino child level override", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ level: "info", destination: stream });

    logger.child({}, { level: "debug" }).debug("child debug");

    expect(stream.records).toHaveLength(1);
    expect(stream.records[0]).toMatchObject({ level: 20, message: "child debug" });
  });

  it("inherits root redaction and rejects child attempts to replace that policy", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({
      redact: { paths: ["credentials.password"], remove: true },
      destination: stream,
    });
    const child = logger.child({ component: "catalog" });

    child.info({ credentials: { username: "reader", password: "secret" } }, "authenticated");

    expect(stream.records[0]).toMatchObject({
      message: "authenticated",
      credentials: { username: "reader" },
    });
    expect(stream.lines[0]?.includes("secret")).toBe(false);
    expect(() => logger.child({}, { redact: [] } as never)).toThrow('do not allow child option "redact"');
  });

  it("does not implicitly redact application records", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ destination: stream });

    logger.info(
      {
        credentials: { password: "password-canary" },
        authorization: "authorization-canary",
        cookie: "cookie-canary",
      },
      "application record",
    );

    expect(stream.records[0]).toMatchObject({
      credentials: { password: "password-canary" },
      authorization: "authorization-canary",
      cookie: "cookie-canary",
      message: "application record",
    });
    expect(stream.lines[0]).toEqual(expect.stringContaining("password-canary"));
    expect(stream.lines[0]).toEqual(expect.stringContaining("authorization-canary"));
    expect(stream.lines[0]).toEqual(expect.stringContaining("cookie-canary"));
  });

  it("applies a safe serializer on a canonical child", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ destination: stream });
    const child = logger.child({}, { serializers: { account: (value) => ({ id: (value as { id: string }).id }) } });

    child.info({ account: { id: "42", token: "secret" } }, "loaded");

    expect(stream.records[0]).toMatchObject({ account: { id: "42" }, message: "loaded" });
    expect(stream.lines[0]?.includes("secret")).toBe(false);
  });

  it.each([
    ["null bindings", null, undefined, "logger child bindings must be a record"],
    ["array bindings", [], undefined, "logger child bindings must be a record"],
    ["null options", {}, null, "logger child options must be a record"],
    ["array options", {}, [], "logger child options must be a record"],
    ["a nonstandard child level", {}, { level: "verbose" }, "logger child level must be a standard Pino level"],
    ["a non-string child level", {}, { level: 1 }, "logger child level must be a standard Pino level"],
  ])("rejects %s", (_name, bindings, options, message) => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    expect(() => logger.child(bindings as never, options as never)).toThrow(message as string);
  });

  it.each([
    "messageKey",
    "timestamp",
    "formatters",
    "hooks",
    "mixin",
    "nestedKey",
    "onChild",
  ])("rejects the uncontrolled Pino option %s", (key) => {
    expect(() => createObservabilityLogger({ [key]: "unsafe" } as never)).toThrow(
      `unsupported observability logger option "${key}"`,
    );
  });

  it.each([
    ["trace", "DEBUG"],
    ["debug", "DEBUG"],
    ["info", "INFO"],
    ["warn", "WARNING"],
    ["error", "ERROR"],
    ["fatal", "CRITICAL"],
  ] as const)("maps Pino %s to the canonical GCP severity", (level, severity) => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ preset: "gcp", level: "trace", destination: stream });
    logger[level]("mapped");
    expect(stream.records[0]).toMatchObject({ severity, message: "mapped" });
  });

  it("resolves the newest installed GCP profile, preserves an exact pin, and exposes it safely", () => {
    const latest = createObservabilityLogger({ preset: "gcp", destination: new JsonLineStream() });
    const pinned = createObservabilityLogger({
      preset: "gcp",
      gcpProfileVersion: "0.1.0",
      destination: new JsonLineStream(),
    });

    expect(getObservabilityLoggerProfile(latest)).toEqual({ preset: "gcp", gcpProfileVersion: "0.1.0" });
    expect(getObservabilityLoggerProfile(pinned)).toEqual({ preset: "gcp", gcpProfileVersion: "0.1.0" });
    expect(Object.isFrozen(getObservabilityLoggerProfile(latest))).toBe(true);
    expect(getObservabilityLoggerProfile(latest.child({ component: "health" }))).toBe(
      getObservabilityLoggerProfile(latest),
    );
    expect(getObservabilityLoggerProfile(createObservabilityLogger())).toEqual({ preset: "default" });
    expect(() => getObservabilityLoggerProfile({})).toThrow("not a fastify-observability canonical logger");
  });

  it.each([
    ["aws", "awsProfileVersion"],
    ["azure", "azureProfileVersion"],
  ] as const)("resolves and exposes the current %s profile", (preset, versionKey) => {
    const latest = createObservabilityLogger({ preset, destination: new JsonLineStream() });
    const pinned = createObservabilityLogger({ preset, [versionKey]: "0.1.0", destination: new JsonLineStream() });
    expect(getObservabilityLoggerProfile(latest)).toEqual({ preset, [versionKey]: "0.1.0" });
    expect(getObservabilityLoggerProfile(pinned)).toEqual({ preset, [versionKey]: "0.1.0" });
    expect(() => createObservabilityLogger({ preset, [versionKey]: "0.2.0" })).toThrow(
      `unsupported ${preset.toUpperCase()} profile version; expected 0.1.0`,
    );
  });

  it.each([
    ["null options", null, "logger options must be a record"],
    ["an options array", [], "logger options must be a record"],
    ["an unknown preset", { preset: "unknown" }, "logger preset must be default, gcp, aws, or azure"],
    [
      "an unsupported GCP profile pin",
      { preset: "gcp", gcpProfileVersion: "0.2.0" },
      "unsupported GCP profile version; expected 0.1.0",
    ],
    [
      "a GCP profile pin without GCP selection",
      { preset: "default", gcpProfileVersion: "0.1.0" },
      'gcpProfileVersion requires preset "gcp"',
    ],
    ["a nonstandard level", { level: "verbose" }, "logger level must be a standard Pino level"],
    ["an array base", { base: [] }, "logger base must be a record or null"],
    ["a non-stream destination", { destination: {} }, "logger destination must provide write(message)"],
    [
      "both destination and transport",
      { destination: new JsonLineStream(), transport: { target: "pino/file" } },
      "logger destination and transport are mutually exclusive",
    ],
  ])("rejects %s", (_name, options, message) => {
    expect(() => createObservabilityLogger(options as never)).toThrow(message as string);
  });

  it("applies bracket-path redaction to application fields", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({
      redact: { paths: ['["credentials"].password'], remove: true },
      destination: stream,
    });
    logger.info({ credentials: { username: "reader", password: "secret" } }, "authenticated");
    expect(stream.records[0]).toMatchObject({
      message: "authenticated",
      credentials: { username: "reader" },
    });
    const credentials = stream.records[0]?.["credentials"];
    if (credentials === null || typeof credentials !== "object") {
      throw new Error("expected serialized credentials");
    }
    expect(Reflect.get(credentials, "password")).toBeUndefined();
  });

  it.each([
    "request_id",
    ".request_id",
    "[request_id]",
    ".[request_id]",
    "[`request_id`]",
    '[ "message" ]',
    "err",
    "[err]",
    "httpRequest",
    '["httpRequest"]',
    "[*]",
    "[ * ]",
    '["*"]',
    "['*']",
    "*",
    ".*",
  ])("rejects protected root redaction path %s", (path) => {
    expect(() => createObservabilityLogger({ redact: [path] })).toThrow("does not allow redaction");
  });

  it("rejects every redaction override on a canonical child", () => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    expect(() => logger.child({}, { redact: ["credentials.password"] } as never)).toThrow(
      'do not allow child option "redact"',
    );
  });

  it.each([
    ["null", null],
    ["a number", 1],
    ["a record without paths", {}],
    ["a non-string path", { paths: [1] }],
  ])("rejects invalid redaction configuration: %s", (_name, redact) => {
    expect(() => createObservabilityLogger({ redact } as never)).toThrow(/logger redact/);
  });

  it("applies serializers to application fields", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({
      serializers: { account: (value) => ({ id: (value as { id: string }).id }) },
      destination: stream,
    });
    logger.info({ account: { id: "42", token: "secret" } }, "loaded");
    expect(stream.records[0]).toMatchObject({ account: { id: "42" }, message: "loaded" });
  });

  it("exposes application serializer failures to the calling application", () => {
    const logger = createObservabilityLogger({
      serializers: {
        account: () => {
          throw new Error("serializer failed");
        },
      },
      destination: new JsonLineStream(),
    });

    expect(() => logger.info({ account: { id: "42" } }, "loaded")).toThrow("serializer failed");
  });

  it.each([
    ["request_id", { request_id: String }, "request_id"],
    ["a custom err serializer", { err: () => ({ hidden: true }) }, "err"],
    ["Pino's standard err serializer at the root", { err: pino.stdSerializers.err }, "err"],
  ])("rejects protected root serializer %s", (_name, serializers, field) => {
    expect(() => createObservabilityLogger({ serializers: serializers as never })).toThrow(
      `serializer for protected field "${field}"`,
    );
  });

  it.each([
    ["message", { message: String }, "message"],
    ["a custom err serializer", { err: () => ({ hidden: true }) }, "err"],
  ])("rejects protected child serializer %s", (_name, serializers, field) => {
    const logger = createObservabilityLogger({ destination: new JsonLineStream() });
    expect(() => logger.child({}, { serializers: serializers as never })).toThrow(
      `serializer for protected field "${field}"`,
    );
  });

  it("replaces Fastify's internal error serializer with the package-owned Pino serializer", () => {
    const stream = new JsonLineStream();
    const logger = createObservabilityLogger({ destination: stream });
    const child = logger.child({}, {
      logger: undefined,
      genReqId: undefined,
      serializers: { err: () => ({ hidden: true }) },
    } as never);
    const error = new Error("visible failure");

    child.error({ err: error }, "failed");

    expect(stream.records).toHaveLength(1);
    expect(stream.records[0]).toMatchObject({
      message: "failed",
      err: { type: "Error", message: "visible failure" },
    });
    expect(stream.records[0]?.["err"]).not.toHaveProperty("hidden");
  });

  it.each([
    ["null serializers", null, "logger serializers must be a record"],
    ["an array of serializers", [], "logger serializers must be a record"],
    ["a non-function serializer", { account: "not-a-function" }, 'logger serializer "account" must be a function'],
  ])("rejects %s", (_name, serializers, message) => {
    expect(() => createObservabilityLogger({ serializers: serializers as never })).toThrow(message);
  });

  it.each([
    [
      "an independently created Pino logger",
      () => Fastify({ loggerInstance: pino({ enabled: false }), ...requiredFastifyOptions() }),
    ],
    ["logger: false", () => Fastify({ logger: false, ...requiredFastifyOptions() })],
    ["an omitted logger", () => Fastify(requiredFastifyOptions())],
    ["logger: true", () => Fastify({ logger: true, ...requiredFastifyOptions() })],
    ["Fastify logger options", () => Fastify({ logger: { level: "silent" }, ...requiredFastifyOptions() })],
  ])("rejects %s at registration", async (_name, createApp) => {
    const app = createApp() as FastifyInstance;
    try {
      await expect(app.register(fastifyObservability)).rejects.toThrow("createObservabilityLogger()");
    } finally {
      await app.close();
    }
  });

  it("rejects a canonical logger with a non-record public bindings result during Fastify construction", () => {
    const logger = createObservabilityLogger({ level: "silent" });
    Object.defineProperty(logger, "bindings", { value: () => [] });

    expect(() =>
      Fastify({
        loggerInstance: logger,
        requestIdHeader: false,
        genReqId: createRequestIdGenerator(),
        logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      }),
    ).toThrow("logger bindings must be a record");
  });

  it("rechecks the root bindings snapshot at plugin registration", async () => {
    const logger = createObservabilityLogger({ level: "silent" });
    const app = Fastify({ loggerInstance: logger, ...requiredFastifyOptions() });
    Object.defineProperty(app.log, "bindings", { value: () => [] });

    try {
      await expect(app.register(fastifyObservability)).rejects.toThrow("logger bindings must be a record");
    } finally {
      await app.close();
    }
  });

  it("rejects a canonical logger whose public bindings snapshot adds a protected root field", async () => {
    const logger = createObservabilityLogger({ level: "silent" });
    Object.defineProperty(logger, "bindings", { value: () => ({ request_id: "tampered" }) });
    const app = Fastify({
      loggerInstance: logger,
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    try {
      await expect(app.register(fastifyObservability)).rejects.toThrow(
        'fastify-observability reserves Pino base binding "request_id"',
      );
    } finally {
      await app.close();
    }
  });
});
