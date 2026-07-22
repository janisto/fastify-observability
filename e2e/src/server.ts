import process from "node:process";
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  type FastifyObservabilityOptions,
  type ObservabilityLoggerOptions,
  type TraceContextLevel,
} from "fastify-observability";

const CASES = ["common_level1", "common_level2", "aws_level1", "azure_level1", "gcp_level1"] as const;
type E2ECase = (typeof CASES)[number];

const e2eConfiguration = {
  system_id: "sys-402",
  server_settings: {
    nodes: [{ hostname: "srv-01", port: 8080, ssl_enabled: true }],
  },
} as const;

function caseName(): E2ECase {
  const value = process.env["OBS_E2E_CASE"];
  if (value === undefined || !CASES.includes(value as E2ECase)) {
    throw new Error("OBS_E2E_CASE must select one supported E2E case");
  }
  return value as E2ECase;
}

function expectedCanary(): string {
  const value = process.env["OBS_E2E_SECRET_CANARY"];
  if (value === undefined || value.length === 0) {
    throw new Error("OBS_E2E_SECRET_CANARY must be nonempty");
  }
  return value;
}

function port(): number {
  const raw = process.env["PORT"] ?? "8080";
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("PORT must be an integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  return value;
}

function configuration(selected: E2ECase): {
  logger: ObservabilityLoggerOptions;
  plugin: FastifyObservabilityOptions;
} {
  const traceContextLevel: TraceContextLevel = selected === "common_level2" ? 2 : 1;
  switch (selected) {
    case "aws_level1":
      return {
        logger: { preset: "aws", awsProfileVersion: "0.1.0" },
        plugin: { traceContextLevel },
      };
    case "azure_level1":
      return {
        logger: { preset: "azure", azureProfileVersion: "0.1.0" },
        plugin: { traceContextLevel },
      };
    case "gcp_level1":
      return {
        logger: { preset: "gcp", gcpProfileVersion: "0.1.0" },
        plugin: {
          traceContextLevel,
          extraFields: () => ({ e2e_configuration: e2eConfiguration }),
        },
      };
    case "common_level1":
    case "common_level2":
      return { logger: { preset: "default" }, plugin: { traceContextLevel } };
  }
}

async function start(): Promise<void> {
  const selected = caseName();
  const canary = expectedCanary();
  const configured = configuration(selected);
  const app = Fastify({
    loggerInstance: createObservabilityLogger(configured.logger),
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id",
    }),
  });
  await app.register(fastifyObservability, configured.plugin);
  app.get("/trace", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${canary}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.log.info({ event: "trace" }, "handler");
    return {
      ok: true,
      request_id: request.observability.requestId,
      canary_received: true,
    };
  });
  await app.listen({ host: "0.0.0.0", port: port() });
}

start().catch(() => {
  process.stderr.write("fastify E2E server failed\n");
  process.exitCode = 1;
});
