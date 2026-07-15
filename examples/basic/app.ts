import Fastify, { LogController } from "fastify";
import fastifyObservability, { createObservabilityLogger, createRequestIdGenerator } from "fastify-observability";

export const app = Fastify({
  loggerInstance: createObservabilityLogger(),
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: "request_id",
  }),
});

app.register(fastifyObservability);
