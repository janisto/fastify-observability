import { Writable } from "node:stream";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import fastifyObservability, {
  createRequestIdGenerator,
  type FastifyObservabilityOptions,
} from "fastify-observability";

export interface LogRecord {
  [key: string]: unknown;
  msg?: string;
  level?: number;
}

export class JsonLineStream extends Writable {
  readonly records: LogRecord[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      for (const line of chunk.toString().split("\n")) {
        if (line.length > 0) {
          this.records.push(JSON.parse(line) as LogRecord);
        }
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("failed to parse log record"));
    }
  }
}

export async function buildTestApp(
  pluginOptions: FastifyObservabilityOptions = {},
  setup: { canonicalLabel?: boolean; logger?: boolean } = {},
): Promise<{ app: FastifyInstance; records: LogRecord[] }> {
  const stream = new JsonLineStream();
  const canonicalLabel = setup.canonicalLabel ?? true;
  const generatorOptions =
    pluginOptions.requestIdHeader === undefined ? {} : { requestIdHeader: pluginOptions.requestIdHeader };
  const app = Fastify({
    logger: setup.logger === false ? false : { level: "debug", stream },
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(generatorOptions),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: canonicalLabel ? "request_id" : "reqId",
    }),
  });
  await app.register(fastifyObservability, pluginOptions);
  return { app, records: stream.records };
}

export function accessRecords(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.msg === "request completed");
}
