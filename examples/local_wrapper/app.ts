import Fastify, { LogController } from "fastify";
import fastifyObservability, { createObservabilityLogger, createRequestIdGenerator } from "fastify-observability";
import * as applog from "./applog.js";

export const app = Fastify({
  loggerInstance: createObservabilityLogger({ preset: "gcp" }),
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: "request_id",
  }),
});

app.register(fastifyObservability);

app.get<{ Params: { itemId: string } }>("/items/:itemId", (request) => {
  applog.info(request.log, "loading item", { item_id: request.params.itemId });
  return { itemId: request.params.itemId };
});
