import { get as httpGet, request as httpRequest } from "node:http";
import { connect as connectHttp2, type IncomingHttpHeaders } from "node:http2";
import { Readable } from "node:stream";
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  isValidRequestId,
} from "fastify-observability";
import { afterEach, describe, expect, it } from "vitest";
import { accessRecords, JsonLineStream, topLevelKeyOccurrences } from "./helpers.js";

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

async function waitForAccessRecords(stream: JsonLineStream, expected: number) {
  if (accessRecords(stream.records).length < expected) {
    await new Promise<void>((resolve, reject) => {
      const onRecord = () => {
        if (accessRecords(stream.records).length >= expected) {
          clearTimeout(timeout);
          stream.removeListener("record", onRecord);
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        stream.removeListener("record", onRecord);
        reject(
          new Error(
            `timed out waiting for ${expected} access record(s); received ${accessRecords(stream.records).length}`,
          ),
        );
      }, 1_000);
      stream.on("record", onRecord);
      onRecord();
    });
  }
  return accessRecords(stream.records);
}

describe("real network lifecycle", () => {
  it("rejects duplicate request IDs over HTTP/1.1 and isolates concurrent requests", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
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
    const responseBody = JSON.parse(response.body) as { requestId: string };
    expect(responseBody.requestId).toBe(response.requestId);

    const ids = Array.from({ length: 30 }, (_, index) => `concurrent-${index}`);
    const results = await Promise.all(
      ids.map(async (id) => {
        const reply = await fetch(`http://127.0.0.1:${serverPort(app)}/`, {
          headers: { "x-request-id": id },
        });
        const body = (await reply.json()) as { requestId: string };
        return { status: reply.status, header: reply.headers.get("x-request-id"), body: body.requestId };
      }),
    );
    expect(results.map((result) => result.status)).toEqual(Array.from({ length: ids.length }, () => 200));
    expect(results.map((result) => result.header)).toEqual(ids);
    expect(results.map((result) => result.body)).toEqual(ids);
    const records = accessRecords(stream.records);
    expect(records).toHaveLength(31);
    expect(records.map((record) => record["request_id"]).sort()).toEqual([response.requestId, ...ids].sort());
  });

  it("emits one timeout record without inventing a status", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      connectionTimeout: 30,
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    let releaseSlowRoute: () => void = () => undefined;
    const slowRoute = new Promise<void>((resolve) => {
      releaseSlowRoute = resolve;
    });
    app.get("/slow", async () => {
      await slowRoute;
      return { late: true };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      await new Promise<void>((resolve) => {
        const request = httpGet(`http://127.0.0.1:${serverPort(app)}/slow`);
        request.once("error", () => resolve());
        request.once("close", () => resolve());
      });
      await waitForAccessRecords(stream, 1);
    } finally {
      releaseSlowRoute();
      try {
        await app.close();
      } finally {
        const index = openApps.indexOf(app);
        if (index !== -1) {
          openApps.splice(index, 1);
        }
      }
    }

    const records = accessRecords(stream.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 50, terminal_reason: "timeout" });
    expect(records[0]?.["status"]).toBeUndefined();
    const line = stream.lines.find(
      (candidate) => (JSON.parse(candidate) as { message?: string }).message === "request completed",
    );
    if (line === undefined) {
      throw new Error("expected one raw timeout record");
    }
    expect(topLevelKeyOccurrences(line, "terminal_reason")).toBe(1);
    expect(topLevelKeyOccurrences(line, "status")).toBe(0);
  });

  it("emits one request-aborted record for an incomplete upload", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
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
      request.once("close", () => resolve());
      request.write("partial");
      setTimeout(() => request.destroy(), 10);
    });
    const records = await waitForAccessRecords(stream, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 40, terminal_reason: "request_aborted" });
    expect(records[0]?.["status"]).toBeUndefined();
    expect(records[0]?.["err"]).toBeUndefined();
  });

  it("supports h2c and treats duplicate HTTP/2 request IDs as invalid", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      http2: true,
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/h2", (request) => ({ requestId: request.observability.requestId }));
    await app.listen({ host: "127.0.0.1", port: 0 });

    const session = connectHttp2(`http://127.0.0.1:${serverPort(app)}`);
    const result = await (async () => {
      try {
        return await new Promise<{ body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
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
      } finally {
        session.destroy();
      }
    })();
    const body = JSON.parse(result.body) as { requestId: string };
    expect(body.requestId).not.toBe("one");
    expect(body.requestId).not.toBe("two");
    expect(isValidRequestId(body.requestId)).toBe(true);
    expect(result.headers["x-request-id"]).toBe(body.requestId);
    const records = await waitForAccessRecords(stream, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: body.requestId,
      method: "GET",
      path: "/h2",
      status: 200,
    });
    expect(records[0]?.["terminal_reason"]).toBeUndefined();
  });

  it("records a failing response stream once after headers are sent", async () => {
    const stream = new JsonLineStream();
    const app = Fastify({
      loggerInstance: createObservabilityLogger({ level: "debug", destination: stream }),
      requestIdHeader: false,
      genReqId: createRequestIdGenerator(),
      logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    });
    openApps.push(app);
    await app.register(fastifyObservability);
    app.get("/broken", (_request, reply) => {
      let started = false;
      const body = new Readable({
        read() {
          if (started) {
            return;
          }
          started = true;
          this.push("partial");
          setTimeout(() => this.destroy(new Error("stream exploded")), 10);
        },
      });
      return reply.type("text/plain").send(body);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const endedNormally = await new Promise<boolean>((resolve) => {
      const request = httpGet(`http://127.0.0.1:${serverPort(app)}/broken`, (response) => {
        response.resume();
        response.once("end", () => resolve(true));
        response.once("aborted", () => resolve(false));
        response.once("error", () => resolve(false));
        response.once("close", () => {
          if (!response.complete) {
            resolve(false);
          }
        });
      });
      request.once("error", () => resolve(false));
    });
    expect(endedNormally).toBe(false);
    const records = await waitForAccessRecords(stream, 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 50,
      status: 200,
      terminal_reason: "response_aborted",
      err: { message: "stream exploded" },
    });
    const line = stream.lines.find(
      (candidate) => (JSON.parse(candidate) as { message?: string }).message === "request completed",
    );
    if (line === undefined) {
      throw new Error("expected one raw response-aborted record");
    }
    for (const key of ["status", "terminal_reason", "err"]) {
      expect(topLevelKeyOccurrences(line, key)).toBe(1);
    }
  });
});
