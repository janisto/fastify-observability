import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as applog from "../examples/local_wrapper/applog.js";
import { accessRecords, buildTestApp } from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

function bindings(logger: FastifyBaseLogger): Record<string, unknown> {
  const read = Reflect.get(logger, "bindings");
  if (typeof read !== "function") {
    throw new Error("expected a Pino logger with public bindings()");
  }
  return Reflect.apply(read, logger, []) as Record<string, unknown>;
}

const providerExampleModules = [
  ["basic", "default", () => import("../examples/basic/app.js")],
  ["gcp", "gcp", () => import("../examples/gcp/app.js")],
  ["aws", "aws", () => import("../examples/aws/app.js")],
  ["azure", "azure", () => import("../examples/azure/app.js")],
] as const;

describe("examples", () => {
  it.each(
    providerExampleModules,
  )("runs the documented %s request path with only the %s preset", async (_name, preset, load) => {
    vi.resetModules();
    const [{ app }, { canonicalLoggerProfile }] = await Promise.all([load(), import("../src/logger.js")]);
    let requestBindings: Record<string, unknown> | undefined;
    try {
      Reflect.set(app.log, "level", "silent");
      app.get("/__observability_probe", (request) => {
        requestBindings = bindings(request.log);
        return request.observability;
      });
      await app.ready();
      const response = await app.inject({
        url: "/__observability_probe",
        headers: { "x-request-id": "example-request", traceparent: TRACEPARENT },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).toBe("example-request");
      expect(response.json()).toMatchObject({ requestId: "example-request", correlationId: TRACE_ID });
      expect(canonicalLoggerProfile(app.log)).toEqual({ preset });
      expect(app.hasRequestDecorator("observability")).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/" })).toBe(false);
      expect(requestBindings).toMatchObject({
        request_id: "example-request",
        correlation_id: TRACE_ID,
        trace_id: TRACE_ID,
        parent_id: PARENT_ID,
        trace_flags: "01",
        trace_sampled: true,
      });
      const providerFields: Record<string, Record<string, unknown>> = {
        default: {},
        gcp: {
          "logging.googleapis.com/trace": TRACE_ID,
          "logging.googleapis.com/trace_sampled": true,
        },
        aws: { xray_trace_id: `1-${TRACE_ID.slice(0, 8)}-${TRACE_ID.slice(8)}` },
        azure: { operation_Id: TRACE_ID, operation_ParentId: PARENT_ID },
      };
      expect(requestBindings).toMatchObject(providerFields[preset] ?? {});
      const allProviderKeys = [
        "logging.googleapis.com/trace",
        "logging.googleapis.com/trace_sampled",
        "logging.googleapis.com/spanId",
        "xray_trace_id",
        "operation_Id",
        "operation_ParentId",
      ];
      for (const key of allProviderKeys) {
        if (!Object.hasOwn(providerFields[preset] ?? {}, key)) {
          expect(requestBindings?.[key]).toBeUndefined();
        }
      }
    } finally {
      await app.close();
    }
  });

  it("runs the local-wrapper item route with its GCP request logger", async () => {
    vi.resetModules();
    const [{ app }, { canonicalLoggerProfile }] = await Promise.all([
      import("../examples/local_wrapper/app.js"),
      import("../src/logger.js"),
    ]);
    let requestBindings: Record<string, unknown> | undefined;
    try {
      Reflect.set(app.log, "level", "silent");
      app.addHook("preHandler", (request, _reply, done) => {
        requestBindings = bindings(request.log);
        done();
      });
      await app.ready();
      const response = await app.inject({
        url: "/items/42",
        headers: { "x-request-id": "wrapper-request", traceparent: TRACEPARENT },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).toBe("wrapper-request");
      expect(response.json()).toEqual({ itemId: "42" });
      expect(canonicalLoggerProfile(app.log)).toEqual({ preset: "gcp" });
      expect(app.hasRequestDecorator("observability")).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/items/:itemId" })).toBe(true);
      expect(requestBindings).toMatchObject({
        request_id: "wrapper-request",
        correlation_id: TRACE_ID,
        "logging.googleapis.com/trace": TRACE_ID,
      });
      expect(requestBindings?.["logging.googleapis.com/spanId"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("keeps local wrapper levels, fields, and errors on the provided logger", () => {
    const debug = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const logger = { debug, info, warn, error } as unknown as FastifyBaseLogger;
    applog.debug(logger, "debug", { component: "test" });
    applog.info(logger, "info");
    applog.warn(logger, "warn");
    applog.log(logger, "error", "generic");
    const cause = new Error("failed");
    applog.error(logger, "error", cause, { component: "test", err: "hidden" });
    expect(debug).toHaveBeenCalledWith({ component: "test" }, "debug");
    expect(info).toHaveBeenCalledWith({}, "info");
    expect(warn).toHaveBeenCalledWith({}, "warn");
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenNthCalledWith(1, {}, "generic");
    expect(error).toHaveBeenNthCalledWith(2, { component: "test", err: cause }, "error");
  });

  it("uses the package-enriched request logger in the local wrapper", async () => {
    const { app, records } = await buildTestApp({}, { preset: "gcp" });
    app.get<{ Params: { itemId: string } }>("/items/:itemId", (request) => {
      applog.info(request.log, "loading item", { item_id: request.params.itemId });
      return { itemId: request.params.itemId };
    });
    try {
      const response = await app.inject({
        url: "/items/42",
        headers: { "x-request-id": "wrapper-id", traceparent: TRACEPARENT },
      });
      expect(response.statusCode).toBe(200);
      expect(records.find((record) => record.message === "loading item")).toMatchObject({
        request_id: "wrapper-id",
        correlation_id: TRACE_ID,
        "logging.googleapis.com/trace": TRACE_ID,
        item_id: "42",
      });
      expect(accessRecords(records)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
