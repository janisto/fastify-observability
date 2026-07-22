import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as applog from "../examples/local_wrapper/applog.js";
import { accessRecords, buildTestApp } from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-03`;

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
      const context = response.json<{
        requestId: string;
        correlationId: string;
        traceContext: { traceContextLevel: number; traceIdRandom?: boolean };
      }>();
      expect(context).toMatchObject({
        requestId: "example-request",
        correlationId: TRACE_ID,
        traceContext: { traceContextLevel: 1 },
      });
      expect(context.traceContext.traceIdRandom).toBeUndefined();
      expect(canonicalLoggerProfile(app.log)).toEqual({ preset });
      expect(app.hasRequestDecorator("observability")).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/" })).toBe(false);
      expect(requestBindings).toMatchObject({
        request_id: "example-request",
        correlation_id: TRACE_ID,
        trace_id: TRACE_ID,
        parent_id: PARENT_ID,
        trace_flags: "03",
        trace_sampled: true,
      });
      expect(requestBindings?.["trace_id_random"]).toBeUndefined();
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

  it("preserves structured fields, levels, errors, and request bindings through the local wrapper", async () => {
    const { app, records } = await buildTestApp({}, { preset: "gcp", level: "trace" });
    app.get<{ Params: { itemId: string } }>("/items/:itemId", (request) => {
      const fields = { item_id: request.params.itemId };
      applog.debug(request.log, "debug helper", { ...fields, helper: "debug" });
      applog.info(request.log, "info helper", { ...fields, helper: "info" });
      applog.warn(request.log, "warn helper", { ...fields, helper: "warn" });
      applog.error(request.log, "error helper", new Error("boom"), {
        ...fields,
        helper: "error",
        err: "must not replace the Error",
      });
      applog.log(request.log, "trace", "trace helper", { ...fields, helper: "log:trace" });
      applog.log(request.log, "fatal", "fatal helper", { ...fields, helper: "log:fatal" });
      return { itemId: request.params.itemId };
    });
    try {
      const response = await app.inject({
        url: "/items/42",
        headers: { "x-request-id": "wrapper-id", traceparent: TRACEPARENT },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).toBe("wrapper-id");
      expect(response.json()).toEqual({ itemId: "42" });

      const expectedHelpers = [
        ["debug helper", "DEBUG", "debug"],
        ["info helper", "INFO", "info"],
        ["warn helper", "WARNING", "warn"],
        ["error helper", "ERROR", "error"],
        ["trace helper", "DEBUG", "log:trace"],
        ["fatal helper", "CRITICAL", "log:fatal"],
      ] as const;
      for (const [message, severity, helper] of expectedHelpers) {
        expect(records.find((record) => record.message === message)).toMatchObject({
          severity,
          request_id: "wrapper-id",
          correlation_id: TRACE_ID,
          trace_id: TRACE_ID,
          trace_sampled: true,
          "logging.googleapis.com/trace": TRACE_ID,
          "logging.googleapis.com/trace_sampled": true,
          item_id: "42",
          helper,
        });
      }
      expect(records.find((record) => record.message === "error helper")?.["err"]).toMatchObject({
        type: "Error",
        message: "boom",
      });
      for (const record of records) {
        expect(record["logging.googleapis.com/spanId"]).toBeUndefined();
      }
      expect(accessRecords(records)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("adds the error without mutating caller-owned wrapper fields", () => {
    const write = vi.fn();
    const logger = { error: write } as unknown as FastifyBaseLogger;
    const cause = new Error("boom");
    const fields = { component: "worker", err: "caller value" };

    applog.error(logger, "worker failed", cause, fields);

    expect(fields).toEqual({ component: "worker", err: "caller value" });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ err: cause, component: "worker" }, "worker failed");
    expect(write.mock.calls[0]?.[0]).not.toBe(fields);
  });
});
