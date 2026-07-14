import type { FastifyReply, FastifyRequest } from "fastify";

export type LoggingPreset = "default" | "gcp" | "aws" | "azure";
export type AccessLogLevel = "debug" | "info" | "warn" | "error";

export interface TraceContext {
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
  readonly sampled: boolean;
  readonly traceparent: string;
  readonly tracestate?: string;
}

export interface RequestObservability {
  readonly requestId: string;
  readonly correlationId: string;
  readonly traceContext: TraceContext | null;
}

export type LevelForStatus = (status: number) => AccessLogLevel;
export type ExtraFields = (request: FastifyRequest, reply: FastifyReply) => Readonly<Record<string, unknown>>;

export interface FastifyObservabilityOptions {
  preset?: LoggingPreset;
  requestIdHeader?: string;
  responseHeader?: string | false;
  traceHeader?: string;
  tracestateHeader?: string;
  message?: string;
  levelForStatus?: LevelForStatus;
  extraFields?: ExtraFields;
}

export interface RequestIdGeneratorOptions {
  requestIdHeader?: string;
  generate?: () => string;
  validate?: (value: string) => boolean;
}
