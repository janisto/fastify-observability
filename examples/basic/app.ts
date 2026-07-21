import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  type TraceContextLevel,
} from "fastify-observability";

function createBasicApp(traceContextLevel?: TraceContextLevel) {
  const app = Fastify({
    loggerInstance: createObservabilityLogger(),
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id",
    }),
  });

  app.register(fastifyObservability, traceContextLevel === undefined ? {} : { traceContextLevel });
  return app;
}

export const createDefaultApp = () => createBasicApp();
export const createLevel2App = () => createBasicApp(2);

export const app = createDefaultApp();
