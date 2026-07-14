import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import type { NormalizedOptions } from "./context.js";
import { rawHeaderValues } from "./request-id.js";
import type { AccessLogLevel } from "./types.js";

export type TerminalReason = "response" | "timeout" | "request_aborted" | "response_aborted";

export interface AccessState {
  readonly started: number;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly options: NormalizedOptions;
  readonly diagnose: (kind: string, message: string) => void;
  logger: FastifyBaseLogger;
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
  "time",
  "timestamp",
  "level",
  "severity",
  "msg",
  "message",
  "pid",
  "hostname",
  "name",
  "logger",
  "reqId",
  "req",
  "res",
  "err",
  "error",
  "request_id",
  "correlation_id",
  "trace_id",
  "parent_id",
  "trace_flags",
  "trace_sampled",
  "method",
  "path",
  "path_template",
  "operation_id",
  "status",
  "duration_ms",
  "remote_ip",
  "user_agent",
  "terminal_reason",
  "httpRequest",
  "logging.googleapis.com/trace",
  "logging.googleapis.com/trace_sampled",
  "logging.googleapis.com/spanId",
  "xray_trace_id",
  "operation_Id",
  "operation_ParentId",
  "__proto__",
  "constructor",
  "prototype",
]);

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

function copyExtraFields(state: AccessState, fields: Record<string, unknown>): void {
  const callback = state.options.extraFields;
  if (callback === undefined) {
    return;
  }
  try {
    const result = callback(state.request, state.reply);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("extraFields must return a record");
    }
    const custom: Record<string, unknown> = {};
    for (const key of Object.keys(result)) {
      if (!RESERVED_FIELDS.has(key)) {
        custom[key] = result[key];
      }
    }
    for (const key of Object.keys(custom)) {
      fields[key] = custom[key];
    }
  } catch {
    state.diagnose("extra_fields", "extraFields failed; custom access fields were omitted");
  }
}

function accessFields(state: AccessState, reason: TerminalReason, status: number | undefined): Record<string, unknown> {
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
  copyExtraFields(state, fields);
  return fields;
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
  const level =
    reason === "response" && status !== undefined
      ? normalLevel(state, status)
      : state.error !== undefined || reason === "timeout"
        ? "error"
        : "warn";
  try {
    state.logger[level](accessFields(state, reason, status), state.options.message);
  } catch {
    state.diagnose("logger", "access log emission failed; the HTTP response was preserved");
  }
}
