import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { validateHeaderName } from "node:http";
import type { Http2ServerRequest } from "node:http2";
import type { RequestIdGeneratorOptions } from "./types.js";

export type RawRequest = IncomingMessage | Http2ServerRequest;

interface RequestIdHandshake {
  readonly header: string;
  readonly requestId: string;
}

const requestIdHandshakes = new WeakMap<RawRequest, RequestIdHandshake>();
let emergencyCounter = 0;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
}

export function normalizeHeaderName(value: unknown, optionName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${optionName} must be a non-empty HTTP header name`);
  }
  try {
    validateHeaderName(value);
  } catch {
    throw new TypeError(`${optionName} must be a valid HTTP header name`);
  }
  return value.toLowerCase();
}

export function rawHeaderValues(request: RawRequest, headerName: string): string[] {
  const values: string[] = [];
  const rawHeaders = request.rawHeaders;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName) {
      const value = rawHeaders[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

function passesCustomValidator(value: string, validate: ((value: string) => boolean) | undefined): boolean {
  if (!isValidRequestId(value)) {
    return false;
  }
  if (validate === undefined) {
    return true;
  }
  try {
    return validate(value) === true;
  } catch {
    return false;
  }
}

function emergencyRequestId(): string {
  emergencyCounter = (emergencyCounter + 1) >>> 0;
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${performance.now()}:${emergencyCounter}`)
    .digest("hex")
    .slice(0, 32);
}

function safeFallbackRequestId(): string {
  try {
    const value = randomUUID();
    return isValidRequestId(value) ? value : emergencyRequestId();
  } catch {
    return emergencyRequestId();
  }
}

function generateRequestId(
  generate: (() => string) | undefined,
  validate: ((value: string) => boolean) | undefined,
): string {
  if (generate !== undefined) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const candidate = generate();
        if (passesCustomValidator(candidate, validate)) {
          return candidate;
        }
      } catch {
        // Application callbacks are untrusted; retry once, then use the safe fallback.
      }
    }
  }
  return safeFallbackRequestId();
}

export function createRequestIdGenerator(options: RequestIdGeneratorOptions = {}): (request: RawRequest) => string {
  const header = normalizeHeaderName(options.requestIdHeader ?? "x-request-id", "requestIdHeader");
  if (options.generate !== undefined && typeof options.generate !== "function") {
    throw new TypeError("generate must be a function");
  }
  if (options.validate !== undefined && typeof options.validate !== "function") {
    throw new TypeError("validate must be a function");
  }
  const generate = options.generate;
  const validate = options.validate;
  return (request) => {
    const values = rawHeaderValues(request, header);
    const candidate = values.length === 1 ? values[0] : undefined;
    const requestId =
      candidate !== undefined && passesCustomValidator(candidate, validate)
        ? candidate
        : generateRequestId(generate, validate);
    requestIdHandshakes.set(request, { header, requestId });
    return requestId;
  };
}

export function consumeRequestIdHandshake(request: RawRequest, requestId: string, header: string): boolean {
  const handshake = requestIdHandshakes.get(request);
  requestIdHandshakes.delete(request);
  return handshake?.requestId === requestId && handshake.header === header;
}
