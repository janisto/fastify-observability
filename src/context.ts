import type { FastifyRequest } from "fastify";
import { normalizeHeaderName, rawHeaderValues } from "./request-id.js";
import { attachTracestate, parseTraceparent, resolveTraceContextLevel } from "./trace.js";
import type {
  ExtraFields,
  FastifyObservabilityOptions,
  LevelForStatus,
  LoggingPreset,
  RequestObservability,
  TraceContextLevel,
} from "./types.js";

export interface NormalizedOptions {
  readonly preset: LoggingPreset;
  readonly requestIdHeader: string;
  readonly responseHeader: string | false;
  readonly traceHeader: string;
  readonly tracestateHeader: string;
  readonly traceContextLevel: TraceContextLevel;
  readonly capturePath: boolean;
  readonly capturePeerIp: boolean;
  readonly captureUserAgent: boolean;
  readonly captureError: boolean;
  readonly clock: () => number;
  readonly levelForStatus?: LevelForStatus;
  readonly extraFields?: ExtraFields;
}

const OPTION_KEYS = new Set([
  "requestIdHeader",
  "responseHeader",
  "traceHeader",
  "tracestateHeader",
  "traceContextLevel",
  "message",
  "capturePath",
  "capturePeerIp",
  "captureUserAgent",
  "captureError",
  "clock",
  "levelForStatus",
  "extraFields",
]);

function booleanOption(name: string, value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value ?? false;
}

export function normalizeOptions(options: FastifyObservabilityOptions, preset: LoggingPreset): NormalizedOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("plugin options must be a record");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(`unsupported fastify-observability option "${key}"`);
    }
  }
  const requestIdHeader = normalizeHeaderName(options.requestIdHeader ?? "x-request-id", "requestIdHeader");
  const traceHeader = normalizeHeaderName(options.traceHeader ?? "traceparent", "traceHeader");
  const tracestateHeader = normalizeHeaderName(options.tracestateHeader ?? "tracestate", "tracestateHeader");
  const responseHeader =
    options.responseHeader === false
      ? false
      : normalizeHeaderName(options.responseHeader ?? requestIdHeader, "responseHeader");
  const inputHeaders = new Set([requestIdHeader, traceHeader, tracestateHeader]);
  if (inputHeaders.size !== 3) {
    throw new TypeError("requestIdHeader, traceHeader, and tracestateHeader must be distinct");
  }
  if (responseHeader !== false && (responseHeader === traceHeader || responseHeader === tracestateHeader)) {
    throw new TypeError("responseHeader must not collide with trace headers");
  }
  if (options.message !== undefined && options.message !== "request completed") {
    throw new TypeError('message must be exactly "request completed"');
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  if (options.levelForStatus !== undefined && typeof options.levelForStatus !== "function") {
    throw new TypeError("levelForStatus must be a function");
  }
  if (options.extraFields !== undefined && typeof options.extraFields !== "function") {
    throw new TypeError("extraFields must be a function");
  }
  const normalized: NormalizedOptions = {
    preset,
    requestIdHeader,
    responseHeader,
    traceHeader,
    tracestateHeader,
    traceContextLevel: resolveTraceContextLevel(options.traceContextLevel),
    capturePath: booleanOption("capturePath", options.capturePath),
    capturePeerIp: booleanOption("capturePeerIp", options.capturePeerIp),
    captureUserAgent: booleanOption("captureUserAgent", options.captureUserAgent),
    captureError: booleanOption("captureError", options.captureError),
    clock: options.clock ?? (() => performance.now()),
  };
  if (options.levelForStatus !== undefined) {
    Object.defineProperty(normalized, "levelForStatus", { value: options.levelForStatus, enumerable: true });
  }
  if (options.extraFields !== undefined) {
    Object.defineProperty(normalized, "extraFields", { value: options.extraFields, enumerable: true });
  }
  return Object.freeze(normalized);
}

export function createRequestObservability(request: FastifyRequest, options: NormalizedOptions): RequestObservability {
  const traceparentValues = rawHeaderValues(request.raw, options.traceHeader);
  let trace = traceparentValues.length === 1 ? parseTraceparent(traceparentValues[0], options.traceContextLevel) : null;
  if (trace !== null) {
    trace = attachTracestate(trace, rawHeaderValues(request.raw, options.tracestateHeader));
  }
  return Object.freeze({
    requestId: request.id,
    correlationId: trace?.traceId ?? request.id,
    traceContext: trace,
  });
}
