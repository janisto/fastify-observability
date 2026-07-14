import type { FastifyBaseLogger, FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { type AccessState, emitAccessRecord, observeStream, requestUserAgent } from "./access.js";
import { createRequestObservability, normalizeOptions } from "./context.js";
import { correlationFields } from "./presets.js";
import { consumeRequestIdHandshake } from "./request-id.js";
import type { FastifyObservabilityOptions, RequestObservability } from "./types.js";

const INSTALLED = Symbol("fastify-observability.installed");
const STATE = Symbol("fastify-observability.state");

type InternalRequest = FastifyRequest & { [STATE]?: AccessState };

interface BindingsLogger extends FastifyBaseLogger {
  bindings(): Record<string, unknown>;
}

function hasBindings(logger: FastifyBaseLogger): logger is BindingsLogger {
  return typeof Reflect.get(logger, "bindings") === "function";
}

const implementation: FastifyPluginCallback<FastifyObservabilityOptions> = (fastify, rawOptions, done) => {
  try {
    if (fastify.hasDecorator(INSTALLED)) {
      throw new Error("fastify-observability must be registered exactly once");
    }
    if (fastify.initialConfig.requestIdHeader) {
      throw new Error("fastify-observability requires Fastify requestIdHeader: false");
    }
    const options = normalizeOptions(rawOptions);
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
        process.stderr.write(`fastify-observability: ${message}\n`);
      } catch {
        // Diagnostics are best effort and must not recurse or alter a response.
      }
    };

    fastify.addHook("onRequest", (request, reply, next) => {
      const started = performance.now();
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

      let includeRequestId = true;
      let suppressAccess = false;
      try {
        if (hasBindings(request.log)) {
          const bindings = request.log.bindings();
          if (bindings["request_id"] === request.id) {
            includeRequestId = false;
          } else if (bindings["request_id"] !== undefined) {
            includeRequestId = false;
            suppressAccess = true;
            diagnose(
              "conflicting_request_id",
              "base logger has a conflicting request_id; package access record omitted",
            );
          } else if (bindings["reqId"] === request.id) {
            diagnose("legacy_request_id_label", "configure LogController requestIdLogLabel as request_id");
          }
        }
      } catch {
        suppressAccess = true;
        diagnose("logger_bindings", "logger bindings could not be inspected; package access record omitted");
      }

      let logger = request.log;
      try {
        logger = request.log.child(correlationFields(context, options.preset, includeRequestId));
        request.log = logger;
        reply.log = logger;
      } catch {
        suppressAccess = true;
        diagnose("logger_child", "request logger enrichment failed; package access record omitted");
      }
      const state: AccessState = {
        started,
        request,
        reply,
        options,
        diagnose,
        logger,
        remoteIp: typeof request.ip === "string" && request.ip.length > 0 ? request.ip : undefined,
        userAgent: requestUserAgent(request),
        emitted: false,
        suppressAccess,
      };
      (request as InternalRequest)[STATE] = state;
      const closeListener = () => {
        if (!reply.raw.writableFinished) {
          emitAccessRecord(
            state,
            reply.raw.headersSent ? "response_aborted" : "request_aborted",
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
          sent ? "response_aborted" : "request_aborted",
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

export const fastifyObservability = fp(implementation, { fastify: "5.x", name: "fastify-observability" });

declare module "fastify" {
  interface FastifyRequest {
    observability: RequestObservability;
  }
}
