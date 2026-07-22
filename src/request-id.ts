import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { Http2ServerRequest } from "node:http2";
import type { RequestIdGeneratorOptions } from "./types.js";

export type RawRequest = IncomingMessage | Http2ServerRequest;

interface RequestIdHandshake {
  readonly header: string;
  readonly requestId: string;
}

const requestIdHandshakes = new WeakMap<RawRequest, RequestIdHandshake>();
const REQUEST_ID_OPTION_KEYS = new Set(["requestIdHeader", "generate", "validateIncoming"]);
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

function validIncomingRequestId(value: string, validateIncoming: ((value: string) => boolean) | undefined): boolean {
  if (validateIncoming === undefined) {
    return isValidRequestId(value);
  }
  if (!isNativeFieldContent(value)) {
    return false;
  }
  try {
    return validateIncoming(value) === true;
  } catch {
    return false;
  }
}

export function isNativeFieldContent(value: string): boolean {
  if (value.length === 0 || /^[\t ]|[\t ]$/.test(value)) {
    return false;
  }
  try {
    validateHeaderValue("x-request-id", value);
    return true;
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

function generateRequestId(generate: (() => string) | undefined): string {
  if (generate !== undefined) {
    try {
      const candidate = generate();
      if (isValidRequestId(candidate)) {
        return candidate;
      }
    } catch {
      // Application callbacks are untrusted; use the package fallback.
    }
  }
  return safeFallbackRequestId();
}

export function createRequestIdGenerator(options: RequestIdGeneratorOptions = {}): (request: RawRequest) => string {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("request-ID generator options must be a record");
  }
  for (const key of Object.keys(options)) {
    if (!REQUEST_ID_OPTION_KEYS.has(key)) {
      throw new TypeError(`unsupported request-ID generator option "${key}"`);
    }
  }
  const header = normalizeHeaderName(options.requestIdHeader ?? "x-request-id", "requestIdHeader");
  if (options.generate !== undefined && typeof options.generate !== "function") {
    throw new TypeError("generate must be a function");
  }
  if (options.validateIncoming !== undefined && typeof options.validateIncoming !== "function") {
    throw new TypeError("validateIncoming must be a function");
  }
  const generate = options.generate;
  const validateIncoming = options.validateIncoming;
  return (request) => {
    const values = rawHeaderValues(request, header);
    const candidate = values.length === 1 ? values[0] : undefined;
    const requestId =
      candidate !== undefined && validIncomingRequestId(candidate, validateIncoming)
        ? candidate
        : generateRequestId(generate);
    requestIdHandshakes.set(request, { header, requestId });
    return requestId;
  };
}

export function consumeRequestIdHandshake(request: RawRequest, requestId: string, header: string): boolean {
  const handshake = requestIdHandshakes.get(request);
  requestIdHandshakes.delete(request);
  return handshake?.requestId === requestId && handshake.header === header;
}
