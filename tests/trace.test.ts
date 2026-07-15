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

  it("accepts future framing up to the wire-length boundary", () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01`)).not.toBeNull();
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-extra`)).not.toBeNull();
    const maximum = `01-${TRACE_ID}-${PARENT_ID}-01-${"x".repeat(456)}`;
    expect(maximum).toHaveLength(512);
    expect(parseTraceparent(maximum)).not.toBeNull();
    expect(parseTraceparent(`${maximum}x`)).toBeNull();
  });

  it.each([2, 35, 52])("rejects corruption at required separator index %i", (separatorIndex) => {
    const value = [...`00-${TRACE_ID}-${PARENT_ID}-01`];
    value[separatorIndex] = "_";
    expect(parseTraceparent(value.join(""))).toBeNull();
  });

  it.each([
    ["a non-string value", null],
    ["a truncated value", "short"],
    ["an extension on version 00", `00-${TRACE_ID}-${PARENT_ID}-01-extra`],
    ["the forbidden ff version", `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ["an uppercase version", `0A-${TRACE_ID}-${PARENT_ID}-01`],
    ["an uppercase trace ID", `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`],
    ["an uppercase parent ID", `00-${TRACE_ID}-${PARENT_ID.toUpperCase()}-01`],
    ["uppercase trace flags", `00-${TRACE_ID}-${PARENT_ID}-0A`],
    ["an all-zero trace ID", `00-${"0".repeat(32)}-${PARENT_ID}-01`],
    ["an all-zero parent ID", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["future data without its separator", `01-${TRACE_ID}-${PARENT_ID}-01x`],
    ["a control character in future data", `01-${TRACE_ID}-${PARENT_ID}-01-\u001f`],
  ])("rejects %s", (_name, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});

describe("tracestate", () => {
  const trace = parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`);
  if (trace === null) {
    throw new Error("test trace must parse");
  }

  it("combines valid values in wire order", () => {
    const result = attachTracestate(trace, ["vendor=one", "1tenant@system=value"]);
    expect(result.tracestate).toBe("vendor=one,1tenant@system=value");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["duplicate keys", ["a=1,a=2"]],
    ["uppercase key", ["A=1"]],
    ["numeric simple-key prefix", ["1vendor=1"]],
    ["numeric system prefix", ["tenant@1system=1"]],
    ["multiple tenant separators", ["a@@system=1"]],
    ["empty key", ["=value"]],
    ["empty value", ["a="]],
    ["invalid value", ["a=has=equals"]],
    ["tab in value", ["a=value\tbad"]],
    ["non-ASCII input", ["a=tracé"]],
    ["empty", []],
  ])("drops %s without invalidating traceparent", (_name, values) => {
    expect(attachTracestate(trace, values)).toBe(trace);
  });

  it("accepts optional whitespace and empty list members", () => {
    expect(attachTracestate(trace, [" , a=1, "]).tracestate).toBe(" , a=1, ");
  });

  it("enforces the exact member, value, and total-length boundaries", () => {
    const thirtyTwoMembers = Array.from({ length: 32 }, (_, index) => `a${index}=1`).join(",");
    expect(attachTracestate(trace, [thirtyTwoMembers]).tracestate).toBe(thirtyTwoMembers);
    expect(attachTracestate(trace, [`${thirtyTwoMembers},overflow=1`])).toBe(trace);

    const maximumValue = `a=${"x".repeat(256)}`;
    expect(attachTracestate(trace, [maximumValue]).tracestate).toBe(maximumValue);
    expect(attachTracestate(trace, [`a=${"x".repeat(257)}`])).toBe(trace);

    const maximumTotal = `a=${"x".repeat(256)},b=${"y".repeat(251)}`;
    expect(maximumTotal).toHaveLength(512);
    expect(attachTracestate(trace, [maximumTotal]).tracestate).toBe(maximumTotal);
    expect(attachTracestate(trace, [`${maximumTotal}x`])).toBe(trace);
  });

  it("enforces simple and multi-tenant key-length boundaries", () => {
    const maximumSimpleKey = `a${"x".repeat(255)}`;
    expect(attachTracestate(trace, [`${maximumSimpleKey}=1`]).tracestate).toBe(`${maximumSimpleKey}=1`);
    expect(attachTracestate(trace, [`${maximumSimpleKey}x=1`])).toBe(trace);

    const maximumTenant = `a${"x".repeat(240)}`;
    const maximumSystem = `b${"y".repeat(13)}`;
    const maximumMultiTenantKey = `${maximumTenant}@${maximumSystem}`;
    expect(attachTracestate(trace, [`${maximumMultiTenantKey}=1`]).tracestate).toBe(`${maximumMultiTenantKey}=1`);
    expect(attachTracestate(trace, [`${maximumTenant}x@${maximumSystem}=1`])).toBe(trace);
    expect(attachTracestate(trace, [`${maximumTenant}@${maximumSystem}y=1`])).toBe(trace);
  });
});
