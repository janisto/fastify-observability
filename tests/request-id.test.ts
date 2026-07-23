import type { IncomingMessage } from "node:http";
import { createRequestIdGenerator, isValidRequestId } from "fastify-observability";
import { describe, expect, it, vi } from "vitest";

function request(rawHeaders: string[]): IncomingMessage {
  return { rawHeaders } as IncomingMessage;
}

describe("request IDs", () => {
  it.each(["a", "A-Z_a.b~9", "x".repeat(128)])("accepts an unreserved ID: %s", (value) => {
    expect(isValidRequestId(value)).toBe(true);
  });

  it.each([undefined, null, 1, "", "x".repeat(129), "has space", "comma,value", "tracé", "line\nbreak"])(
    "rejects an invalid ID: %s",
    (value) => {
      expect(isValidRequestId(value)).toBe(false);
    },
  );

  it("preserves one valid raw header and replaces duplicates", () => {
    const generate = vi.fn(() => "generated");
    const generator = createRequestIdGenerator({ generate });
    expect(generator(request(["X-Request-ID", "caller-A"]))).toBe("caller-A");
    expect(generate).not.toHaveBeenCalled();
    expect(generator(request(["X-Request-ID", "one", "x-request-id", "two"]))).toBe("generated");
    expect(generator(request(["X-Request-ID", "same", "x-request-id", "same"]))).toBe("generated");
    expect(generator(request(["X-Request-ID", "not valid"]))).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("lets a custom validator broaden caller IDs only within Node's header boundary", () => {
    const validateIncoming = vi.fn(
      (value: string) => value.startsWith("allowed-") || value === "id:42" || value.length === 129,
    );
    const generator = createRequestIdGenerator({
      requestIdHeader: "X-Correlation-ID",
      validateIncoming,
      generate: () => "generated",
    });
    expect(generator(request(["x-correlation-id", "allowed-caller"]))).toBe("allowed-caller");
    expect(generator(request(["x-correlation-id", "id:42"]))).toBe("id:42");
    expect(generator(request(["x-correlation-id", "x".repeat(129)]))).toBe("x".repeat(129));
    expect(generator(request(["x-correlation-id", "other"]))).toBe("generated");
    expect(generator(request(["x-correlation-id", "not valid"]))).toBe("generated");
    expect(generator(request(["x-correlation-id", "line\nbreak"]))).toBe("generated");
    expect(validateIncoming).toHaveBeenCalledTimes(5);
    expect(validateIncoming).toHaveBeenNthCalledWith(1, "allowed-caller");
    expect(validateIncoming).toHaveBeenNthCalledWith(4, "other");
  });

  it("applies the RFC field-content boundary before a custom validator", () => {
    const validateIncoming = vi.fn(() => true);
    const generator = createRequestIdGenerator({ validateIncoming, generate: () => "generated" });

    expect(generator(request(["x-request-id", "tenant request"]))).toBe("tenant request");
    expect(generator(request(["x-request-id", "tenant\trequest"]))).toBe("tenant\trequest");
    expect(generator(request(["x-request-id", "tenant,request"]))).toBe("tenant,request");
    expect(generator(request(["x-request-id", " tenant"]))).toBe("generated");
    expect(generator(request(["x-request-id", "tenant\t"]))).toBe("generated");

    expect(validateIncoming).toHaveBeenCalledTimes(3);
    expect(validateIncoming).toHaveBeenNthCalledWith(1, "tenant request");
    expect(validateIncoming).toHaveBeenNthCalledWith(2, "tenant\trequest");
    expect(validateIncoming).toHaveBeenNthCalledWith(3, "tenant,request");
  });

  it("invokes a failing custom generator once before the package fallback", () => {
    const generate = vi.fn<() => string>(() => {
      throw new Error("generator failure");
    });
    const generator = createRequestIdGenerator({ generate });

    expect(isValidRequestId(generator(request([])))).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(["invalid value", 42])("invokes a generator returning %j once before fallback", (candidate) => {
    const generate = vi.fn<() => string>(() => candidate as never);
    const generator = createRequestIdGenerator({ generate });

    expect(isValidRequestId(generator(request([])))).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("contains callback failures and uses a safe fallback", () => {
    let attempts = 0;
    let validations = 0;
    const generator = createRequestIdGenerator({
      generate: () => {
        attempts += 1;
        throw new Error("boom");
      },
      validateIncoming: () => {
        validations += 1;
        throw new Error("validator boom");
      },
    });
    const value = generator(request(["x-request-id", "caller"]));
    expect(attempts).toBe(1);
    expect(validations).toBe(1);
    expect(isValidRequestId(value)).toBe(true);
  });

  it.each([
    ["null options", null, "options must be a record"],
    ["array options", [], "options must be a record"],
    ["an unsupported option", { validate: () => true }, 'unsupported request-ID generator option "validate"'],
    ["a non-string header", { requestIdHeader: 1 }, "non-empty HTTP header"],
    ["an invalid header name", { requestIdHeader: "bad header" }, "valid HTTP header"],
    ["a non-function generator", { generate: 1 }, "generate must be a function"],
    ["a non-function validator", { validateIncoming: 1 }, "validateIncoming must be a function"],
  ])("rejects %s", (_name, options, message) => {
    expect(() => createRequestIdGenerator(options as never)).toThrow(message);
  });
});
