import { EventEmitter } from "node:events";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { type AccessState, cleanupListeners, emitAccessRecord, observeStream, requestPath } from "../src/access.js";
import type { NormalizedOptions } from "../src/context.js";

describe("access helpers", () => {
  it.each([
    [undefined, "/"],
    ["", "/"],
    ["*", "*"],
    ["/items/a%3Fb?secret=yes", "/items/a%3Fb"],
    ["https://attacker.example/path?secret=yes", "/path"],
    ["http://[invalid", "/"],
  ])("derives a private path from %s", (input, expected) => {
    expect(requestPath(input)).toBe(expected);
  });

  it("observes stream errors and removes listeners", () => {
    const stream = new EventEmitter();
    const raw = new EventEmitter();
    const state = {
      stream: undefined,
      streamErrorListener: undefined,
      closeListener: vi.fn(),
      reply: { raw },
    } as unknown as AccessState;
    raw.on("close", state.closeListener as () => void);
    observeStream(state, stream);
    const error = new Error("stream failed");
    stream.emit("error", error);
    expect(state.error).toBe(error);
    cleanupListeners(state);
    expect(stream.listenerCount("error")).toBe(0);
    expect(raw.listenerCount("close")).toBe(0);
  });

  it("ignores values that are not streams", () => {
    const state = {} as AccessState;
    observeStream(state, null);
    observeStream(state, {});
    expect(state.stream).toBeUndefined();
  });

  it("contains hostile stream listener methods", () => {
    const diagnose = vi.fn();
    const state = {
      diagnose,
      reply: { raw: new EventEmitter() },
    } as unknown as AccessState;
    const stream = {
      once: () => {
        throw new Error("attach failed");
      },
      removeListener: () => {
        throw new Error("cleanup failed");
      },
    };
    expect(() => observeStream(state, stream)).not.toThrow();
    expect(state.stream).toBeUndefined();
    expect(diagnose).toHaveBeenCalledWith("stream_listener", expect.any(String));
  });

  function accessState(overrides: Partial<AccessState> = {}): {
    state: AccessState;
    log: ReturnType<typeof vi.fn>;
    diagnose: ReturnType<typeof vi.fn>;
  } {
    const log = vi.fn();
    const diagnose = vi.fn();
    const raw = new EventEmitter() as EventEmitter & {
      url?: string;
      rawHeaders: string[];
      removeListener(event: string, listener: (...args: unknown[]) => void): EventEmitter;
    };
    raw.url = "/resource?secret=yes";
    raw.rawHeaders = [];
    const request = {
      method: "GET",
      raw,
      is404: false,
      routeOptions: { url: "/resource", schema: {} },
      ip: "127.0.0.1",
    } as unknown as FastifyRequest;
    const replyRaw = new EventEmitter();
    const reply = { raw: replyRaw } as unknown as FastifyReply;
    const options: NormalizedOptions = Object.freeze({
      preset: "default",
      requestIdHeader: "x-request-id",
      responseHeader: "x-request-id",
      traceHeader: "traceparent",
      tracestateHeader: "tracestate",
      message: "request completed",
    });
    const logger = { debug: log, info: log, warn: log, error: log } as unknown as FastifyBaseLogger;
    return {
      state: {
        started: performance.now(),
        request,
        reply,
        options,
        diagnose,
        logger,
        remoteIp: "127.0.0.1",
        userAgent: undefined,
        emitted: false,
        suppressAccess: false,
        ...overrides,
      },
      log,
      diagnose,
    };
  }

  it("emits abnormal terminal records at most once", () => {
    const { state, log } = accessState();
    emitAccessRecord(state, "request_aborted");
    emitAccessRecord(state, "response", 200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ terminal_reason: "request_aborted" });
  });

  it("uses error level for timeout and captured stream errors", () => {
    const timeout = accessState();
    emitAccessRecord(timeout.state, "timeout");
    expect(timeout.log.mock.calls[0]?.[0]).toMatchObject({ terminal_reason: "timeout" });

    const stream = accessState({ error: new Error("broken") });
    emitAccessRecord(stream.state, "response_aborted", 200);
    expect(stream.log.mock.calls[0]?.[0]).toMatchObject({ status: 200, terminal_reason: "response_aborted" });
  });

  it("suppresses conflicted access logs and contains logger failures", () => {
    const suppressed = accessState({ suppressAccess: true });
    emitAccessRecord(suppressed.state, "response", 200);
    expect(suppressed.log).not.toHaveBeenCalled();

    const failed = accessState();
    failed.log.mockImplementation(() => {
      throw new Error("logger failed");
    });
    emitAccessRecord(failed.state, "response", 503);
    expect(failed.diagnose).toHaveBeenCalledWith("logger", expect.any(String));
  });

  it("omits invalid extra fields as one unit", () => {
    const invalid = accessState();
    const options = { ...invalid.state.options, extraFields: () => [] as never };
    const state = { ...invalid.state, options };
    emitAccessRecord(state, "response", 200);
    expect(invalid.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));

    const throwing = accessState();
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("blocked");
        },
      },
    );
    emitAccessRecord(
      { ...throwing.state, options: { ...throwing.state.options, extraFields: () => proxy } },
      "response",
      200,
    );
    expect(throwing.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));
  });
});
