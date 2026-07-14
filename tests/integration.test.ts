import { Readable } from "node:stream";
import Fastify, { type FastifyBaseLogger, LogController } from "fastify";
import fastifyObservability, { createRequestIdGenerator } from "fastify-observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRecords, buildTestApp } from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

const apps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Fastify integration", () => {
  it("shares validated request and trace context across handler, response, and access log", async () => {
    const { app, records } = await buildTestApp({ preset: "gcp" });
    apps.push(app);
    app.get("/items/:id", { schema: { operationId: "get_item" } as never }, (request) => {
      request.log.info({ item_id: (request.params as { id: string }).id }, "handler log");
      expect(Object.isFrozen(request.observability)).toBe(true);
      expect(Object.isFrozen(request.observability.traceContext)).toBe(true);
      return request.observability;
    });
    const response = await app.inject({
      method: "GET",
      url: "/items/42?secret=hidden",
      headers: { "x-request-id": "caller-A", traceparent: TRACEPARENT, tracestate: "vendor=value" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("caller-A");
    expect(response.json()).toMatchObject({ requestId: "caller-A", correlationId: TRACE_ID });
    const handler = records.find((record) => record.msg === "handler log");
    const access = accessRecords(records)[0];
    expect(handler).toMatchObject({ request_id: "caller-A", correlation_id: TRACE_ID, trace_id: TRACE_ID });
    expect(access).toMatchObject({
      request_id: "caller-A",
      correlation_id: TRACE_ID,
      path: "/items/42",
      path_template: "/items/:id",
      operation_id: "get_item",
      status: 200,
      "logging.googleapis.com/trace": TRACE_ID,
    });
    expect(access?.["logging.googleapis.com/spanId"]).toBeUndefined();
    expect(access?.["httpRequest"]).toMatchObject({ requestUrl: "/items/42", status: 200 });
    expect(accessRecords(records)).toHaveLength(1);
  });

  it.each([
    ["default", {}],
    ["gcp", { "logging.googleapis.com/trace": TRACE_ID }],
    ["aws", { xray_trace_id: `1-${TRACE_ID.slice(0, 8)}-${TRACE_ID.slice(8)}` }],
    ["azure", { operation_Id: TRACE_ID, operation_ParentId: PARENT_ID }],
  ] as const)("emits the %s correlation shape", async (preset, expected) => {
    const { app, records } = await buildTestApp({ preset });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("handler");
      return { ok: true };
    });
    await app.inject({ url: "/", headers: { traceparent: TRACEPARENT } });
    expect(records.find((record) => record.msg === "handler")).toMatchObject(expected);
    expect(accessRecords(records)[0]).toMatchObject(expected);
  });

  it("uses final response status and retains observed errors", async () => {
    const { app, records } = await buildTestApp();
    apps.push(app);
    app.get("/translated", async () => {
      throw new Error("translated failure");
    });
    app.setErrorHandler((_error, _request, reply) => reply.code(418).send({ handled: true }));
    const response = await app.inject("/translated");
    expect(response.statusCode).toBe(418);
    const access = accessRecords(records)[0];
    expect(access).toMatchObject({ level: 40, status: 418 });
    expect(access?.["err"]).toMatchObject({ type: "Error", message: "translated failure" });
  });

  it("maps levels, supports debug, and protects reserved fields", async () => {
    const { app, records } = await buildTestApp({
      levelForStatus: (status) => (status === 201 ? "debug" : "info"),
      extraFields: () => ({ component: "catalog", status: 999, req: { headers: "secret" }, __proto__: "bad" }),
    });
    apps.push(app);
    app.post("/items", (_request, reply) => reply.code(201).send({ ok: true }));
    await app.inject({ method: "POST", url: "/items" });
    expect(accessRecords(records)[0]).toMatchObject({ level: 20, status: 201, component: "catalog" });
    expect(accessRecords(records)[0]?.["req"]).toBeUndefined();
  });

  it("falls back when callbacks fail without changing the response", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app, records } = await buildTestApp({
      levelForStatus: () => "invalid" as never,
      extraFields: () => {
        throw new Error("callback failure");
      },
    });
    apps.push(app);
    app.get("/", () => ({ ok: true }));
    const first = await app.inject("/");
    const second = await app.inject("/");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(accessRecords(records)).toHaveLength(2);
    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it("handles 404 and successful streams with one record", async () => {
    const { app, records } = await buildTestApp();
    apps.push(app);
    app.get("/stream", () => Readable.from(["one", "two"]));
    expect((await app.inject("/stream")).body).toBe("onetwo");
    expect((await app.inject("/missing?private=yes")).statusCode).toBe(404);
    const [stream, missing] = accessRecords(records);
    expect(stream).toMatchObject({ status: 200, path_template: "/stream" });
    expect(missing).toMatchObject({ status: 404, path: "/missing" });
    expect(missing?.["path_template"]).toBeUndefined();
  });

  it("can disable the response header and operate with logging disabled", async () => {
    const { app, records } = await buildTestApp({ responseHeader: false }, { logger: false });
    apps.push(app);
    app.get("/", (request) => request.observability);
    const response = await app.inject("/");
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeUndefined();
    expect(response.json().requestId).toEqual(expect.any(String));
    expect(records).toHaveLength(0);
  });

  it("diagnoses the legacy reqId label without failing traffic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app, records } = await buildTestApp({}, { canonicalLabel: false });
    apps.push(app);
    app.get("/", () => ({ ok: true }));
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(accessRecords(records)[0]).toMatchObject({ reqId: expect.any(String), request_id: expect.any(String) });
  });

  it("degrades observability without failing traffic when logger enrichment throws", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const noop = () => undefined;
    const logger = {
      level: "info",
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      silent: noop,
      child(bindings: Record<string, unknown>) {
        if (bindings["correlation_id"] !== undefined) {
          throw new Error("child failed");
        }
        return this;
      },
      bindings: () => ({}),
    } as unknown as FastifyBaseLogger;
    const app = Fastify({
      loggerInstance: logger,
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);
    const response = await app.inject({ url: "/", headers: { "x-request-id": "still-safe" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("still-safe");
    expect(response.json()).toMatchObject({ requestId: "still-safe" });
    expect(stderr).toHaveBeenCalledOnce();
  });

  it("rejects unsafe Fastify wiring and duplicate registration", async () => {
    const unsafe = Fastify({ logger: false, requestIdHeader: "x-request-id" });
    apps.push(unsafe);
    await expect(unsafe.register(fastifyObservability)).rejects.toThrow("requestIdHeader: false");

    const duplicate = Fastify({
      logger: false,
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(duplicate);
    await duplicate.register(fastifyObservability);
    await expect(duplicate.register(fastifyObservability)).rejects.toThrow("exactly once");

    const nested = Fastify({
      logger: false,
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(nested);
    nested.register(fastifyObservability);
    nested.register(async (scope) => {
      await scope.register(fastifyObservability);
    });
    await expect(nested.ready()).rejects.toThrow("exactly once");
  });

  it("fails the first request when Fastify did not use the package generator", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = Fastify({
      logger: false,
      requestIdHeader: false,
      genReqId: () => "unproven-id",
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", () => ({ ok: true }));
    const response = await app.inject("/");
    expect(response.statusCode).toBe(500);
    expect(response.headers["x-request-id"]).toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it.each([
    { preset: "invalid" as never },
    { message: "" },
    { requestIdHeader: "bad header" },
    { requestIdHeader: "traceparent" },
    { responseHeader: "traceparent" },
    { levelForStatus: 1 as never },
    { extraFields: 1 as never },
  ])("rejects invalid options: $preset$message$requestIdHeader$responseHeader", async (options) => {
    const app = Fastify({ logger: false, requestIdHeader: false, genReqId: createRequestIdGenerator() });
    apps.push(app);
    await expect(app.register(fastifyObservability, options)).rejects.toThrow();
  });
});
