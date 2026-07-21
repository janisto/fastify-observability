import { isIP } from "node:net";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { NormalizedOptions } from "./context.js";
import { bindingValuesEqual, isProtectedLogField, markTrustedLogFields, PROTECTED_LOG_FIELDS } from "./logger.js";
import { isNativeFieldContent, rawHeaderValues } from "./request-id.js";
import type { AccessLogLevel } from "./types.js";

export type TerminalReason = "response" | "timeout" | "client_disconnect" | "body_error";

interface AccessLogger extends FastifyBaseLogger {
  isLevelEnabled(level: AccessLogLevel): boolean;
}

export interface AccessState {
  readonly started: number;
  readonly clock: () => number;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: NormalizedOptions;
  readonly diagnose: (kind: string, message: string) => void;
  readonly loggerBindings: Readonly<Record<string, unknown>>;
  readonly inspectLoggerBindings?: () => Readonly<Record<string, unknown>>;
  logger: AccessLogger;
  peerIp: string | undefined;
  userAgent: string | undefined;
  error?: Error;
  streamFailed: boolean;
  emitted: boolean;
  suppressAccess: boolean;
  closeListener?: () => void;
  stream?: StreamLike;
  streamErrorListener?: (error: Error) => void;
}

interface StreamLike {
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

export const RESERVED_FIELDS = new Set([
  ...PROTECTED_LOG_FIELDS,
  "name",
  "logger",
  "req",
  "res",
  "error",
  "__proto__",
  "constructor",
  "prototype",
]);

const ACCESS_LOG_LEVELS: readonly AccessLogLevel[] = ["debug", "info", "warn", "error"];

export function requestPath(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined || !rawUrl.startsWith("/") || rawUrl.includes("#")) {
    return undefined;
  }
  const query = rawUrl.indexOf("?");
  const path = query === -1 ? rawUrl : rawUrl.slice(0, query);
  return /%(?![0-9A-Fa-f]{2})/.test(path) ? undefined : path;
}

export function canonicalPeerIp(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate.includes("%")) {
    return undefined;
  }
  const version = isIP(candidate);
  if (version === 4) {
    return candidate;
  }
  if (version !== 6) {
    return undefined;
  }
  const hostname = new URL(`http://[${candidate}]/`).hostname;
  return hostname.slice(1, -1);
}

const MAX_PROTOBUF_DURATION_MILLISECONDS_EXCLUSIVE = 315_576_000_001_000;

function splitRouteSegments(template: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let escaped = false;
  for (const character of template.slice(1)) {
    if (escaped) {
      segment += `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "/") {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  if (escaped) {
    segment += "\\";
  }
  segments.push(segment);
  return segments;
}

export function canonicalRouteTemplate(nativeTemplate: string): string | undefined {
  if (nativeTemplate === "*") {
    return "/{*path}";
  }
  if (!nativeTemplate.startsWith("/") || nativeTemplate.includes("#")) {
    return undefined;
  }
  const canonical: string[] = [];
  const segments = splitRouteSegments(nativeTemplate);
  for (const [index, segment] of segments.entries()) {
    if (segment === "*") {
      if (index !== segments.length - 1) {
        return undefined;
      }
      canonical.push("{*path}");
      continue;
    }
    if (segment.startsWith(":")) {
      const constraintStart = segment.indexOf("(");
      const name = segment.slice(1, constraintStart === -1 ? undefined : constraintStart);
      const constraint = constraintStart === -1 ? "" : segment.slice(constraintStart);
      if (
        name.length === 0 ||
        [...name].some((character) => "/{}*?#:".includes(character)) ||
        (constraint !== "" && !isRouteConstraint(constraint))
      ) {
        return undefined;
      }
      canonical.push(`{${name}}`);
      continue;
    }
    const staticSegment = segment.replaceAll("::", ":");
    if (staticSegment.includes("::") || /(^|[^:]):([^:]|$)/.test(segment) || /[*{}?]/.test(segment)) {
      return undefined;
    }
    canonical.push(staticSegment);
  }
  return `/${canonical.join("/")}`;
}

function isRouteConstraint(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) {
    return false;
  }
  let depth = 0;
  let escaped = false;
  let inCharacterClass = false;
  const characters = [...value];
  for (const [index, character] of characters.entries()) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) {
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index !== characters.length - 1) {
        return false;
      }
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0 && !escaped && !inCharacterClass;
}

function operationId(request: FastifyRequest): string | undefined {
  const schema: unknown = request.routeOptions.schema;
  if (schema === null || typeof schema !== "object") {
    return undefined;
  }
  try {
    const value = Reflect.get(schema, "operationId");
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function requestUserAgent(request: FastifyRequest): string | undefined {
  const values = rawHeaderValues(request.raw, "user-agent");
  const value = values.length === 1 ? values[0] : undefined;
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return isNativeFieldContent(value) ? value : undefined;
}

function durationMilliseconds(state: AccessState): number {
  let value: number;
  try {
    value = state.clock() - state.started;
  } catch {
    state.diagnose("clock", "clock failed; access duration fell back to zero");
    return 0;
  }
  if (!Number.isFinite(value)) {
    state.diagnose("clock", "clock returned a non-finite value; access duration fell back to zero");
    return 0;
  }
  return value > 0 ? value : 0;
}

function protobufDuration(durationMs: number): string | undefined {
  if (durationMs >= MAX_PROTOBUF_DURATION_MILLISECONDS_EXCLUSIVE) {
    return undefined;
  }
  let seconds = Math.floor(durationMs / 1_000);
  let nanos = Math.max(Math.round((durationMs - seconds * 1_000) * 1_000_000), 0);
  if (nanos === 1_000_000_000) {
    seconds += 1;
    nanos = 0;
  }
  if (nanos === 0) {
    return `${seconds}s`;
  }
  const precision = nanos % 1_000_000 === 0 ? 3 : nanos % 1_000 === 0 ? 6 : 9;
  const fraction = String(nanos / 10 ** (9 - precision)).padStart(precision, "0");
  return `${seconds}.${fraction}s`;
}

function defaultLevel(status: number): AccessLogLevel {
  if (status >= 500) {
    return "error";
  }
  return status >= 400 ? "warn" : "info";
}

function normalLevel(state: AccessState, status: number): AccessLogLevel {
  const callback = state.options.levelForStatus;
  if (callback !== undefined) {
    try {
      const value = callback(status);
      if (value === "debug" || value === "info" || value === "warn" || value === "error") {
        return value;
      }
    } catch {
      // Fall through to the built-in mapping.
    }
    state.diagnose("level_callback", "levelForStatus failed; using the built-in level mapping");
  }
  return defaultLevel(status);
}

function copyExtraFields(
  state: AccessState,
  fields: Record<string, unknown>,
  loggerBindings: Readonly<Record<string, unknown>>,
): void {
  const callback = state.options.extraFields;
  if (callback === undefined) {
    return;
  }
  try {
    const result = callback(state.request, state.reply);
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(result))
    ) {
      throw new TypeError("extraFields must return a record");
    }
    const custom = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(result)) {
      if (RESERVED_FIELDS.has(key) || isProtectedLogField(key)) {
        continue;
      }
      const value = result[key];
      if (Object.hasOwn(loggerBindings, key)) {
        if (!bindingValuesEqual(loggerBindings[key], value)) {
          state.diagnose("extra_fields_conflict", "an extra field conflicts with a logger binding; field omitted");
        }
        continue;
      }
      custom[key] = value;
    }
    for (const key of Object.keys(custom)) {
      fields[key] = custom[key];
    }
  } catch {
    state.diagnose("extra_fields", "extraFields failed; custom access fields were omitted");
  }
}

function accessFields(
  state: AccessState,
  reason: TerminalReason,
  status: number | undefined,
  loggerBindings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const request = state.request;
  const durationMs = durationMilliseconds(state);
  const path = state.options.capturePath ? requestPath(request.raw.url) : undefined;
  const fields: Record<string, unknown> = {};
  fields["method"] = request.method;
  if (path !== undefined) {
    fields["path"] = path;
  }
  if (!request.is404) {
    const routeUrl: unknown = request.routeOptions.url;
    if (typeof routeUrl === "string") {
      const pathTemplate = canonicalRouteTemplate(routeUrl);
      if (pathTemplate !== undefined) {
        fields["path_template"] = pathTemplate;
      }
    }
    const explicitOperationId = operationId(request);
    if (explicitOperationId !== undefined) {
      fields["operation_id"] = explicitOperationId;
    }
  }
  if (status !== undefined) {
    fields["status"] = status;
  }
  fields["duration_ms"] = durationMs;
  if (state.peerIp !== undefined) {
    fields["peer_ip"] = state.peerIp;
  }
  const agent = state.userAgent;
  if (agent !== undefined) {
    fields["user_agent"] = agent;
  }
  if (reason !== "response") {
    fields["terminal_reason"] = reason;
  }
  if (state.options.captureError && state.error !== undefined) {
    fields["err"] = state.error;
  }
  if (state.options.preset === "gcp") {
    const httpRequest: Record<string, unknown> = {};
    httpRequest["requestMethod"] = request.method;
    if (path !== undefined) {
      httpRequest["requestUrl"] = path;
    }
    if (status !== undefined) {
      httpRequest["status"] = status;
    }
    const latency = protobufDuration(durationMs);
    if (latency !== undefined) {
      httpRequest["latency"] = latency;
    }
    if (state.peerIp !== undefined) {
      httpRequest["remoteIp"] = state.peerIp;
    }
    if (agent !== undefined) {
      httpRequest["userAgent"] = agent;
    }
    fields["httpRequest"] = httpRequest;
  }
  copyExtraFields(state, fields, loggerBindings);
  return fields;
}

function terminalLoggerBindings(state: AccessState): Readonly<Record<string, unknown>> | undefined {
  let bindings = state.loggerBindings;
  if (state.inspectLoggerBindings !== undefined) {
    try {
      bindings = state.inspectLoggerBindings();
    } catch {
      state.diagnose("logger_bindings", "Pino bindings could not be verified; package access record omitted");
      return undefined;
    }
  }
  return bindings;
}

export function cleanupListeners(state: AccessState): void {
  if (state.closeListener !== undefined) {
    try {
      state.reply.raw.removeListener("close", state.closeListener);
    } catch {
      state.diagnose("close_listener_cleanup", "response close-listener cleanup failed");
    } finally {
      delete state.closeListener;
    }
  }
  if (state.stream !== undefined && state.streamErrorListener !== undefined) {
    try {
      state.stream.removeListener("error", state.streamErrorListener);
    } catch {
      state.diagnose("stream_listener_cleanup", "response stream-listener cleanup failed");
    } finally {
      delete state.stream;
      delete state.streamErrorListener;
    }
  }
}

export function observeStream(state: AccessState, payload: unknown): void {
  if (payload === null || typeof payload !== "object") {
    return;
  }
  const candidate = payload as Partial<StreamLike>;
  if (typeof candidate.once !== "function" || typeof candidate.removeListener !== "function") {
    return;
  }
  const stream = candidate as StreamLike;
  const listener = (error: Error) => {
    state.streamFailed = true;
    state.error = error instanceof Error ? error : new Error("response stream failed");
  };
  state.stream = stream;
  state.streamErrorListener = listener;
  try {
    stream.once("error", listener);
  } catch {
    try {
      stream.removeListener("error", listener);
    } catch {
      // The diagnostic below covers both attachment and best-effort cleanup.
    }
    delete state.stream;
    delete state.streamErrorListener;
    state.diagnose("stream_listener", "response stream observation failed; the response was preserved");
  }
}

export function emitAccessRecord(state: AccessState, reason: TerminalReason, status?: number): void {
  if (state.emitted) {
    return;
  }
  state.emitted = true;
  cleanupListeners(state);
  if (state.suppressAccess) {
    return;
  }
  try {
    // Check every package level instead of assuming Pino's public level map
    // has remained monotonic. This still avoids all enrichment when none can
    // be emitted, including the normal `fatal` and `silent` thresholds.
    if (!ACCESS_LOG_LEVELS.some((candidate) => state.logger.isLevelEnabled(candidate))) {
      return;
    }
    const level = reason === "response" ? (status === undefined ? "info" : normalLevel(state, status)) : "error";
    if (!state.logger.isLevelEnabled(level)) {
      return;
    }
    const loggerBindings = terminalLoggerBindings(state);
    if (loggerBindings === undefined) {
      return;
    }
    const fields = accessFields(state, reason, status, loggerBindings);
    state.logger[level](markTrustedLogFields(fields), "request completed");
  } catch {
    state.diagnose("logger", "access log emission failed; the HTTP response was preserved");
  }
}
