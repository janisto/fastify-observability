import { PassThrough, Readable } from "node:stream";
import Fastify, { type FastifyBaseLogger, LogController, type onSendHookHandler } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  isValidRequestId,
} from "fastify-observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessRecords,
  buildTestApp,
  diagnosticKinds,
  diagnosticRecords,
  JsonLineStream,
  topLevelKeyOccurrences,
} from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

const apps: Array<{ close(): Promise<unknown> }> = [];

async function healthRequest(preset: "default" | "gcp", level: "debug" | "info") {
  let clockCalls = 0;
  const { app, lines, records } = await buildTestApp(
    { clock: () => (clockCalls++ === 0 ? 1_000 : 1_012.5) },
    { preset, level },
  );
  apps.push(app);
  app.get("/health", { schema: { operationId: "health_check" } as never }, (request) => {
    request.log.info(
      { service_name: "example-service", service_version: "1.0.0", health_status: "ok" },
      "health check",
    );
    request.log.debug({ dependency: "database", dependency_status: "ok", check_duration_ms: 3 }, "dependency check");
    return "ok";
  });
  const response = await app.inject({ url: "/health", headers: { "x-request-id": "health-example" } });
  return { lines, records, response };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Fastify integration", () => {
  it("writes GCP application info, application debug, and one terminal health record", async () => {
    const { lines, records, response } = await healthRequest("gcp", "debug");

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("ok");
    expect(lines).toHaveLength(3);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      severity: "INFO",
      message: "health check",
      service_name: "example-service",
      service_version: "1.0.0",
      health_status: "ok",
    });
    expect(records[1]).toMatchObject({
      severity: "DEBUG",
      message: "dependency check",
      dependency: "database",
      dependency_status: "ok",
      check_duration_ms: 3,
    });
    for (const record of records) {
      expect(record).toMatchObject({ request_id: "health-example", correlation_id: "health-example" });
    }
    expect(records[2]).toMatchObject({
      severity: "INFO",
      message: "request completed",
      method: "GET",
      path_template: "/health",
      operation_id: "health_check",
      duration_ms: 12.5,
      status: 200,
      httpRequest: { requestMethod: "GET", status: 200, latency: "0.012500s" },
    });
    for (const privateField of ["path", "peer_ip", "remote_ip", "user_agent"]) {
      expect(records[2]?.[privateField]).toBeUndefined();
    }
    for (const privateField of ["requestUrl", "remoteIp", "userAgent"]) {
      expect((records[2]?.["httpRequest"] as Record<string, unknown> | undefined)?.[privateField]).toBeUndefined();
    }
    for (const applicationOnly of [
      "service_name",
      "service_version",
      "health_status",
      "dependency",
      "dependency_status",
      "check_duration_ms",
    ]) {
      expect(records[2]?.[applicationOnly]).toBeUndefined();
    }
    expect(accessRecords(records)).toHaveLength(1);
  });

  it("filters health debug details at the GCP info threshold", async () => {
    const { lines, records, response } = await healthRequest("gcp", "info");

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("ok");
    expect(lines).toHaveLength(2);
    expect(records.map((record) => record.message)).toEqual(["health check", "request completed"]);
    expect(records.every((record) => record["request_id"] === "health-example")).toBe(true);
    expect(lines.join("\n")).not.toContain("dependency check");
    expect(lines.join("\n")).not.toContain("check_duration_ms");
  });

  it.each([
    ["debug", ["health check", "dependency check", "request completed"]],
    ["info", ["health check", "request completed"]],
  ] as const)("writes the exact core health projection at the %s threshold", async (level, messages) => {
    const { lines, records, response } = await healthRequest("default", level);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("ok");
    expect(response.headers["x-request-id"]).toBe("health-example");
    expect(records.map((record) => record.message)).toEqual(messages);
    expect(lines).toHaveLength(messages.length);
    for (const record of records) {
      expect(record).toMatchObject({ request_id: "health-example", correlation_id: "health-example" });
      expect(record["severity"]).toBeUndefined();
      expect(record["httpRequest"]).toBeUndefined();
    }
    expect(records[0]).toMatchObject({
      message: "health check",
      service_name: "example-service",
      service_version: "1.0.0",
      health_status: "ok",
    });
    const terminal = records.at(-1);
    expect(terminal).toMatchObject({
      message: "request completed",
      method: "GET",
      duration_ms: 12.5,
      status: 200,
      path_template: "/health",
      operation_id: "health_check",
    });
    for (const privateField of ["path", "peer_ip", "remote_ip", "user_agent"]) {
      expect(terminal?.[privateField]).toBeUndefined();
    }
    if (level === "info") {
      expect(lines.join("\n")).not.toContain("dependency check");
      expect(lines.join("\n")).not.toContain("check_duration_ms");
    }
    expect(accessRecords(records)).toHaveLength(1);
  });

  it("shares validated request and trace context across handler, response, and access log", async () => {
    const { app, records } = await buildTestApp({ capturePath: true }, { preset: "gcp" });
    apps.push(app);
    app.get("/items/:item_id", { schema: { operationId: "get_item" } as never }, (request, reply) => {
      request.log.info({ item_id: (request.params as { item_id: string }).item_id }, "handler log");
      reply.log.info("reply log");
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
    const handler = records.find((record) => record.message === "handler log");
    const replyLog = records.find((record) => record.message === "reply log");
    const access = accessRecords(records)[0];
    expect(handler).toMatchObject({ request_id: "caller-A", correlation_id: TRACE_ID, trace_id: TRACE_ID });
    expect(replyLog).toMatchObject({ request_id: "caller-A", correlation_id: TRACE_ID, trace_id: TRACE_ID });
    expect(access).toMatchObject({
      request_id: "caller-A",
      correlation_id: TRACE_ID,
      path: "/items/42",
      path_template: "/items/{item_id}",
      operation_id: "get_item",
      status: 200,
      "logging.googleapis.com/trace": TRACE_ID,
    });
    expect(access?.["logging.googleapis.com/spanId"]).toBeUndefined();
    expect(access?.["httpRequest"]).toMatchObject({ requestUrl: "/items/42", status: 200 });
    expect(accessRecords(records)).toHaveLength(1);
  });

  it("drops reserved application fields before Pino can duplicate or forge them", async () => {
    const { app, lines, records } = await buildTestApp({}, { preset: "azure" });
    apps.push(app);
    app.get("/guarded", (request) => {
      request.log.info(
        {
          request_id: "spoofed-request",
          trace_id: "00000000000000000000000000000001",
          operation_Id: "spoofed-operation",
          method: "DELETE",
          status: 599,
          message: "spoofed-message",
          "logging.googleapis.com/future": "spoofed-provider",
          "logging.googleapis.com/labels": { component: "worker" },
          "logging.googleapis.com/spanId": "application-span",
          "obs.internal": true,
          tenant_id: "tenant-1",
        },
        "guarded application event",
      );
      request.log.info({
        message: "object-owned application message",
        request_id: "spoofed-request",
        tenant_id: "tenant-2",
      });
      return { ok: true };
    });

    const response = await app.inject({
      url: "/guarded",
      headers: { "x-request-id": "canonical-request", traceparent: TRACEPARENT },
    });

    expect(response.statusCode).toBe(200);
    const application = records.find((record) => record.message === "guarded application event");
    expect(application).toMatchObject({
      request_id: "canonical-request",
      trace_id: TRACE_ID,
      operation_Id: TRACE_ID,
      tenant_id: "tenant-1",
    });
    expect(application).toMatchObject({
      method: "DELETE",
      status: 599,
      "logging.googleapis.com/future": "spoofed-provider",
      "logging.googleapis.com/labels": { component: "worker" },
      "logging.googleapis.com/spanId": "application-span",
      "obs.internal": true,
    });
    const line = lines.find((candidate) => candidate.includes('"guarded application event"'));
    expect(line).toBeDefined();
    for (const key of ["request_id", "trace_id", "operation_Id", "message", "tenant_id"]) {
      expect(topLevelKeyOccurrences(line ?? "", key)).toBe(1);
    }
    for (const key of [
      "method",
      "status",
      "logging.googleapis.com/future",
      "logging.googleapis.com/labels",
      "logging.googleapis.com/spanId",
      "obs.internal",
    ]) {
      expect(topLevelKeyOccurrences(line ?? "", key)).toBe(1);
    }
    const objectMessage = records.find((record) => record.message === "object-owned application message");
    expect(objectMessage).toMatchObject({
      message: "object-owned application message",
      request_id: "canonical-request",
      tenant_id: "tenant-2",
    });
    const objectMessageLine = lines.find((candidate) => candidate.includes('"object-owned application message"'));
    expect(objectMessageLine).toBeDefined();
    for (const key of ["message", "request_id", "tenant_id"]) {
      expect(topLevelKeyOccurrences(objectMessageLine ?? "", key)).toBe(1);
    }
    expect(accessRecords(records)).toEqual([
      expect.objectContaining({ method: "GET", status: 200, request_id: "canonical-request" }),
    ]);
  });

  it("uses one aligned set of custom request, response, and trace headers", async () => {
    const { app, records } = await buildTestApp(
      {
        requestIdHeader: "x-correlation-id",
        responseHeader: "x-response-id",
        traceHeader: "x-traceparent",
        tracestateHeader: "x-tracestate",
      },
      { preset: "gcp" },
    );
    apps.push(app);
    app.get("/", (request) => request.observability);

    const response = await app.inject({
      url: "/",
      headers: {
        "x-correlation-id": "custom-request",
        "x-traceparent": TRACEPARENT,
        "x-tracestate": "vendor=value",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-response-id"]).toBe("custom-request");
    expect(response.headers["x-correlation-id"]).toBeUndefined();
    expect(response.json()).toMatchObject({
      requestId: "custom-request",
      correlationId: TRACE_ID,
      traceContext: { tracestate: "vendor=value" },
    });
    expect(accessRecords(records)[0]).toMatchObject({
      request_id: "custom-request",
      trace_id: TRACE_ID,
      "logging.googleapis.com/trace": TRACE_ID,
    });
  });

  it("never serializes query, authorization, cookie, arbitrary-header, or body secrets", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ preset: "gcp", level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.post("/private", () => ({ ok: true }));
    const secrets = {
      query: "query-canary-7f49",
      authorization: "authorization-canary-b152",
      cookie: "cookie-canary-66ad",
      header: "header-canary-9d28",
      body: "body-canary-042e",
    };

    const response = await app.inject({
      method: "POST",
      url: `/private?token=${secrets.query}`,
      headers: {
        authorization: `Bearer ${secrets.authorization}`,
        cookie: `session=${secrets.cookie}`,
        "x-api-key": secrets.header,
      },
      payload: { password: secrets.body },
    });

    expect(response.statusCode).toBe(200);
    expect(accessRecords(stream.records)).toEqual([expect.objectContaining({ method: "POST", status: 200 })]);
    expect(accessRecords(stream.records)[0]).not.toHaveProperty("path");
    const accessLine = stream.lines.find(
      (line) => (JSON.parse(line) as { message?: string }).message === "request completed",
    );
    if (accessLine === undefined) {
      throw new Error("expected one raw private access record");
    }
    for (const secret of Object.values(secrets)) {
      expect(accessLine.includes(secret)).toBe(false);
    }
  });

  it("rejects ambiguous duplicate traceparent headers and falls back to the request ID", async () => {
    const { app, records } = await buildTestApp({}, { preset: "gcp" });
    apps.push(app);
    app.get("/", (request) => request.observability);

    const response = await app.inject({
      url: "/",
      headers: { "x-request-id": "request-fallback", traceparent: [TRACEPARENT, TRACEPARENT] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId: "request-fallback",
      correlationId: "request-fallback",
      traceContext: null,
    });
    const access = accessRecords(records)[0];
    expect(access).toMatchObject({ request_id: "request-fallback", correlation_id: "request-fallback" });
    for (const key of ["trace_id", "logging.googleapis.com/trace", "logging.googleapis.com/spanId"]) {
      expect(access?.[key]).toBeUndefined();
    }
  });

  it.each([
    ["default", { level: 30 }],
    [
      "gcp",
      {
        severity: "INFO",
        "logging.googleapis.com/trace": TRACE_ID,
        "logging.googleapis.com/trace_sampled": true,
      },
    ],
    ["aws", { level: 30, xray_trace_id: `1-${TRACE_ID.slice(0, 8)}-${TRACE_ID.slice(8)}` }],
    ["azure", { level: 30, operation_Id: TRACE_ID, operation_ParentId: PARENT_ID }],
  ] as const)("protects %s-owned fields and retains inactive profile-shaped fields", async (preset, canonical) => {
    const spoofed = {
      level: "spoofed-level",
      severity: "spoofed-severity",
      httpRequest: { spoofed: true },
      "logging.googleapis.com/trace": "spoofed-gcp-trace",
      "logging.googleapis.com/trace_sampled": false,
      xray_trace_id: "spoofed-xray-trace",
      operation_Id: "spoofed-azure-operation",
      operation_ParentId: "spoofed-azure-parent",
    };
    const { app, records } = await buildTestApp({ extraFields: () => ({ ...spoofed }) }, { preset });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info({ ...spoofed }, "handler");
      return { ok: true };
    });
    await app.inject({ url: "/", headers: { traceparent: TRACEPARENT } });
    const handler = records.find((candidate) => candidate.message === "handler");
    const access = accessRecords(records)[0];
    const shared = {
      trace_id: TRACE_ID,
      parent_id: PARENT_ID,
      trace_flags: "01",
      trace_sampled: true,
      ...spoofed,
      ...canonical,
    };
    expect(handler).toMatchObject(shared);
    expect(access).toMatchObject(
      preset === "gcp" ? { ...shared, httpRequest: { requestMethod: "GET", status: 200 } } : shared,
    );
  });

  it("propagates an unsampled W3C flag to both neutral and GCP correlation fields", async () => {
    const { app, records } = await buildTestApp({}, { preset: "gcp" });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("unsampled handler");
      return request.observability;
    });

    const response = await app.inject({
      url: "/",
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-02` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ traceContext: { flags: "02", sampled: false } });
    for (const record of [
      records.find((candidate) => candidate.message === "unsampled handler"),
      accessRecords(records)[0],
    ]) {
      expect(record).toMatchObject({
        trace_flags: "02",
        trace_sampled: false,
        "logging.googleapis.com/trace_sampled": false,
      });
      expect(record?.["trace_id_random"]).toBeUndefined();
    }
  });

  it("projects the random trace-ID flag only in explicit Level 2 mode", async () => {
    const { app, records } = await buildTestApp({ traceContextLevel: 2 }, { preset: "gcp" });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("level 2 handler");
      return request.observability;
    });

    const response = await app.inject({
      url: "/",
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-03` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      traceContext: { flags: "03", sampled: true, traceContextLevel: 2, traceIdRandom: true },
    });
    for (const record of [
      records.find((candidate) => candidate.message === "level 2 handler"),
      accessRecords(records)[0],
    ]) {
      expect(record).toMatchObject({ trace_flags: "03", trace_sampled: true, trace_id_random: true });
    }
  });

  it.each([
    ["aws", { xray_trace_id: `1-${TRACE_ID.slice(0, 8)}-${TRACE_ID.slice(8)}` }, ["operation_Id"]],
    ["azure", { operation_Id: TRACE_ID, operation_ParentId: PARENT_ID }, ["xray_trace_id"]],
  ] as const)("composes the %s provider fields with explicit Level 2 correlation", async (preset, expected, absent) => {
    const { app, records } = await buildTestApp({ traceContextLevel: 2 }, { preset });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("handler");
      return { ok: true };
    });

    const response = await app.inject({
      url: "/",
      headers: { "x-request-id": "trace-request", traceparent: `00-${TRACE_ID}-${PARENT_ID}-03` },
    });

    expect(response.statusCode).toBe(200);
    for (const record of [records.find((candidate) => candidate.message === "handler"), accessRecords(records)[0]]) {
      expect(record).toMatchObject({
        request_id: "trace-request",
        correlation_id: TRACE_ID,
        trace_flags: "03",
        trace_sampled: true,
        trace_id_random: true,
        ...expected,
      });
      for (const key of absent) {
        expect(record?.[key]).toBeUndefined();
      }
    }
  });

  it.each([
    "aws",
    "azure",
  ] as const)("omits %s provider correlation when duplicate traceparent lines are ambiguous", async (preset) => {
    const { app, records } = await buildTestApp({ traceContextLevel: 2 }, { preset });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("handler");
      return { ok: true };
    });

    const response = await app.inject({
      url: "/",
      headers: {
        "x-request-id": "duplicate-trace",
        traceparent: [`00-${TRACE_ID}-${PARENT_ID}-03`, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"],
      },
    });

    expect(response.statusCode).toBe(200);
    for (const record of [records.find((candidate) => candidate.message === "handler"), accessRecords(records)[0]]) {
      expect(record).toMatchObject({ request_id: "duplicate-trace", correlation_id: "duplicate-trace" });
      for (const key of [
        "trace_id",
        "parent_id",
        "trace_flags",
        "trace_sampled",
        "trace_id_random",
        "xray_trace_id",
        "operation_Id",
        "operation_ParentId",
      ]) {
        expect(record?.[key]).toBeUndefined();
      }
    }
  });

  it.each([
    "default",
    "gcp",
  ] as const)("uses final response status and omits rich observed error details by default for %s", async (preset) => {
    const { app, lines, records } = await buildTestApp({}, { preset });
    apps.push(app);
    app.get("/translated", async () => {
      const cause = Object.assign(new Error("root-cause-canary"), { code: "E_ROOT_CAUSE" });
      throw Object.assign(new Error("translated-failure-canary", { cause }), {
        metadata: { token: "error-token-canary" },
      });
    });
    app.setErrorHandler((_error, _request, reply) => reply.code(418).send({ handled: true }));
    const response = await app.inject("/translated");
    expect(response.statusCode).toBe(418);
    const access = accessRecords(records)[0];
    expect(access).toMatchObject(preset === "gcp" ? { severity: "WARNING", status: 418 } : { level: 40, status: 418 });
    expect(access).not.toHaveProperty("err");
    const line = lines.find((candidate) => candidate.includes('"message":"request completed"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("translated-failure-canary");
    expect(line).not.toContain("root-cause-canary");
    expect(line).not.toContain("error-token-canary");
  });

  it("emits rich terminal errors only with explicit capture and applies root redaction", async () => {
    const { app, lines, records } = await buildTestApp(
      { captureError: true },
      {
        redact: {
          paths: ['["err"].message', 'err["stack"]', 'err.metadata["token"]'],
          remove: true,
        },
      },
    );
    apps.push(app);
    app.get("/translated", async () => {
      throw Object.assign(new Error("redacted-error-canary"), {
        metadata: { token: "redacted-token-canary", retained: "diagnostic-code" },
      });
    });
    app.setErrorHandler((_error, _request, reply) => reply.code(418).send({ handled: true }));

    const response = await app.inject("/translated");

    expect(response.statusCode).toBe(418);
    const access = accessRecords(records)[0];
    expect(access).toMatchObject({
      level: 40,
      status: 418,
      err: { type: "Error", metadata: { retained: "diagnostic-code" } },
    });
    const error = access?.["err"] as Record<string, unknown> | undefined;
    expect(error).not.toHaveProperty("message");
    expect(error).not.toHaveProperty("stack");
    const line = lines.find((candidate) => candidate.includes('"message":"request completed"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("redacted-error-canary");
    expect(line).not.toContain("redacted-token-canary");
    expect(topLevelKeyOccurrences(line as string, "err")).toBe(1);
  });

  it("keeps privacy-bearing request fields disabled by default without losing structural access data", async () => {
    const { app, lines, records } = await buildTestApp(
      {},
      {
        preset: "gcp",
      },
    );
    apps.push(app);
    app.get("/customers/:id", () => ({ ok: true }));

    const response = await app.inject({
      url: "/customers/private-path-canary",
      headers: { "user-agent": "private-agent-canary" },
    });

    expect(response.statusCode).toBe(200);
    const access = accessRecords(records)[0];
    expect(access).toMatchObject({
      method: "GET",
      path_template: "/customers/{id}",
      status: 200,
      httpRequest: { requestMethod: "GET", status: 200 },
    });
    expect(access).not.toHaveProperty("path");
    expect(access).not.toHaveProperty("peer_ip");
    expect(access).not.toHaveProperty("user_agent");
    expect(access?.["httpRequest"]).not.toHaveProperty("requestUrl");
    expect(access?.["httpRequest"]).not.toHaveProperty("remoteIp");
    expect(access?.["httpRequest"]).not.toHaveProperty("userAgent");
    const line = lines.find((candidate) => candidate.includes('"message":"request completed"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("private-path-canary");
    expect(line).not.toContain("private-agent-canary");
    expect(line).not.toContain("127.0.0.1");
  });

  it("keeps path and user-agent capture as independent explicit opt-ins", async () => {
    const pathOnly = await buildTestApp({ capturePath: true }, { preset: "gcp" });
    const agentOnly = await buildTestApp({ captureUserAgent: true }, { preset: "gcp" });
    apps.push(pathOnly.app, agentOnly.app);
    pathOnly.app.get("/private", () => ({ ok: true }));
    agentOnly.app.get("/private", () => ({ ok: true }));

    await pathOnly.app.inject({ url: "/private?secret=yes", headers: { "user-agent": "agent/1" } });
    await agentOnly.app.inject({ url: "/private?secret=yes", headers: { "user-agent": "agent/1" } });
    await agentOnly.app.inject({ url: "/private", headers: { "user-agent": "agent\tcomment" } });

    const pathRecord = accessRecords(pathOnly.records)[0];
    expect(pathRecord).toMatchObject({ path: "/private", httpRequest: { requestUrl: "/private" } });
    expect(pathRecord).not.toHaveProperty("user_agent");
    expect(pathRecord?.["httpRequest"]).not.toHaveProperty("userAgent");
    const [agentRecord, tabAgentRecord] = accessRecords(agentOnly.records);
    expect(agentRecord).toMatchObject({ user_agent: "agent/1", httpRequest: { userAgent: "agent/1" } });
    expect(tabAgentRecord).toMatchObject({
      user_agent: "agent\tcomment",
      httpRequest: { userAgent: "agent\tcomment" },
    });
    expect(agentRecord).not.toHaveProperty("path");
    expect(agentRecord?.["httpRequest"]).not.toHaveProperty("requestUrl");
  });

  it("honors a debug level selected by levelForStatus", async () => {
    const levelForStatus = vi.fn((status: number) => (status === 201 ? ("debug" as const) : ("info" as const)));
    const { app, records } = await buildTestApp({ levelForStatus });
    apps.push(app);
    app.post("/items", (_request, reply) => reply.code(201).send({ ok: true }));

    expect((await app.inject({ method: "POST", url: "/items" })).statusCode).toBe(201);
    expect(levelForStatus).toHaveBeenCalledOnce();
    expect(levelForStatus).toHaveBeenCalledWith(201);
    expect(accessRecords(records)).toEqual([expect.objectContaining({ level: 20, status: 201 })]);
  });

  it("preserves contextual extra fields and omits exact reserved fields", async () => {
    const { app, lines, records } = await buildTestApp({
      extraFields: () => ({
        component: "catalog",
        status: 999,
        "logging.googleapis.com/future": "future-value",
        "logging.googleapis.com/labels": { component: "worker" },
        "logging.googleapis.com/spanId": "application-span",
        "obs.internal": true,
        _obs_internal: "application-value",
        remote_ip: "203.0.113.10",
        req: { headers: "secret" },
        ["__proto__"]: "bad",
        constructor: "bad",
        prototype: "bad",
      }),
    });
    apps.push(app);
    app.get("/items", () => ({ ok: true }));
    expect((await app.inject("/items")).statusCode).toBe(200);
    const access = accessRecords(records)[0];
    expect(access).toMatchObject({
      level: 30,
      status: 200,
      component: "catalog",
      "logging.googleapis.com/future": "future-value",
      "logging.googleapis.com/labels": { component: "worker" },
      "logging.googleapis.com/spanId": "application-span",
      "obs.internal": true,
      _obs_internal: "application-value",
      remote_ip: "203.0.113.10",
    });
    for (const key of ["req", "__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(access ?? {}, key)).toBe(false);
    }
    const line = lines.find((candidate) => candidate.includes('"message":"request completed"'));
    expect(line).toBeDefined();
    for (const key of [
      "status",
      "logging.googleapis.com/future",
      "logging.googleapis.com/labels",
      "logging.googleapis.com/spanId",
      "obs.internal",
      "_obs_internal",
      "remote_ip",
    ]) {
      expect(topLevelKeyOccurrences(line ?? "", key)).toBe(1);
    }
  });

  it("falls back when callbacks fail without changing the response", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const levelForStatus = vi.fn(() => "invalid" as never);
    const extraFields = vi.fn(() => {
      throw new Error("callback failure");
    });
    const { app, records } = await buildTestApp({
      levelForStatus,
      extraFields,
    });
    apps.push(app);
    app.get("/", () => ({ ok: true }));
    const first = await app.inject("/");
    const second = await app.inject("/");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const access = accessRecords(records);
    expect(access).toHaveLength(2);
    expect(access).toEqual([
      expect.objectContaining({ level: 30, status: 200 }),
      expect.objectContaining({ level: 30, status: 200 }),
    ]);
    expect(levelForStatus).toHaveBeenCalledTimes(2);
    expect(levelForStatus).toHaveBeenNthCalledWith(1, 200);
    expect(levelForStatus).toHaveBeenNthCalledWith(2, 200);
    expect(extraFields).toHaveBeenCalledTimes(2);
    const diagnostics = diagnosticRecords(records);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((record) => record.level === 40)).toBe(true);
    expect(diagnosticKinds(records).sort()).toEqual(["extra_fields", "level_callback"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("contains a finish-clock failure and emits a deterministic zero duration", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let calls = 0;
    const { app, records } = await buildTestApp({
      clock: () => {
        if (calls++ === 0) {
          return 1_000;
        }
        throw new Error("clock secret must not escape");
      },
    });
    apps.push(app);
    app.get("/", () => ({ ok: true }));

    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(records)[0]).toMatchObject({ duration_ms: 0 });
    expect(diagnosticKinds(records)).toEqual(["clock"]);
    expect(JSON.stringify(records)).not.toContain("clock secret must not escape");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("emits one terminal record after a successful response stream completes", async () => {
    const { app, records } = await buildTestApp({ capturePath: true });
    apps.push(app);
    app.get("/stream", () => Readable.from(["one", "two"]));
    expect((await app.inject("/stream")).body).toBe("onetwo");

    expect(accessRecords(records)).toEqual([
      expect.objectContaining({ status: 200, path: "/stream", path_template: "/stream" }),
    ]);
  });

  it("observes only the final payload after route onSend replacement", async () => {
    const { app, records } = await buildTestApp({ captureError: true });
    apps.push(app);
    app.get(
      "/replaced-stream",
      {
        onSend: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          return "healthy";
        },
      },
      () => {
        const discarded = new PassThrough();
        discarded.on("error", () => undefined);
        setTimeout(() => discarded.destroy(new Error("discarded stream")), 5);
        return discarded;
      },
    );

    const response = await app.inject("/replaced-stream");
    expect(response).toMatchObject({ statusCode: 200, body: "healthy" });
    const access = accessRecords(records);
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ status: 200, path_template: "/replaced-stream" });
    expect(access[0]?.["terminal_reason"]).toBeUndefined();
    expect(access[0]?.["err"]).toBeUndefined();
  });

  it("does not attribute a discarded stream failure added before a later onRoute transformation", async () => {
    const { app, records } = await buildTestApp({ captureError: true });
    apps.push(app);
    app.addHook("onRoute", (routeOptions) => {
      const replacement: onSendHookHandler = async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return "healthy";
      };
      const existing = routeOptions.onSend;
      routeOptions.onSend =
        existing === undefined
          ? replacement
          : Array.isArray(existing)
            ? [...existing, replacement]
            : [existing, replacement];
    });
    app.get("/late-replaced-stream", () => {
      const discarded = new PassThrough();
      discarded.on("error", () => undefined);
      setTimeout(() => discarded.destroy(new Error("discarded stream")), 5);
      return discarded;
    });

    const response = await app.inject("/late-replaced-stream");
    expect(response).toMatchObject({ statusCode: 200, body: "healthy" });
    const access = accessRecords(records);
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ status: 200, path_template: "/late-replaced-stream" });
    expect(access[0]?.["terminal_reason"]).toBeUndefined();
    expect(access[0]?.["err"]).toBeUndefined();
  });

  it("emits a query-free 404 record without inventing a route template", async () => {
    const { app, records } = await buildTestApp({ capturePath: true });
    apps.push(app);

    expect((await app.inject("/missing?private=yes")).statusCode).toBe(404);

    const missing = accessRecords(records)[0];
    expect(missing).toMatchObject({ status: 404, path: "/missing" });
    expect(missing?.["path_template"]).toBeUndefined();
  });

  it("extracts the routed path without retaining request-target fragment syntax", async () => {
    const { app, lines, records } = await buildTestApp({ capturePath: true });
    apps.push(app);
    app.get("/items", () => ({ ok: true }));

    expect((await app.inject("/items#PATH_FRAGMENT_SECRET")).statusCode).toBe(200);

    expect(accessRecords(records)).toEqual([
      expect.objectContaining({ status: 200, path: "/items", path_template: "/items" }),
    ]);
    expect(lines.join("\n")).not.toContain("PATH_FRAGMENT_SECRET");
  });

  it("keeps representative parameter and catch-all identity stable across request values", async () => {
    const { app, records } = await buildTestApp();
    apps.push(app);
    const longName = "a".repeat(65);
    app.get("/items/:item_id", { schema: { operationId: "get_item" } as never }, () => ({ ok: true }));
    app.get(`/long/:${longName}`, { schema: { operationId: "get_long" } as never }, () => ({ ok: true }));
    app.get("/choice/:id((?:foo|bar))", { schema: { operationId: "get_choice" } as never }, () => ({ ok: true }));
    app.get("/digit/:123", { schema: { operationId: "get_digit" } as never }, () => ({ ok: true }));
    app.get("/unicode/:ümlaut", { schema: { operationId: "get_unicode" } as never }, () => ({ ok: true }));
    app.get("/punctuation/:$id", { schema: { operationId: "get\tpunctuation" } as never }, () => ({ ok: true }));
    app.get("/regex/:id(^foo\\/bar$)", { schema: { operationId: "get_regex" } as never }, () => ({ ok: true }));
    app.get("/name::verb", { schema: { operationId: "get_literal_colon" } as never }, () => ({ ok: true }));
    app.get("/name::::verb", { schema: { operationId: "get_two_literal_colons" } as never }, () => ({ ok: true }));
    app.get("/posts/:id?", { schema: { operationId: "get_optional" } as never }, () => ({ ok: true }));
    app.get("/composite/:filename.:ext", { schema: { operationId: "get_composite" } as never }, () => ({ ok: true }));
    app.get("/coords/:lat-:lng", { schema: { operationId: "get_coordinates" } as never }, () => ({ ok: true }));
    app.get("/files/*", { schema: { operationId: "get_file" } as never }, () => ({ ok: true }));

    expect((await app.inject("/items/tenant-a")).statusCode).toBe(200);
    expect((await app.inject("/items/tenant-b")).statusCode).toBe(200);
    expect((await app.inject("/long/value")).statusCode).toBe(200);
    expect((await app.inject("/choice/foo")).statusCode).toBe(200);
    expect((await app.inject("/digit/value")).statusCode).toBe(200);
    expect((await app.inject("/unicode/value")).statusCode).toBe(200);
    expect((await app.inject("/punctuation/value")).statusCode).toBe(200);
    expect((await app.inject("/regex/foo%2Fbar")).statusCode).toBe(200);
    expect((await app.inject("/name:verb")).statusCode).toBe(200);
    expect((await app.inject("/name::verb")).statusCode).toBe(200);
    expect((await app.inject("/posts")).statusCode).toBe(200);
    expect((await app.inject("/posts/42")).statusCode).toBe(200);
    expect((await app.inject("/composite/report.csv")).statusCode).toBe(200);
    expect((await app.inject("/composite/photo.jpg")).statusCode).toBe(200);
    expect((await app.inject("/coords/60-25")).statusCode).toBe(200);
    expect((await app.inject("/files/tenant-a/one")).statusCode).toBe(200);
    expect((await app.inject("/files/tenant-b/two")).statusCode).toBe(200);

    expect(accessRecords(records).map(({ path_template, operation_id }) => ({ path_template, operation_id }))).toEqual([
      { path_template: "/items/{item_id}", operation_id: "get_item" },
      { path_template: "/items/{item_id}", operation_id: "get_item" },
      { path_template: `/long/{${longName}}`, operation_id: "get_long" },
      { path_template: "/choice/{id}", operation_id: "get_choice" },
      { path_template: "/digit/{123}", operation_id: "get_digit" },
      { path_template: "/unicode/{ümlaut}", operation_id: "get_unicode" },
      { path_template: "/punctuation/{$id}", operation_id: "get\tpunctuation" },
      { path_template: "/regex/{id}", operation_id: "get_regex" },
      { path_template: "/name:verb", operation_id: "get_literal_colon" },
      { path_template: "/name::verb", operation_id: "get_two_literal_colons" },
      { path_template: "/posts/:id?", operation_id: "get_optional" },
      { path_template: "/posts/:id?", operation_id: "get_optional" },
      { path_template: "/composite/:filename.:ext", operation_id: "get_composite" },
      { path_template: "/composite/:filename.:ext", operation_id: "get_composite" },
      { path_template: "/coords/:lat-:lng", operation_id: "get_coordinates" },
      { path_template: "/files/{*path}", operation_id: "get_file" },
      { path_template: "/files/{*path}", operation_id: "get_file" },
    ]);
  });

  it("can disable only the response request-ID header", async () => {
    const { app, records } = await buildTestApp({ responseHeader: false });
    apps.push(app);
    app.get("/", (request) => request.observability);
    const response = await app.inject("/");
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeUndefined();
    expect(isValidRequestId(response.json().requestId)).toBe(true);
    expect(accessRecords(records)).toHaveLength(1);
  });

  it("does no access enrichment work when the canonical logger is silent", async () => {
    const levelForStatus = vi.fn(() => "error" as const);
    const extraFields = vi.fn(() => {
      throw new Error("access enrichment should not execute");
    });
    const { app, records } = await buildTestApp({ extraFields, levelForStatus }, { level: "silent" });
    apps.push(app);
    app.get("/", (request) => {
      request.log.info("application record should be filtered");
      return request.observability;
    });

    const response = await app.inject("/");

    expect(response.statusCode).toBe(200);
    expect(isValidRequestId(response.headers["x-request-id"])).toBe(true);
    expect(levelForStatus).not.toHaveBeenCalled();
    expect(extraFields).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("skips enrichment at a filtered real Pino level and retains enabled error access records", async () => {
    const extraFields = vi.fn(() => ({ deployment: "production" }));
    const { app, records } = await buildTestApp({ extraFields }, { level: "error" });
    apps.push(app);
    app.get("/healthy", (_request, reply) => reply.code(204).send());
    app.get("/unavailable", (_request, reply) => reply.code(503).send({ unavailable: true }));

    expect((await app.inject("/healthy")).statusCode).toBe(204);
    expect(extraFields).not.toHaveBeenCalled();
    expect(accessRecords(records)).toHaveLength(0);

    expect((await app.inject("/unavailable")).statusCode).toBe(503);
    expect(extraFields).toHaveBeenCalledOnce();
    expect(accessRecords(records)).toEqual([
      expect.objectContaining({ level: 50, status: 503, deployment: "production" }),
    ]);
  });

  it("suppresses the access record for the legacy reqId label without failing traffic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app, records } = await buildTestApp({}, { canonicalLabel: false });
    apps.push(app);
    app.get("/", () => ({ ok: true }));
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect(diagnosticKinds(records)).toEqual(["legacy_request_id_label"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(accessRecords(records)).toHaveLength(0);
  });

  it("uses stderr only when the canonical logger throws synchronously while diagnosing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app, records } = await buildTestApp({}, { canonicalLabel: false });
    apps.push(app);
    Object.defineProperty(app.log, "warn", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("logger failed");
      },
    });
    app.get("/", () => ({ ok: true }));

    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(records)).toHaveLength(0);
    expect(diagnosticRecords(records)).toHaveLength(0);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      "fastify-observability: configure LogController requestIdLogLabel as request_id; package access record omitted\n",
    );
  });

  it("preserves traffic when both Pino and stderr fail while diagnosing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("stderr failed");
    });
    const { app, records } = await buildTestApp({}, { canonicalLabel: false });
    apps.push(app);
    Object.defineProperty(app.log, "warn", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("logger failed");
      },
    });
    app.get("/", () => ({ ok: true }));

    const responses = await Promise.all([app.inject("/"), app.inject("/")]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(accessRecords(records)).toHaveLength(0);
    expect(diagnosticRecords(records)).toHaveLength(0);
    expect(stderr).toHaveBeenCalledOnce();
  });

  it("drops a formatter-failed access record without malformed output or response changes", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({
        destination: stream,
        serializers: {
          incident: () => {
            throw new Error("formatter secret");
          },
        },
      }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability, { extraFields: () => ({ incident: "must-not-serialize" }) });
    app.get("/", () => ({ ok: true }));

    const response = await app.inject("/");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger"]);
    for (const line of stream.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(stream.lines.join("\n")).not.toContain("formatter secret");
    expect(stream.lines.join("\n")).not.toContain("must-not-serialize");
  });

  it("preserves the original handler error when access formatting fails", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({
        destination: stream,
        serializers: {
          incident: () => {
            throw new Error("formatter failed");
          },
        },
      }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability, { extraFields: () => ({ incident: "checkout" }) });
    const sentinel = new Error("application sentinel");
    let observed: unknown;
    app.setErrorHandler((error, _request, reply) => {
      observed = error;
      return reply.code(418).send({ handled: true });
    });
    app.get("/", () => {
      throw sentinel;
    });

    const response = await app.inject("/");

    expect(observed).toBe(sentinel);
    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({ handled: true });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger"]);
  });

  it("serializes supported Pino bindings exactly once in the raw access line", async () => {
    const stream = new JsonLineStream();
    const service = { name: "api", metadata: { request_id: "nested-application-value" } };
    const app = Fastify({
      loggerInstance: createObservabilityLogger({
        preset: "gcp",
        level: "debug",
        base: { component: "catalog", service, note: 'literal "request_id": marker' },
        destination: stream,
      }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability, {
      capturePath: true,
      capturePeerIp: true,
      captureUserAgent: true,
      extraFields: () => ({
        component: "catalog",
        service: { name: "api", metadata: { request_id: "nested-application-value" } },
        release_channel: "stable",
      }),
    });
    app.get("/", { schema: { operationId: "raw_access" } as never }, (request) => {
      request.log.info("raw handler");
      return { ok: true };
    });

    expect(
      (
        await app.inject({
          url: "/",
          headers: { "x-request-id": "fixed", traceparent: TRACEPARENT, "user-agent": "raw-test/1.0" },
        })
      ).statusCode,
    ).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(1);
    const accessLine = stream.lines.find(
      (line) => (JSON.parse(line) as { message?: string }).message === "request completed",
    );
    const handlerLine = stream.lines.find(
      (line) => (JSON.parse(line) as { message?: string }).message === "raw handler",
    );
    if (accessLine === undefined || handlerLine === undefined) {
      throw new Error("expected raw handler and access lines");
    }
    const correlationKeys = [
      "request_id",
      "correlation_id",
      "trace_id",
      "parent_id",
      "trace_flags",
      "trace_sampled",
      "logging.googleapis.com/trace",
      "logging.googleapis.com/trace_sampled",
      "component",
      "service",
      "note",
    ];
    for (const line of [handlerLine, accessLine]) {
      expect(JSON.parse(line)).toMatchObject({
        service: { metadata: { request_id: "nested-application-value" } },
        note: 'literal "request_id": marker',
      });
      for (const key of correlationKeys) {
        expect(topLevelKeyOccurrences(line, key)).toBe(1);
      }
    }
    expect(JSON.parse(accessLine)).toMatchObject({
      path_template: "/",
      operation_id: "raw_access",
      status: 200,
      peer_ip: "127.0.0.1",
      user_agent: "raw-test/1.0",
      release_channel: "stable",
    });
    for (const key of [
      "method",
      "path",
      "path_template",
      "operation_id",
      "status",
      "duration_ms",
      "peer_ip",
      "user_agent",
      "httpRequest",
      "release_channel",
    ]) {
      expect(topLevelKeyOccurrences(accessLine, key)).toBe(1);
    }
  });

  it("preserves traffic but omits access logging for a custom Fastify request logger", async () => {
    const stream = new JsonLineStream();
    const noop = () => undefined;
    const customRequestLogger = {
      level: "info",
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      child() {
        return this;
      },
    } as unknown as FastifyBaseLogger;
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory() {
        return customRequestLogger;
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);

    const response = await app.inject({ url: "/", headers: { "x-request-id": "still-safe" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requestId: "still-safe" });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["request_logger"]);
  });

  it("preserves traffic but omits access logging when Fastify returns a logger from another canonical root", async () => {
    const stream = new JsonLineStream();
    const foreignLogger = createObservabilityLogger({ level: "debug", destination: stream });
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(_logger, bindings, options) {
        return foreignLogger.child(bindings, options);
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);

    const response = await app.inject({ url: "/", headers: { "x-request-id": "still-safe" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requestId: "still-safe" });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["request_logger"]);
  });

  it("preserves traffic but omits access logging when Fastify binds the wrong request ID", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        return logger.child({ ...bindings, request_id: "wrong" }, options);
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);

    const response = await app.inject({ url: "/", headers: { "x-request-id": "right" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requestId: "right" });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["request_logger"]);
  });

  it("suppresses a conflicting Pino request correlation binding without failing traffic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        return logger.child({ ...bindings, correlation_id: "conflict" }, options);
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", () => ({ ok: true }));

    expect((await app.inject({ url: "/", headers: { "x-request-id": "first" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/", headers: { "x-request-id": "second" } })).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_setup"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("rejects even a safe custom request-child shape from package access logging", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        return logger.child({ ...bindings, route_tag: "catalog" }, options);
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", () => ({ ok: true }));

    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_setup"]);
    expect(
      stream.records.some((record) => record["route_tag"] === "catalog" && record.message === "request completed"),
    ).toBe(false);
  });

  it("uses the direct socket peer without consulting Fastify trust-proxy resolution", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      trustProxy: () => {
        throw new Error("proxy failure");
      },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability, { capturePeerIp: true });
    app.get("/", () => ({ ok: true }));

    const request = { url: "/", headers: { "x-forwarded-for": "203.0.113.10" } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(2);
    expect(accessRecords(stream.records).every((record) => record["peer_ip"] === "127.0.0.1")).toBe(true);
    expect(diagnosticKinds(stream.records)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("rejects an enabled non-Pino logger even when it exposes bindings", async () => {
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
      child() {
        return this;
      },
      bindings: () => ({}),
      isLevelEnabled: () => true,
    } as unknown as FastifyBaseLogger;
    const app = Fastify({
      loggerInstance: logger,
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await expect(app.register(fastifyObservability)).rejects.toThrow("createObservabilityLogger()");
  });

  it("preserves traffic when Pino request binding inspection fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        const requestLogger = logger.child(bindings, options) as FastifyBaseLogger & {
          bindings(): Record<string, unknown>;
        };
        Object.defineProperty(requestLogger, "bindings", {
          value: () => {
            throw new Error("bindings failed");
          },
        });
        return requestLogger;
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);
    const response = await app.inject({ url: "/", headers: { "x-request-id": "still-safe" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("still-safe");
    expect(response.json()).toMatchObject({ requestId: "still-safe" });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_setup"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("uses the actual returned Pino child bindings for verification", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        const requestLogger = logger.child(bindings, options) as FastifyBaseLogger & {
          bindings(): Record<string, unknown>;
        };
        const requestBindings = requestLogger.bindings();
        Object.defineProperty(requestLogger, "bindings", { value: () => requestBindings });
        return requestLogger;
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => request.observability);

    const response = await app.inject({ url: "/", headers: { "x-request-id": "still-safe" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("still-safe");
    expect(response.json()).toMatchObject({ requestId: "still-safe" });
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_setup"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    ["introduces an extra field", (current: Record<string, unknown>) => ({ ...current, injected: true })],
    ["changes a parent binding", (current: Record<string, unknown>) => ({ ...current, service: { name: "tampered" } })],
    [
      "changes a correlation binding",
      (current: Record<string, unknown>) => ({ ...current, correlation_id: "tampered" }),
    ],
  ])("rejects a package child snapshot that %s", async (_name, mutate) => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({
        level: "debug",
        base: { service: { name: "api" } },
        destination: stream,
      }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        const requestLogger = logger.child(bindings, options) as FastifyBaseLogger & {
          bindings(): Record<string, unknown>;
        };
        const nativeBindings = requestLogger.bindings;
        Object.defineProperty(requestLogger, "bindings", {
          value(this: typeof requestLogger) {
            const current = Reflect.apply(nativeBindings, this, []) as Record<string, unknown>;
            return this === requestLogger ? current : mutate(current);
          },
        });
        return requestLogger;
      },
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", () => ({ ok: true }));

    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_setup"]);
  });

  it.each([
    ["adds a binding", (initial: Record<string, unknown>) => ({ ...initial, injected: true })],
    [
      "changes a binding without changing the key count",
      (initial: Record<string, unknown>) => ({ ...initial, correlation_id: "tampered" }),
    ],
  ])("omits the terminal record when the request logger %s", async (_name, mutate) => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => {
      const logger = request.log as FastifyBaseLogger & { bindings(): Record<string, unknown> };
      const initial = logger.bindings();
      Object.defineProperty(logger, "bindings", { value: () => mutate(initial) });
      return { ok: true };
    });

    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["logger_bindings"]);
  });

  it("blocks setBindings on canonical request loggers without failing traffic", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => {
      let message = "";
      try {
        (
          request.log as unknown as FastifyBaseLogger & {
            setBindings(bindings: Record<string, unknown>): void;
          }
        ).setBindings({
          correlation_id: "changed",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : "unknown error";
      }
      return { message };
    });

    const response = await app.inject("/");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "fastify-observability canonical loggers do not allow setBindings()" });
    const access = accessRecords(stream.records);
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      request_id: response.headers["x-request-id"],
      correlation_id: response.headers["x-request-id"],
    });
  });

  it("rejects Fastify's built-in request-ID header handling", async () => {
    const unsafe = Fastify({
      loggerInstance: createObservabilityLogger({ level: "silent" }),
      requestIdHeader: "x-request-id",
    });
    apps.push(unsafe);
    await expect(unsafe.register(fastifyObservability)).rejects.toThrow("requestIdHeader: false");
  });

  it("rejects repeated registration in the root scope", async () => {
    const duplicate = Fastify({
      loggerInstance: createObservabilityLogger({ level: "silent" }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(duplicate);
    await duplicate.register(fastifyObservability);
    await expect(duplicate.register(fastifyObservability)).rejects.toThrow("exactly once");
  });

  it("rejects repeated registration from a nested scope", async () => {
    const nested = Fastify({
      loggerInstance: createObservabilityLogger({ level: "silent" }),
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

  it.each([
    ["a non-package generator", () => "unproven-id", {}],
    [
      "a package generator configured for a different header",
      createRequestIdGenerator(),
      { requestIdHeader: "x-correlation-id" },
    ],
  ] as const)("fails closed before the handler when Fastify uses %s", async (_name, genReqId, pluginOptions) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId,
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    apps.push(app);
    await app.register(fastifyObservability, pluginOptions);
    const handler = vi.fn(() => ({ ok: true }));
    app.get("/", handler);

    const responses = await Promise.all([app.inject("/"), app.inject("/")]);

    expect(responses.map((response) => response.statusCode)).toEqual([500, 500]);
    expect(responses.every((response) => response.headers["x-request-id"] === undefined)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(diagnosticKinds(stream.records)).toEqual(["request_id_setup"]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    ["an options array", [], "plugin options must be a record"],
    ["an unsupported key", { unsupported: true }, 'unsupported fastify-observability option "unsupported"'],
    [
      "the removed v1 message option",
      { message: "request completed" },
      'unsupported fastify-observability option "message"',
    ],
    ["a non-boolean path capture", { capturePath: 1 }, "capturePath must be a boolean"],
    ["a non-boolean peer capture", { capturePeerIp: 1 }, "capturePeerIp must be a boolean"],
    ["a non-boolean user-agent capture", { captureUserAgent: 1 }, "captureUserAgent must be a boolean"],
    ["a non-boolean error capture", { captureError: 1 }, "captureError must be a boolean"],
    ["an unsupported trace context level", { traceContextLevel: 3 }, "traceContextLevel must be 1 or 2"],
    ["a non-function clock", { clock: 1 }, "clock must be a function"],
    ["an invalid request-ID header", { requestIdHeader: "bad header" }, "requestIdHeader must be a valid HTTP header"],
    [
      "colliding input headers",
      { requestIdHeader: "traceparent" },
      "requestIdHeader, traceHeader, and tracestateHeader must be distinct",
    ],
    [
      "a response header colliding with traceparent",
      { responseHeader: "traceparent" },
      "responseHeader must not collide with trace headers",
    ],
    ["a non-function level callback", { levelForStatus: 1 }, "levelForStatus must be a function"],
    ["a non-function extra-fields callback", { extraFields: 1 }, "extraFields must be a function"],
  ] as const)("rejects %s", async (_name, options, expectedMessage) => {
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "silent" }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
    });
    apps.push(app);
    await expect(app.register(fastifyObservability, options as never)).rejects.toThrow(expectedMessage);
  });
});
