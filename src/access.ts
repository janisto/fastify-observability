import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { NormalizedOptions } from "./context.js";
import { bindingValuesEqual, PROTECTED_LOG_FIELDS } from "./logger.js";
import { rawHeaderValues } from "./request-id.js";
import type { AccessLogLevel } from "./types.js";

export type TerminalReason = "response" | "timeout" | "request_aborted" | "response_aborted";

interface AccessLogger extends FastifyBaseLogger {
  isLevelEnabled(level: AccessLogLevel): boolean;
}

export interface AccessState {
  readonly started: number;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: NormalizedOptions;
  readonly diagnose: (kind: string, message: string) => void;
  readonly loggerBindings: Readonly<Record<string, unknown>>;
  readonly inspectLoggerBindings?: () => Readonly<Record<string, unknown>>;
  logger: AccessLogger;
  remoteIp: string | undefined;
  userAgent: string | undefined;
  error?: Error;
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

export function requestPath(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl.length === 0) {
    return "/";
  }
  if (rawUrl === "*") {
    return rawUrl;
  }
  if (rawUrl.startsWith("/")) {
    const query = rawUrl.indexOf("?");
    return query === -1 ? rawUrl : rawUrl.slice(0, query);
  }
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return parsed.pathname || "/";
  } catch {
    return "/";
  }
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
  return values.length === 1 && values[0] !== undefined ? values[0] : undefined;
}

function durationMilliseconds(started: number): number {
  const value = performance.now() - started;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function protobufDuration(durationMs: number): string {
  const nanoseconds = Math.max(Math.round(durationMs * 1_000_000), 0);
  const seconds = Math.floor(nanoseconds / 1_000_000_000);
  const nanos = nanoseconds % 1_000_000_000;
  return nanos === 0 ? `${seconds}s` : `${seconds}.${String(nanos).padStart(9, "0").replace(/0+$/, "")}s`;
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
      if (RESERVED_FIELDS.has(key)) {
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
  const durationMs = durationMilliseconds(state.started);
  const path = requestPath(request.raw.url);
  const fields: Record<string, unknown> = {};
  fields["method"] = request.method;
  fields["path"] = path;
  if (!request.is404 && request.routeOptions.url !== undefined) {
    fields["path_template"] = request.routeOptions.url;
  }
  const explicitOperationId = operationId(request);
  if (explicitOperationId !== undefined) {
    fields["operation_id"] = explicitOperationId;
  }
  if (status !== undefined) {
    fields["status"] = status;
  }
  fields["duration_ms"] = durationMs;
  if (state.remoteIp !== undefined) {
    fields["remote_ip"] = state.remoteIp;
  }
  const agent = state.userAgent;
  if (agent !== undefined) {
    fields["user_agent"] = agent;
  }
  if (reason !== "response") {
    fields["terminal_reason"] = reason;
  }
  if (state.error !== undefined) {
    fields["err"] = state.error;
  }
  if (state.options.preset === "gcp") {
    const httpRequest: Record<string, unknown> = {};
    httpRequest["requestMethod"] = request.method;
    httpRequest["requestUrl"] = path;
    if (status !== undefined) {
      httpRequest["status"] = status;
    }
    httpRequest["latency"] = protobufDuration(durationMs);
    if (state.remoteIp !== undefined) {
      httpRequest["remoteIp"] = state.remoteIp;
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
    const level =
      reason === "response" && status !== undefined
        ? normalLevel(state, status)
        : state.error !== undefined || reason === "timeout"
          ? "error"
          : "warn";
    if (!state.logger.isLevelEnabled(level)) {
      return;
    }
    const loggerBindings = terminalLoggerBindings(state);
    if (loggerBindings === undefined) {
      return;
    }
    const fields = accessFields(state, reason, status, loggerBindings);
    state.logger[level](fields, state.options.message);
  } catch {
    state.diagnose("logger", "access log emission failed; the HTTP response was preserved");
  }
}
