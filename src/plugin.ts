import type { FastifyBaseLogger, FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Logger } from "pino";
import { type AccessState, emitAccessRecord, observeStream, requestUserAgent } from "./access.js";
import { createRequestObservability, normalizeOptions } from "./context.js";
import { bindingValuesEqual, canonicalLoggerProfile, createCanonicalChild, PROTECTED_LOG_FIELDS } from "./logger.js";
import { correlationFields } from "./presets.js";
import { consumeRequestIdHandshake } from "./request-id.js";
import type { FastifyObservabilityOptions, RequestObservability } from "./types.js";

const INSTALLED = Symbol("fastify-observability.installed");
const STATE = Symbol("fastify-observability.state");

type InternalRequest = FastifyRequest & { [STATE]?: AccessState };

type PinoLogger = FastifyBaseLogger & Logger;

function startClock(
  configured: () => number,
  diagnose: (kind: string, message: string) => void,
): { clock: () => number; started: number } {
  try {
    const started = configured();
    if (!Number.isFinite(started)) {
      throw new TypeError("clock returned a non-finite value");
    }
    return { clock: configured, started };
  } catch {
    diagnose("clock", "clock failed at request start; using the runtime monotonic clock");
    const clock = () => performance.now();
    return { clock, started: clock() };
  }
}

function isPinoLogger(logger: FastifyBaseLogger): logger is PinoLogger {
  // The package marker establishes construction; these public methods verify the object still has Pino's contract.
  try {
    return (
      typeof Reflect.get(logger, "version") === "string" &&
      typeof Reflect.get(logger, "bindings") === "function" &&
      typeof Reflect.get(logger, "isLevelEnabled") === "function"
    );
  } catch {
    return false;
  }
}

function snapshotBindings(logger: PinoLogger): Record<string, unknown> {
  const bindings: unknown = logger.bindings();
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError("logger bindings must be a record");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(bindings)) {
    snapshot[key] = Reflect.get(bindings, key);
  }
  return snapshot;
}

function validateRootBindings(bindings: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(bindings)) {
    if (PROTECTED_LOG_FIELDS.has(key)) {
      throw new Error(`fastify-observability reserves Pino base binding "${key}"`);
    }
  }
}

function validateChildBindings(
  parent: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
  child: Readonly<Record<string, unknown>>,
): void {
  const allowed = new Set([...Object.keys(parent), ...Object.keys(expected)]);
  for (const key of Object.keys(child)) {
    if (!allowed.has(key)) {
      throw new Error("Pino child introduced an unexpected binding");
    }
  }
  for (const key of Object.keys(parent)) {
    if (!Object.hasOwn(child, key) || !bindingValuesEqual(child[key], parent[key])) {
      throw new Error("Pino child did not preserve its parent bindings");
    }
  }
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(child, key) || !bindingValuesEqual(child[key], expected[key])) {
      throw new Error("Pino child did not retain the package correlation bindings");
    }
  }
}

function validateStablePackageBindings(
  initial: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): void {
  const initialKeys = Object.keys(initial);
  const currentKeys = Object.keys(current);
  if (initialKeys.length !== currentKeys.length) {
    throw new Error("Pino bindings changed after request setup");
  }
  for (const key of initialKeys) {
    if (!Object.hasOwn(current, key) || !bindingValuesEqual(initial[key], current[key])) {
      throw new Error("Pino bindings changed after request setup");
    }
  }
}

const implementation: FastifyPluginCallback<FastifyObservabilityOptions> = (fastify, rawOptions, done) => {
  try {
    if (fastify.hasDecorator(INSTALLED)) {
      throw new Error("fastify-observability must be registered exactly once");
    }
    if (fastify.initialConfig.requestIdHeader) {
      throw new Error("fastify-observability requires Fastify requestIdHeader: false");
    }
    const rootLogger = fastify.log;
    if (!isPinoLogger(rootLogger)) {
      throw new Error("fastify-observability requires loggerInstance from createObservabilityLogger()");
    }
    const profile = canonicalLoggerProfile(rootLogger);
    if (profile === undefined) {
      throw new Error("fastify-observability requires loggerInstance from createObservabilityLogger()");
    }
    const rootBindings = snapshotBindings(rootLogger);
    validateRootBindings(rootBindings);
    const options = normalizeOptions(rawOptions, profile.preset);
    fastify.decorate(INSTALLED, true);
    fastify.decorateRequest("observability");
    fastify.decorateRequest(STATE);

    const diagnostics = new Set<string>();
    const diagnose = (kind: string, message: string) => {
      if (diagnostics.has(kind)) {
        return;
      }
      diagnostics.add(kind);
      try {
        rootLogger.warn({ observability_diagnostic: kind }, `fastify-observability: ${message}`);
        return;
      } catch {
        // Fall through only when the configured Pino logger itself failed synchronously.
      }
      try {
        process.stderr.write(`fastify-observability: ${message}\n`);
      } catch {
        // Diagnostics are best effort and must not recurse or alter a response.
      }
    };

    fastify.addHook("onRequest", (request, reply, next) => {
      const { clock, started } = startClock(options.clock, diagnose);
      if (!consumeRequestIdHandshake(request.raw, request.id, options.requestIdHeader)) {
        diagnose("request_id_setup", "validated request-ID generator handshake failed");
        next(new Error("fastify-observability request-ID setup is unsafe"));
        return;
      }

      const context = createRequestObservability(request, options);
      request.observability = context;
      if (options.responseHeader !== false) {
        reply.header(options.responseHeader, context.requestId);
      }

      let suppressAccess = false;
      let loggerBindings: Record<string, unknown> = {};
      let logger: PinoLogger = rootLogger;
      let inspectLoggerBindings: (() => Readonly<Record<string, unknown>>) | undefined;
      if (!isPinoLogger(request.log) || canonicalLoggerProfile(request.log) !== profile) {
        suppressAccess = true;
        diagnose("request_logger", "Fastify produced a noncanonical request logger; package access record omitted");
      } else {
        try {
          const requestBindings = snapshotBindings(request.log);
          if (Object.hasOwn(requestBindings, "reqId")) {
            suppressAccess = true;
            diagnose(
              "legacy_request_id_label",
              "configure LogController requestIdLogLabel as request_id; package access record omitted",
            );
          } else if (!bindingValuesEqual(requestBindings["request_id"], request.id)) {
            suppressAccess = true;
            diagnose(
              "request_logger",
              "Pino request logger lacks the canonical request_id binding; package access record omitted",
            );
          } else {
            validateChildBindings(rootBindings, { request_id: request.id }, requestBindings);
            const expected = correlationFields(context, options.preset);
            const enrichment = { ...expected };
            delete enrichment["request_id"];
            const child = createCanonicalChild(request.log, enrichment);
            if (!isPinoLogger(child) || canonicalLoggerProfile(child) !== profile) {
              throw new TypeError("Pino child logger contract was not preserved");
            }
            const childBindings = snapshotBindings(child);
            validateChildBindings(requestBindings, expected, childBindings);
            logger = child;
            loggerBindings = childBindings;
            inspectLoggerBindings = () => {
              const currentBindings = snapshotBindings(child);
              validateStablePackageBindings(childBindings, currentBindings);
              return currentBindings;
            };
            request.log = child;
            reply.log = child;
          }
        } catch {
          suppressAccess = true;
          diagnose("logger_setup", "Pino request logger setup failed; package access record omitted");
        }
      }
      let peerIp: string | undefined;
      if (options.capturePeerIp) {
        try {
          const candidate = request.raw.socket.remoteAddress;
          peerIp = typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
        } catch {
          diagnose("peer_ip", "direct peer IP resolution failed; peer_ip was omitted");
        }
      }
      const state: AccessState = {
        started,
        clock,
        request,
        reply,
        options,
        diagnose,
        logger,
        loggerBindings,
        peerIp,
        userAgent: options.captureUserAgent ? requestUserAgent(request) : undefined,
        emitted: false,
        suppressAccess,
        ...(inspectLoggerBindings === undefined ? {} : { inspectLoggerBindings }),
      };
      (request as InternalRequest)[STATE] = state;
      const closeListener = () => {
        if (!reply.raw.writableFinished) {
          emitAccessRecord(
            state,
            state.error === undefined ? "client_disconnect" : "body_error",
            reply.raw.headersSent ? reply.raw.statusCode : undefined,
          );
        }
      };
      state.closeListener = closeListener;
      reply.raw.once("close", closeListener);
      next();
    });

    fastify.addHook("onError", (request, _reply, error, next) => {
      const state = (request as InternalRequest)[STATE];
      if (state !== undefined) {
        state.error = error;
      }
      next();
    });

    fastify.addHook("onSend", (request, _reply, payload, next) => {
      const state = (request as InternalRequest)[STATE];
      if (state !== undefined) {
        observeStream(state, payload);
      }
      next(null, payload);
    });

    fastify.addHook("onResponse", (request, reply, next) => {
      const state = (request as InternalRequest)[STATE];
      if (state !== undefined) {
        emitAccessRecord(state, "response", reply.raw.statusCode);
      }
      next();
    });

    fastify.addHook("onTimeout", (request, _reply, next) => {
      const state = (request as InternalRequest)[STATE];
      if (state !== undefined) {
        emitAccessRecord(state, "timeout");
      }
      next();
    });

    fastify.addHook("onRequestAbort", (request, next) => {
      const state = (request as InternalRequest)[STATE];
      if (state !== undefined) {
        const sent = state.reply.raw.headersSent;
        emitAccessRecord(
          state,
          state.error === undefined ? "client_disconnect" : "body_error",
          sent ? state.reply.raw.statusCode : undefined,
        );
      }
      next();
    });

    done();
  } catch (error) {
    done(error instanceof Error ? error : new Error("fastify-observability registration failed"));
  }
};

export const fastifyObservability = fp(implementation, { fastify: "^5.10.0", name: "fastify-observability" });

declare module "fastify" {
  interface FastifyRequest {
    observability: RequestObservability;
  }
}
