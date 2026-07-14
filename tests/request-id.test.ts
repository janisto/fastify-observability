import type { IncomingMessage } from "node:http";
import { createRequestIdGenerator, isValidRequestId } from "fastify-observability";
import { describe, expect, it } from "vitest";

function request(rawHeaders: string[]): IncomingMessage {
  return { rawHeaders } as IncomingMessage;
}

describe("request IDs", () => {
  it.each(["a", "A-Z_a.b~9", "x".repeat(128)])("accepts an unreserved ID: %s", (value) => {
    expect(isValidRequestId(value)).toBe(true);
  });

  it.each([
    undefined,
    null,
    1,
    "",
    "x".repeat(129),
    "has space",
    "comma,value",
    "tracé",
    "line\nbreak",
  ])("rejects an invalid ID: %s", (value) => {
    expect(isValidRequestId(value)).toBe(false);
  });

  it("preserves one valid raw header and replaces duplicates", () => {
    const generator = createRequestIdGenerator({ generate: () => "generated" });
    expect(generator(request(["X-Request-ID", "caller-A"]))).toBe("caller-A");
    expect(generator(request(["X-Request-ID", "one", "x-request-id", "two"]))).toBe("generated");
    expect(generator(request(["X-Request-ID", "not valid"]))).toBe("generated");
  });

  it("supports a custom header and narrowing validator", () => {
    const generator = createRequestIdGenerator({
      requestIdHeader: "X-Correlation-ID",
      validate: (value) => value.startsWith("allowed-"),
      generate: () => "allowed-generated",
    });
    expect(generator(request(["x-correlation-id", "allowed-caller"]))).toBe("allowed-caller");
    expect(generator(request(["x-correlation-id", "other"]))).toBe("allowed-generated");
  });

  it("contains callback failures, retries twice, and uses a safe fallback", () => {
    let attempts = 0;
    const generator = createRequestIdGenerator({
      generate: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("boom");
        }
        return "invalid value";
      },
      validate: () => {
        throw new Error("validator boom");
      },
    });
    const value = generator(request([]));
    expect(attempts).toBe(2);
    expect(isValidRequestId(value)).toBe(true);
  });

  it("rejects invalid factory configuration", () => {
    expect(() => createRequestIdGenerator({ requestIdHeader: 1 as never })).toThrow("non-empty HTTP header");
    expect(() => createRequestIdGenerator({ requestIdHeader: "bad header" })).toThrow("valid HTTP header");
    expect(() => createRequestIdGenerator({ generate: 1 as never })).toThrow("generate must be a function");
    expect(() => createRequestIdGenerator({ validate: 1 as never })).toThrow("validate must be a function");
  });
});
