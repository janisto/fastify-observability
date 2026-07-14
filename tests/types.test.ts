import Fastify, { type FastifyInstance } from "fastify";
import plugin, {
  type AccessLogLevel,
  type FastifyObservabilityOptions,
  fastifyObservability,
  type RequestObservability,
  type TraceContext,
} from "fastify-observability";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("public types", () => {
  it("exports one plugin object as default and named", () => {
    expect(plugin).toBe(fastifyObservability);
  });

  it("infers options and request decoration", () => {
    expectTypeOf(plugin).toBeFunction();
    expectTypeOf<AccessLogLevel>().toEqualTypeOf<"debug" | "info" | "warn" | "error">();
    expectTypeOf<FastifyObservabilityOptions["preset"]>().toEqualTypeOf<
      "default" | "gcp" | "aws" | "azure" | undefined
    >();
    const register = (app: FastifyInstance) => {
      app.register(plugin, { preset: "gcp", levelForStatus: () => "debug" });
      app.get("/", (request) => {
        expectTypeOf(request.observability).toEqualTypeOf<RequestObservability>();
        return request.observability.requestId;
      });
    };
    expectTypeOf(register).toBeFunction();
  });

  it("supports HTTP/2 plugin registration types", () => {
    const typeFixture = () => {
      const app = Fastify({ http2: true });
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
});
