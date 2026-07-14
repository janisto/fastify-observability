import { parseTraceparent } from "fastify-observability";
import { describe, expect, it } from "vitest";
import { attachTracestate } from "../src/trace.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";

describe("traceparent", () => {
  it("parses v00 and derives sampled from bit zero", () => {
    const trace = parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-03`);
    expect(trace).toEqual({
      traceId: TRACE_ID,
      parentId: PARENT_ID,
      flags: "03",
      sampled: true,
      traceparent: `00-${TRACE_ID}-${PARENT_ID}-03`,
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-02`)?.sampled).toBe(false);
  });

  it("accepts future framing and rejects invalid boundaries", () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01`)).not.toBeNull();
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-extra`)).not.toBeNull();
    const invalid = [
      null,
      "short",
      `00-${TRACE_ID}-${PARENT_ID}-01-extra`,
      `ff-${TRACE_ID}-${PARENT_ID}-01`,
      `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`,
      `00-${"0".repeat(32)}-${PARENT_ID}-01`,
      `00-${TRACE_ID}-${"0".repeat(16)}-01`,
      `00_${TRACE_ID}-${PARENT_ID}-01`,
      `01-${TRACE_ID}-${PARENT_ID}-01${"x".repeat(458)}`,
      `01-${TRACE_ID}-${PARENT_ID}-01x`,
    ];
    for (const value of invalid) {
      expect(parseTraceparent(value)).toBeNull();
    }
  });
});

describe("tracestate", () => {
  const trace = parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`);
  if (trace === null) {
    throw new Error("test trace must parse");
  }

  it("combines valid values in wire order", () => {
    const result = attachTracestate(trace, ["vendor=one", "tenant@system=value"]);
    expect(result.tracestate).toBe("vendor=one,tenant@system=value");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["duplicate keys", ["a=1,a=2"]],
    ["uppercase key", ["A=1"]],
    ["multiple tenant separators", ["a@@system=1"]],
    ["empty key", ["=value"]],
    ["empty value", ["a="]],
    ["invalid value", ["a=has=equals"]],
    ["tab in value", ["a=value\tbad"]],
    ["too many members", [Array.from({ length: 33 }, (_, index) => `a${index}=1`).join(",")]],
    ["too long", [`a=${"x".repeat(511)}`]],
    ["empty", []],
  ])("drops %s without invalidating traceparent", (_name, values) => {
    expect(attachTracestate(trace, values)).toBe(trace);
  });

  it("accepts optional whitespace and empty list members", () => {
    expect(attachTracestate(trace, [" , a=1, "]).tracestate).toBe(" , a=1, ");
  });
});
