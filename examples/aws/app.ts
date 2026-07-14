import Fastify, { LogController } from "fastify";
import fastifyObservability, { createRequestIdGenerator } from "fastify-observability";

export const app = Fastify({
  logger: true,
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: "request_id",
  }),
});

app.register(fastifyObservability, { preset: "aws" });
