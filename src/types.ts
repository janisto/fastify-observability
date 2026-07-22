import type { FastifyReply, FastifyRequest } from "fastify";

export type LoggingPreset = "default" | "gcp" | "aws" | "azure";
export type AccessLogLevel = "debug" | "info" | "warn" | "error";
export type TraceContextLevel = 1 | 2;

export interface TraceContext {
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
  readonly sampled: boolean;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly traceContextLevel: TraceContextLevel;
  readonly traceIdRandom?: boolean;
}

export interface RequestObservability {
  readonly requestId: string;
  readonly correlationId: string;
  readonly traceContext: TraceContext | null;
}

export type LevelForStatus = (status: number) => AccessLogLevel;
export type ExtraFields = (request: FastifyRequest, reply: FastifyReply) => Readonly<Record<string, unknown>>;

export interface FastifyObservabilityOptions {
  requestIdHeader?: string;
  responseHeader?: string | false;
  traceHeader?: string;
  tracestateHeader?: string;
  traceContextLevel?: TraceContextLevel;
  capturePath?: boolean;
  capturePeerIp?: boolean;
  captureUserAgent?: boolean;
  captureError?: boolean;
  clock?: () => number;
  levelForStatus?: LevelForStatus;
  extraFields?: ExtraFields;
}

export interface RequestIdGeneratorOptions {
  requestIdHeader?: string;
  generate?: () => string;
  validateIncoming?: (value: string) => boolean;
}
