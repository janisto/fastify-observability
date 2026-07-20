import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from "fastify";
import plugin, {
  type AccessLogLevel,
  createObservabilityLogger,
  createRequestIdGenerator,
  fastifyObservability,
  type GcpProfileVersion,
  getObservabilityLoggerProfile,
  type LoggingPreset,
  type ObservabilityLogger,
  type ObservabilityLoggerOptions,
  type ObservabilityLoggerProfile,
  type RequestObservability,
  type TraceContext,
  type TraceContextLevel,
} from "fastify-observability";
import type { Bindings } from "pino";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("public types", () => {
  it("exports one plugin object as default and named", () => {
    expect(plugin).toBe(fastifyObservability);
  });

  it("infers options and request decoration", () => {
    expectTypeOf(plugin).toBeFunction();
    expectTypeOf<AccessLogLevel>().toEqualTypeOf<"debug" | "info" | "warn" | "error">();
    expectTypeOf<LoggingPreset>().toEqualTypeOf<"default" | "gcp" | "aws" | "azure">();
    expectTypeOf<GcpProfileVersion>().toEqualTypeOf<"0.1.0">();
    expectTypeOf<TraceContextLevel>().toEqualTypeOf<1 | 2>();
    expectTypeOf<import("fastify-observability").FastifyObservabilityOptions["traceContextLevel"]>().toEqualTypeOf<
      TraceContextLevel | undefined
    >();
    expectTypeOf<TraceContext["traceContextLevel"]>().toEqualTypeOf<TraceContextLevel>();
    expectTypeOf<ObservabilityLoggerOptions["preset"]>().toEqualTypeOf<LoggingPreset | undefined>();
    expectTypeOf<ObservabilityLoggerOptions["gcpProfileVersion"]>().toEqualTypeOf<GcpProfileVersion | undefined>();
    expectTypeOf<ObservabilityLoggerOptions["level"]>().toEqualTypeOf<
      "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent" | undefined
    >();
    expectTypeOf(createObservabilityLogger).parameter(0).toEqualTypeOf<ObservabilityLoggerOptions | undefined>();
    expectTypeOf(createObservabilityLogger()).toEqualTypeOf<ObservabilityLogger>();
    expectTypeOf(createObservabilityLogger()).toMatchTypeOf<FastifyBaseLogger>();
    expectTypeOf(createObservabilityLogger().child({ component: "catalog" })).toEqualTypeOf<ObservabilityLogger>();
    expectTypeOf(createObservabilityLogger().bindings()).toEqualTypeOf<Bindings>();
    expectTypeOf(
      getObservabilityLoggerProfile(createObservabilityLogger()),
    ).toEqualTypeOf<ObservabilityLoggerProfile>();
    const register = (app: FastifyInstance) => {
      app.register(plugin, {
        capturePath: true,
        capturePeerIp: true,
        captureUserAgent: true,
        traceContextLevel: 2,
        clock: () => 0,
        levelForStatus: () => "debug",
      });
      app.get("/", (request) => {
        expectTypeOf(request.observability).toEqualTypeOf<RequestObservability>();
        return request.observability.requestId;
      });
    };
    expectTypeOf(register).toBeFunction();
  });

  it("supports HTTP/2 plugin registration types", () => {
    const typeFixture = () => {
      const app = Fastify({
        http2: true,
        loggerInstance: createObservabilityLogger(),
        requestIdHeader: false,
        genReqId: createRequestIdGenerator(),
        logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
      });
      app.register(plugin);
      return app;
    };
    expectTypeOf(typeFixture).toBeFunction();
  });

  it("keeps context readonly", () => {
    // @ts-expect-error v2 TraceContext requires the selected grammar level
    const removedV1Shape: TraceContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
      flags: "01",
      sampled: true,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const compileOnly = (context: RequestObservability, trace: TraceContext) => {
      // @ts-expect-error public request context is readonly
      context.requestId = "changed";
      // @ts-expect-error trace context is readonly
      trace.traceId = "changed";
    };
    expectTypeOf(compileOnly).toBeFunction();
    expectTypeOf(removedV1Shape).toEqualTypeOf<TraceContext>();
  });

  it("keeps opinionated logger and preset controls out of the wrong public surface", () => {
    const compileOnly = (app: FastifyInstance) => {
      const logger = createObservabilityLogger();
      // @ts-expect-error createObservabilityLogger owns the Pino message key
      createObservabilityLogger({ messageKey: "msg" });

      // @ts-expect-error canonical logger bindings are immutable
      logger.setBindings({ component: "changed" });
      // @ts-expect-error the package owns Pino's child-registration callback
      logger.onChild = () => undefined;
      // @ts-expect-error custom Pino levels are outside the canonical contract
      logger.level = "verbose";
      // @ts-expect-error preset selection belongs to createObservabilityLogger, not plugin options
      app.register(plugin, { preset: "gcp" });
      // @ts-expect-error v2 owns the terminal message and has no v1 message option
      app.register(plugin, { message: "request completed" });
      // @ts-expect-error extraFields is deliberately synchronous
      app.register(plugin, { extraFields: async () => ({ component: "catalog" }) });
    };
    expectTypeOf(compileOnly).toBeFunction();
  });
});
