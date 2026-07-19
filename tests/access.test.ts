import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type AccessState,
  canonicalPeerIp,
  canonicalRouteTemplate,
  cleanupListeners,
  emitAccessRecord,
  observeStream,
  requestPath,
  requestUserAgent,
} from "../src/access.js";
import type { NormalizedOptions } from "../src/context.js";

describe("access helpers", () => {
  it.each([
    ["/health", "/health"],
    ["/items/:item_id", "/items/{item_id}"],
    ["/items/:item_id(\\d+)", "/items/{item_id}"],
    ["/files/*", "/files/{*path}"],
    ["*", "/{*path}"],
    ["/items/:item_id?", undefined],
    ["/items/:item_id.:format", undefined],
    ["/files/*/suffix", undefined],
  ])("canonicalizes the current Fastify route form %s", (input, expected) => {
    expect(canonicalRouteTemplate(input)).toBe(expected);
  });

  it.each([
    [undefined, undefined],
    ["", undefined],
    ["*", undefined],
    ["/items/a%3Fb?secret=yes", "/items/a%3Fb"],
    ["/items/bad%2", undefined],
    ["/items#fragment", undefined],
    ["https://attacker.example/path?secret=yes", undefined],
    ["http://[invalid", undefined],
  ])("uses only a valid origin-form path from %s", (input, expected) => {
    expect(requestPath(input)).toBe(expected);
  });

  it.each([
    ["192.0.2.10", "192.0.2.10"],
    ["2001:0db8:0:0:0:0:0:1", "2001:db8::1"],
    ["fe80::1%eth0", undefined],
    ["internal.example", undefined],
    ["", undefined],
  ])("canonicalizes only a direct IP literal %s", (input, expected) => {
    expect(canonicalPeerIp(input)).toBe(expected);
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
    expect(state.streamFailed).toBe(true);
    cleanupListeners(state);
    expect(stream.listenerCount("error")).toBe(0);
    expect(raw.listenerCount("close")).toBe(0);
  });

  it("normalizes a non-Error stream failure without throwing it into the response lifecycle", () => {
    const stream = new EventEmitter();
    const state = {} as AccessState;

    observeStream(state, stream);
    stream.emit("error", "broken without an Error object");

    expect(state.error).toEqual(new Error("response stream failed"));
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
    const once = vi.fn(() => {
      throw new Error("attach failed");
    });
    const removeListener = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const stream = {
      once,
      removeListener,
    };
    expect(() => observeStream(state, stream)).not.toThrow();
    expect(state.stream).toBeUndefined();
    expect(once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(diagnose).toHaveBeenCalledWith("stream_listener", expect.any(String));
  });

  it("uses only one unambiguous raw User-Agent value", () => {
    const withHeaders = (rawHeaders: string[]) => ({ raw: { rawHeaders } }) as unknown as FastifyRequest;

    expect(requestUserAgent(withHeaders(["User-Agent", "catalog-client/1.0"]))).toBe("catalog-client/1.0");
    expect(requestUserAgent(withHeaders(["User-Agent", "first", "user-agent", "second"]))).toBeUndefined();
    expect(requestUserAgent(withHeaders(["User-Agent", ""]))).toBeUndefined();
    expect(requestUserAgent(withHeaders(["User-Agent", "agent/1.0\nforged"]))).toBeUndefined();
    expect(requestUserAgent(withHeaders([]))).toBeUndefined();
  });

  function accessState(overrides: Partial<AccessState> = {}): {
    state: AccessState;
    log: ReturnType<typeof vi.fn>;
    logs: {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
    isLevelEnabled: ReturnType<typeof vi.fn>;
    diagnose: ReturnType<typeof vi.fn>;
  } {
    const log = vi.fn();
    const logs = {
      debug: vi.fn((...arguments_: unknown[]) => log(...arguments_)),
      info: vi.fn((...arguments_: unknown[]) => log(...arguments_)),
      warn: vi.fn((...arguments_: unknown[]) => log(...arguments_)),
      error: vi.fn((...arguments_: unknown[]) => log(...arguments_)),
    };
    const diagnose = vi.fn();
    const isLevelEnabled = vi.fn(() => true);
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
      traceContextLevel: 1,
      capturePath: true,
      capturePeerIp: true,
      captureUserAgent: true,
      captureError: false,
      clock: () => performance.now(),
    });
    const logger = { ...logs, isLevelEnabled } as unknown as AccessState["logger"];
    return {
      state: {
        started: performance.now(),
        clock: options.clock,
        request,
        reply,
        options,
        diagnose,
        logger,
        loggerBindings: {},
        peerIp: "127.0.0.1",
        userAgent: undefined,
        streamFailed: false,
        emitted: false,
        suppressAccess: false,
        ...overrides,
      },
      log,
      logs,
      isLevelEnabled,
      diagnose,
    };
  }

  it("emits abnormal terminal records at most once", () => {
    const { state, log, logs } = accessState();
    emitAccessRecord(state, "client_disconnect");
    emitAccessRecord(state, "response", 200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(logs.error).toHaveBeenCalledOnce();
    expect(logs.warn).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toMatchObject({ terminal_reason: "client_disconnect" });
  });

  it("uses error level for every abnormal terminal reason", () => {
    const timeout = accessState();
    emitAccessRecord(timeout.state, "timeout");
    expect(timeout.logs.error).toHaveBeenCalledOnce();
    expect(timeout.logs.warn).not.toHaveBeenCalled();
    expect(timeout.log.mock.calls[0]?.[0]).toMatchObject({ terminal_reason: "timeout" });

    const streamError = new Error("broken");
    const base = accessState();
    const stream = accessState({
      error: streamError,
      options: Object.freeze({ ...base.state.options, captureError: true }),
    });
    emitAccessRecord(stream.state, "body_error", 200);
    expect(stream.logs.error).toHaveBeenCalledOnce();
    expect(stream.logs.warn).not.toHaveBeenCalled();
    expect(stream.log.mock.calls[0]?.[0]).toMatchObject({ status: 200, terminal_reason: "body_error" });
    const fields = stream.log.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(fields?.["err"]).toBe(streamError);
  });

  it.each([
    [399, "info"],
    [400, "warn"],
    [499, "warn"],
    [500, "error"],
  ] as const)("maps status %i to %s at the built-in boundaries", (status, expectedLevel) => {
    const sample = accessState();
    emitAccessRecord(sample.state, "response", status);

    expect(sample.logs[expectedLevel]).toHaveBeenCalledOnce();
    for (const [level, method] of Object.entries(sample.logs)) {
      if (level !== expectedLevel) {
        expect(method).not.toHaveBeenCalled();
      }
    }
  });

  it("emits exact monotonic and GCP HTTP timing fields", () => {
    vi.spyOn(performance, "now").mockReturnValue(2_500);
    const sample = accessState();
    const state = {
      ...sample.state,
      started: 1_000,
      options: { ...sample.state.options, preset: "gcp" as const },
      peerIp: "203.0.113.8",
      userAgent: "catalog-client/1.0",
    };

    emitAccessRecord(state, "response", 204);

    expect(sample.logs.info).toHaveBeenCalledOnce();
    expect(sample.log.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/resource",
      path_template: "/resource",
      status: 204,
      duration_ms: 1_500,
      peer_ip: "203.0.113.8",
      user_agent: "catalog-client/1.0",
      httpRequest: {
        requestMethod: "GET",
        requestUrl: "/resource",
        status: 204,
        latency: "1.5s",
        remoteIp: "203.0.113.8",
        userAgent: "catalog-client/1.0",
      },
    });
  });

  it("rounds fractional milliseconds to the nearest protobuf nanosecond", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000.000_001);
    const sample = accessState();
    const state = {
      ...sample.state,
      started: 1_000,
      options: { ...sample.state.options, preset: "gcp" as const },
    };

    emitAccessRecord(state, "response", 200);

    const fields = sample.log.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(fields?.["duration_ms"]).toBeCloseTo(0.000_001, 9);
    expect(fields?.["httpRequest"]).toMatchObject({ latency: "0.000000001s" });
  });

  it("clamps a negative duration to zero and omits an untrustworthy timeout status", () => {
    vi.spyOn(performance, "now").mockReturnValue(900);
    const sample = accessState();
    const state = {
      ...sample.state,
      started: 1_000,
      options: { ...sample.state.options, preset: "gcp" as const },
      peerIp: undefined,
    };

    emitAccessRecord(state, "timeout");

    expect(sample.logs.error).toHaveBeenCalledOnce();
    const fields = sample.log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      duration_ms: 0,
      terminal_reason: "timeout",
      httpRequest: { latency: "0s" },
    });
    expect(fields).not.toHaveProperty("status");
    expect(fields).not.toHaveProperty("peer_ip");
    expect(fields).not.toHaveProperty("user_agent");
    expect(fields["httpRequest"]).not.toHaveProperty("status");
    expect(fields["httpRequest"]).not.toHaveProperty("remoteIp");
    expect(fields["httpRequest"]).not.toHaveProperty("userAgent");
  });

  it("contains listener-cleanup failures and still emits the terminal record", () => {
    const closeListener = vi.fn();
    const streamErrorListener = vi.fn();
    const stateWithFailures = accessState({
      reply: {
        raw: {
          removeListener: () => {
            throw new Error("close cleanup failed");
          },
        },
      } as unknown as FastifyReply,
      closeListener,
      stream: {
        once: vi.fn(),
        removeListener: () => {
          throw new Error("stream cleanup failed");
        },
      },
      streamErrorListener,
    });

    emitAccessRecord(stateWithFailures.state, "response", 200);

    expect(stateWithFailures.logs.info).toHaveBeenCalledOnce();
    expect(stateWithFailures.diagnose.mock.calls.map(([kind]) => kind)).toEqual([
      "close_listener_cleanup",
      "stream_listener_cleanup",
    ]);
    expect(stateWithFailures.state.closeListener).toBeUndefined();
    expect(stateWithFailures.state.stream).toBeUndefined();
    expect(stateWithFailures.state.streamErrorListener).toBeUndefined();
  });

  it("omits a hostile operationId without suppressing the access record", () => {
    const sample = accessState();
    const schema = Object.defineProperty({}, "operationId", {
      enumerable: true,
      get: () => {
        throw new Error("schema getter failed");
      },
    });
    Reflect.set(sample.state.request.routeOptions, "schema", schema);

    emitAccessRecord(sample.state, "response", 200);

    expect(sample.logs.info).toHaveBeenCalledOnce();
    expect(sample.log.mock.calls[0]?.[0]).not.toHaveProperty("operation_id");
  });

  it("omits an operationId containing control characters", () => {
    const sample = accessState();
    Reflect.set(sample.state.request.routeOptions, "schema", { operationId: "get_item\nforged" });

    emitAccessRecord(sample.state, "response", 200);

    expect(sample.logs.info).toHaveBeenCalledOnce();
    expect(sample.log.mock.calls[0]?.[0]).not.toHaveProperty("operation_id");
  });

  it("omits all route identity for an unmatched request even if fallback metadata is present", () => {
    const sample = accessState();
    Reflect.set(sample.state.request, "is404", true);
    Reflect.set(sample.state.request.routeOptions, "url", "/fallback/:item_id");
    Reflect.set(sample.state.request.routeOptions, "schema", { operationId: "fallback" });

    emitAccessRecord(sample.state, "response", 404);

    const fields = sample.log.mock.calls[0]?.[0];
    expect(fields).not.toHaveProperty("path_template");
    expect(fields).not.toHaveProperty("operation_id");
  });

  it("does not evaluate bindings or application callbacks after access suppression", () => {
    const inspectLoggerBindings = vi.fn(() => ({}));
    const levelForStatus = vi.fn(() => "debug" as const);
    const extraFields = vi.fn(() => ({ unexpected: true }));
    const closeListener = vi.fn();
    const streamErrorListener = vi.fn();
    const stream = new EventEmitter();
    const suppressed = accessState({
      suppressAccess: true,
      inspectLoggerBindings,
    });
    suppressed.state.reply.raw.on("close", closeListener);
    stream.on("error", streamErrorListener);
    const state = {
      ...suppressed.state,
      closeListener,
      stream,
      streamErrorListener,
      options: { ...suppressed.state.options, levelForStatus, extraFields },
    };

    emitAccessRecord(state, "response", 200);
    emitAccessRecord(state, "response", 200);

    expect(suppressed.log).not.toHaveBeenCalled();
    expect(inspectLoggerBindings).not.toHaveBeenCalled();
    expect(levelForStatus).not.toHaveBeenCalled();
    expect(extraFields).not.toHaveBeenCalled();
    expect(suppressed.diagnose).not.toHaveBeenCalled();
    expect(state.reply.raw.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(state.closeListener).toBeUndefined();
    expect(state.stream).toBeUndefined();
    expect(state.streamErrorListener).toBeUndefined();
    expect(state.emitted).toBe(true);
  });

  it("does not evaluate access callbacks when every access level is disabled", () => {
    const inspectLoggerBindings = vi.fn(() => ({}));
    const levelForStatus = vi.fn(() => "error" as const);
    const extraFields = vi.fn(() => ({ unexpected: true }));
    const filtered = accessState({ inspectLoggerBindings });
    filtered.isLevelEnabled.mockReturnValue(false);
    const state = {
      ...filtered.state,
      options: { ...filtered.state.options, levelForStatus, extraFields },
    };

    emitAccessRecord(state, "response", 200);

    expect(filtered.log).not.toHaveBeenCalled();
    expect(inspectLoggerBindings).not.toHaveBeenCalled();
    expect(levelForStatus).not.toHaveBeenCalled();
    expect(extraFields).not.toHaveBeenCalled();
    expect(filtered.diagnose).not.toHaveBeenCalled();
    expect(state.emitted).toBe(true);
  });

  it("does not assume that the logger's public level map remains monotonic", () => {
    const sample = accessState();
    sample.isLevelEnabled.mockImplementation((level: string) => level === "info");

    emitAccessRecord(sample.state, "response", 200);

    expect(sample.logs.info).toHaveBeenCalledOnce();
    expect(sample.log.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/resource", status: 200 });
  });

  it("skips enrichment only when the selected access level is disabled", () => {
    const filteredInspection = vi.fn(() => ({}));
    const filteredExtraFields = vi.fn(() => ({ unexpected: true }));
    const filtered = accessState({ inspectLoggerBindings: filteredInspection });
    filtered.isLevelEnabled.mockImplementation((level: string) => level === "error");
    const filteredState = {
      ...filtered.state,
      options: { ...filtered.state.options, extraFields: filteredExtraFields },
    };

    emitAccessRecord(filteredState, "response", 200);

    expect(filtered.log).not.toHaveBeenCalled();
    expect(filteredInspection).not.toHaveBeenCalled();
    expect(filteredExtraFields).not.toHaveBeenCalled();

    const enabledExtraFields = vi.fn(() => ({ incident: "checkout" }));
    const enabled = accessState();
    enabled.isLevelEnabled.mockImplementation((level: string) => level === "error");
    const enabledState = {
      ...enabled.state,
      options: { ...enabled.state.options, extraFields: enabledExtraFields },
    };

    emitAccessRecord(enabledState, "response", 500);

    expect(enabled.logs.error).toHaveBeenCalledOnce();
    expect(enabledExtraFields).toHaveBeenCalledOnce();
    expect(enabled.log.mock.calls[0]?.[0]).toMatchObject({ incident: "checkout", status: 500 });
  });

  it("contains a level-inspection failure without attempting enrichment or emission", () => {
    const inspectLoggerBindings = vi.fn(() => ({}));
    const extraFields = vi.fn(() => ({ unexpected: true }));
    const failed = accessState({ inspectLoggerBindings });
    failed.isLevelEnabled.mockImplementation(() => {
      throw new Error("level inspection failed");
    });
    const state = {
      ...failed.state,
      options: { ...failed.state.options, extraFields },
    };

    emitAccessRecord(state, "response", 200);
    emitAccessRecord(state, "response", 200);

    expect(failed.log).not.toHaveBeenCalled();
    expect(inspectLoggerBindings).not.toHaveBeenCalled();
    expect(extraFields).not.toHaveBeenCalled();
    expect(failed.diagnose).toHaveBeenCalledOnce();
    expect(failed.diagnose).toHaveBeenCalledWith("logger", expect.any(String));
  });

  it("marks emission complete and diagnoses a synchronous logger failure once", () => {
    const failed = accessState();
    failed.log.mockImplementation(() => {
      throw new Error("logger failed");
    });
    emitAccessRecord(failed.state, "response", 503);
    emitAccessRecord(failed.state, "response", 503);

    expect(failed.logs.error).toHaveBeenCalledOnce();
    expect(failed.log).toHaveBeenCalledOnce();
    expect(failed.state.emitted).toBe(true);
    expect(failed.diagnose).toHaveBeenCalledOnce();
    expect(failed.diagnose).toHaveBeenCalledWith("logger", expect.any(String));
  });

  it("diagnoses an invalid extra-fields return and still emits the base access record", () => {
    const invalid = accessState();
    const options = { ...invalid.state.options, extraFields: () => [] as never };
    const state = { ...invalid.state, options };
    emitAccessRecord(state, "response", 200);

    expect(invalid.logs.info).toHaveBeenCalledOnce();
    expect(invalid.log.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/resource", status: 200 });
    expect(invalid.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));
  });

  it("diagnoses an asynchronous extra-fields callback instead of silently dropping its result", () => {
    const asynchronous = accessState();
    const options = {
      ...asynchronous.state.options,
      extraFields: (async () => ({ must_not_appear: true })) as never,
    };
    const state = { ...asynchronous.state, options };

    emitAccessRecord(state, "response", 200);

    expect(asynchronous.logs.info).toHaveBeenCalledOnce();
    expect(asynchronous.log.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/resource", status: 200 });
    expect(asynchronous.log.mock.calls[0]?.[0]).not.toHaveProperty("must_not_appear");
    expect(asynchronous.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));
  });

  it("accepts a null-prototype extra-fields record", () => {
    const sample = accessState();
    const custom = Object.create(null) as Record<string, unknown>;
    custom["component"] = "catalog";
    const state = {
      ...sample.state,
      options: { ...sample.state.options, extraFields: () => custom },
    };

    emitAccessRecord(state, "response", 200);

    expect(sample.logs.info).toHaveBeenCalledOnce();
    expect(sample.log.mock.calls[0]?.[0]).toMatchObject({ component: "catalog" });
    expect(sample.diagnose).not.toHaveBeenCalled();
  });

  it("diagnoses extra-fields enumeration failure and still emits the base access record", () => {
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

    expect(throwing.logs.info).toHaveBeenCalledOnce();
    expect(throwing.log.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/resource", status: 200 });
    expect(throwing.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));
  });

  it("does not leak partially copied extra fields when a later getter throws", () => {
    const partial = accessState();
    const result = Object.defineProperties(
      {},
      {
        first: { enumerable: true, value: "must not leak" },
        second: {
          enumerable: true,
          get: () => {
            throw new Error("blocked");
          },
        },
      },
    );
    emitAccessRecord(
      { ...partial.state, options: { ...partial.state.options, extraFields: () => result } },
      "response",
      200,
    );

    expect(partial.logs.info).toHaveBeenCalledOnce();
    expect(partial.log.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/resource", status: 200 });
    expect(partial.log.mock.calls[0]?.[0]).not.toHaveProperty("first");
    expect(partial.diagnose).toHaveBeenCalledWith("extra_fields", expect.any(String));
  });

  it("omits extra fields that conflict with logger bindings", () => {
    const equal = accessState({ loggerBindings: { component: "catalog" } });
    emitAccessRecord(
      {
        ...equal.state,
        options: { ...equal.state.options, extraFields: () => ({ component: "catalog", region: "eu" }) },
      },
      "response",
      200,
    );
    expect(equal.logs.info).toHaveBeenCalledOnce();
    expect(equal.log.mock.calls[0]?.[0]).not.toHaveProperty("component");
    expect(equal.log.mock.calls[0]?.[0]).toMatchObject({ region: "eu" });
    expect(equal.diagnose).not.toHaveBeenCalled();

    const conflicting = accessState({ loggerBindings: { component: "gateway" } });
    emitAccessRecord(
      {
        ...conflicting.state,
        options: { ...conflicting.state.options, extraFields: () => ({ component: "catalog", region: "eu" }) },
      },
      "response",
      200,
    );
    expect(conflicting.log).toHaveBeenCalledOnce();
    expect(conflicting.log.mock.calls[0]?.[0]).not.toHaveProperty("component");
    expect(conflicting.log.mock.calls[0]?.[0]).toMatchObject({ region: "eu" });
    expect(conflicting.diagnose).toHaveBeenCalledWith("extra_fields_conflict", expect.any(String));
  });

  it("reinspects Pino bindings before terminal emission", () => {
    const stable = accessState({
      loggerBindings: { request_id: "stable" },
      inspectLoggerBindings: () => ({ request_id: "stable" }),
    });
    emitAccessRecord(stable.state, "response", 200);
    expect(stable.log).toHaveBeenCalledOnce();

    const unreadable = accessState({
      inspectLoggerBindings: () => {
        throw new Error("unreadable");
      },
    });
    emitAccessRecord(unreadable.state, "response", 200);
    expect(unreadable.log).not.toHaveBeenCalled();
    expect(unreadable.diagnose).toHaveBeenCalledWith("logger_bindings", expect.any(String));
  });
});
