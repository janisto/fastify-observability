import type { FastifyBaseLogger } from "fastify";
import type { Level } from "pino";

type Fields = Readonly<Record<string, unknown>>;

/** Write a structured message through an application-provided Fastify logger. */
export function log(logger: FastifyBaseLogger, level: Level, message: string, fields: Fields = {}): void {
  logger[level](fields, message);
}

export function debug(logger: FastifyBaseLogger, message: string, fields: Fields = {}): void {
  log(logger, "debug", message, fields);
}

export function info(logger: FastifyBaseLogger, message: string, fields: Fields = {}): void {
  log(logger, "info", message, fields);
}

export function warn(logger: FastifyBaseLogger, message: string, fields: Fields = {}): void {
  log(logger, "warn", message, fields);
}

export function error(logger: FastifyBaseLogger, message: string, cause: Error, fields: Fields = {}): void {
  const payload: Record<string, unknown> = { err: cause };
  for (const key of Object.keys(fields)) {
    if (key !== "err") {
      payload[key] = fields[key];
    }
  }
  logger.error(payload, message);
}
