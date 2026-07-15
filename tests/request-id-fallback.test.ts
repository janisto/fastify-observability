import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: vi.fn(() => {
      throw new Error("system randomness unavailable");
    }),
  };
});

const crypto = await import("node:crypto");
const { createRequestIdGenerator, isValidRequestId } = await import("../src/request-id.js");

describe("request-ID emergency fallback", () => {
  it("remains valid and unique when randomUUID throws", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(performance, "now").mockReturnValue(42);
    vi.mocked(crypto.randomUUID).mockImplementation(() => {
      throw new Error("system randomness unavailable");
    });
    const generator = createRequestIdGenerator();
    const request = () => ({ rawHeaders: [] }) as unknown as IncomingMessage;

    const first = generator(request());
    const second = generator(request());

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(isValidRequestId(first)).toBe(true);
    expect(isValidRequestId(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(vi.mocked(crypto.randomUUID)).toHaveBeenCalledTimes(2);
  });
});
