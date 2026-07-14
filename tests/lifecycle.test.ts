import { get as httpGet, request as httpRequest } from "node:http";
import { connect as connectHttp2, type IncomingHttpHeaders } from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import Fastify, { LogController } from "fastify";
import fastifyObservability, { createRequestIdGenerator, isValidRequestId } from "fastify-observability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRecords, JsonLineStream } from "./helpers.js";

const openApps: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function serverPort(app: { server: { address(): string | { port: number } | null } }): number {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to an IP port");
  }
  return address.port;
}

describe("real network lifecycle", () => {
  it("rejects duplicate request IDs over HTTP/1.1 and isolates concurrent requests", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      logger: { level: "debug", stream },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/", (request) => ({ requestId: request.observability.requestId }));
    await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await new Promise<{ body: string; requestId: string | undefined }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: serverPort(app),
          path: "/",
          headers: { "x-request-id": ["one", "two"] },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => {
            body += chunk;
          });
          incoming.on("end", () =>
            resolve({ body, requestId: incoming.headers["x-request-id"] as string | undefined }),
          );
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(response.requestId).not.toBe("one");
    expect(response.requestId).not.toBe("two");
    expect(isValidRequestId(response.requestId)).toBe(true);

    const ids = Array.from({ length: 30 }, (_, index) => `concurrent-${index}`);
    const results = await Promise.all(
      ids.map(async (id) => {
        const reply = await app.inject({ url: "/", headers: { "x-request-id": id } });
        return { header: reply.headers["x-request-id"], body: reply.json().requestId as string };
      }),
    );
    expect(results.map((result) => result.header)).toEqual(ids);
    expect(results.map((result) => result.body)).toEqual(ids);
    expect(accessRecords(stream.records)).toHaveLength(31);
  });

  it("emits one timeout record without inventing a status", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      connectionTimeout: 30,
      logger: { level: "debug", stream },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/slow", async () => {
      await delay(100);
      return { late: true };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    await new Promise<void>((resolve) => {
      const request = httpGet(`http://127.0.0.1:${serverPort(app)}/slow`);
      request.once("error", () => resolve());
      request.once("close", () => resolve());
    });
    await delay(120);
    const records = accessRecords(stream.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 50, terminal_reason: "timeout" });
    expect(records[0]?.["status"]).toBeUndefined();
  });

  it("emits one request-aborted record for an incomplete upload", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      logger: { level: "debug", stream },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.post("/upload", () => ({ ok: true }));
    await app.listen({ host: "127.0.0.1", port: 0 });

    await new Promise<void>((resolve) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: serverPort(app),
        path: "/upload",
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": "100" },
      });
      request.once("error", () => resolve());
      request.write("partial");
      setTimeout(() => request.destroy(), 10);
    });
    await delay(30);
    const records = accessRecords(stream.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 40, terminal_reason: "request_aborted" });
    expect(records[0]?.["status"]).toBeUndefined();
  });

  it("supports h2c and treats duplicate HTTP/2 request IDs as invalid", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      http2: true,
      logger: { level: "debug", stream },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/h2", (request) => ({ requestId: request.observability.requestId }));
    await app.listen({ host: "127.0.0.1", port: 0 });

    const session = connectHttp2(`http://127.0.0.1:${serverPort(app)}`);
    const result = await new Promise<{ body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const request = session.request({ ":path": "/h2", "x-request-id": ["one", "two"] });
      let headers: IncomingHttpHeaders = {};
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (value) => {
        headers = value;
      });
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => resolve({ body, headers }));
      request.on("error", reject);
      request.end();
    });
    session.close();
    const body = JSON.parse(result.body) as { requestId: string };
    expect(body.requestId).not.toBe("one");
    expect(body.requestId).not.toBe("two");
    expect(result.headers["x-request-id"]).toBe(body.requestId);
    expect(accessRecords(stream.records)).toHaveLength(1);
  });

  it("suppresses a conflicting base request_id without failing the response", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stream = new JsonLineStream();
    const app = Fastify({
      logger: { level: "debug", stream },
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      childLoggerFactory(logger, bindings, options) {
        return logger.child({ ...bindings, request_id: "conflict" }, options);
      },
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/", () => ({ ok: true }));
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/")).statusCode).toBe(200);
    expect(accessRecords(stream.records)).toHaveLength(0);
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
