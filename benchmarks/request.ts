import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import Fastify, { LogController } from "fastify";
import fastifyObservability, { createRequestIdGenerator } from "fastify-observability";

const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
const iterations = Number(process.env["ITERATIONS"] ?? 10_000);

async function run(withPlugin: boolean, logging: boolean): Promise<number> {
  const app = Fastify({
    logger: logging ? { level: "info", stream: sink } : false,
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(),
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
  });
  if (withPlugin) {
    await app.register(fastifyObservability);
  }
  app.get("/", () => ({ ok: true }));
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential requests measure per-request overhead without concurrency noise
    await app.inject("/");
  }
  const duration = performance.now() - started;
  await app.close();
  return duration;
}

async function measure(logging: boolean) {
  const baselineMs = await run(false, logging);
  const pluginMs = await run(true, logging);
  return {
    logging: logging ? "sink" : "disabled",
    baselineMs,
    pluginMs,
    overheadPercent: ((pluginMs - baselineMs) / baselineMs) * 100,
  };
}

const results = [await measure(false), await measure(true)];
process.stdout.write(`${JSON.stringify({ node: process.version, iterations, results })}\n`);
