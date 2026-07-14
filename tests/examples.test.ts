import { readFileSync } from "node:fs";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as applog from "../examples/local_wrapper/applog.js";
import { accessRecords, buildTestApp } from "./helpers.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

const providerExamples = [
  ["basic", ""],
  ["gcp", 'preset: "gcp"'],
  ["aws", 'preset: "aws"'],
  ["azure", 'preset: "azure"'],
] as const;

describe("examples", () => {
  it.each(providerExamples)("keeps the %s example limited to package setup", (directory, preset) => {
    const source = readFileSync(new URL(`../examples/${directory}/app.ts`, import.meta.url), "utf8");
    for (const required of [
      "requestIdHeader: false",
      "genReqId: createRequestIdGenerator()",
      "disableRequestLogging: true",
      'requestIdLogLabel: "request_id"',
      "app.register(fastifyObservability",
    ]) {
      expect(source).toContain(required);
    }
    if (preset !== "") {
      expect(source).toContain(preset);
    }
    for (const excluded of ["app.get(", "app.route(", "app.listen(", "buildApp", "health", "pathToFileURL", "Writable"])
      expect(source).not.toContain(excluded);
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
    expect(error).toHaveBeenLastCalledWith({ component: "test", err: cause }, "error");
  });

  it("uses the package-enriched request logger in the local wrapper", async () => {
    const source = readFileSync(new URL("../examples/local_wrapper/app.ts", import.meta.url), "utf8");
    expect(source).toContain('app.register(fastifyObservability, { preset: "gcp" })');
    expect(source).toContain("applog.info(request.log");

    const { app, records } = await buildTestApp({ preset: "gcp" });
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
      expect(records.find((record) => record.msg === "loading item")).toMatchObject({
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
