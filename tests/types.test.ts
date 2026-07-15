import Fastify, { type FastifyInstance, LogController } from "fastify";
import plugin, {
  type AccessLogLevel,
  createObservabilityLogger,
  createRequestIdGenerator,
  fastifyObservability,
  type LoggingPreset,
  type ObservabilityLoggerOptions,
  type RequestObservability,
  type TraceContext,
} from "fastify-observability";
import type { Bindings, Logger } from "pino";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("public types", () => {
  it("exports one plugin object as default and named", () => {
    expect(plugin).toBe(fastifyObservability);
  });

  it("infers options and request decoration", () => {
    expectTypeOf(plugin).toBeFunction();
    expectTypeOf<AccessLogLevel>().toEqualTypeOf<"debug" | "info" | "warn" | "error">();
    expectTypeOf<LoggingPreset>().toEqualTypeOf<"default" | "gcp" | "aws" | "azure">();
    expectTypeOf<ObservabilityLoggerOptions["preset"]>().toEqualTypeOf<LoggingPreset | undefined>();
    expectTypeOf<ObservabilityLoggerOptions["level"]>().toEqualTypeOf<
      "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent" | undefined
    >();
    expectTypeOf(createObservabilityLogger).parameter(0).toEqualTypeOf<ObservabilityLoggerOptions | undefined>();
    expectTypeOf(createObservabilityLogger()).toEqualTypeOf<Logger>();
    expectTypeOf(createObservabilityLogger().bindings()).toEqualTypeOf<Bindings>();
    const register = (app: FastifyInstance) => {
      app.register(plugin, { levelForStatus: () => "debug" });
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
    const compileOnly = (context: RequestObservability, trace: TraceContext) => {
      // @ts-expect-error public request context is readonly
      context.requestId = "changed";
      // @ts-expect-error trace context is readonly
      trace.traceId = "changed";
    };
    expectTypeOf(compileOnly).toBeFunction();
  });

  it("keeps opinionated logger and preset controls out of the wrong public surface", () => {
    const compileOnly = (app: FastifyInstance) => {
      // @ts-expect-error createObservabilityLogger owns the Pino message key
      createObservabilityLogger({ messageKey: "msg" });
      // @ts-expect-error preset selection belongs to createObservabilityLogger, not plugin options
      app.register(plugin, { preset: "gcp" });
      // @ts-expect-error extraFields is deliberately synchronous
      app.register(plugin, { extraFields: async () => ({ component: "catalog" }) });
    };
    expectTypeOf(compileOnly).toBeFunction();
  });
});
