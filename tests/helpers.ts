import { Writable } from "node:stream";
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
  type FastifyObservabilityOptions,
  type LoggingPreset,
  type ObservabilityLoggerOptions,
} from "fastify-observability";

export interface LogRecord {
  [key: string]: unknown;
  message?: string;
  level?: number;
}

export class JsonLineStream extends Writable {
  readonly lines: string[] = [];
  readonly records: LogRecord[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      for (const line of chunk.toString().split("\n")) {
        if (line.length > 0) {
          this.lines.push(line);
          const record = JSON.parse(line) as LogRecord;
          this.records.push(record);
          this.emit("record", record);
        }
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("failed to parse log record"));
    }
  }
}

export function topLevelKeyOccurrences(line: string, key: string): number {
  JSON.parse(line);
  let depth = 0;
  let occurrences = 0;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      index += 1;
      while (index < line.length) {
        const stringCharacter = line[index];
        if (escaped) {
          escaped = false;
        } else if (stringCharacter === "\\") {
          escaped = true;
        } else if (stringCharacter === '"') {
          break;
        }
        index += 1;
      }
      const token = line.slice(start, index + 1);
      let following = index + 1;
      while (/\s/.test(line[following] ?? "")) {
        following += 1;
      }
      if (depth === 1 && line[following] === ":" && JSON.parse(token) === key) {
        occurrences += 1;
      }
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
    index += 1;
  }
  return occurrences;
}

export async function buildTestApp(
  pluginOptions: FastifyObservabilityOptions = {},
  setup: {
    canonicalLabel?: boolean;
    level?: ObservabilityLoggerOptions["level"];
    preset?: LoggingPreset;
    redact?: ObservabilityLoggerOptions["redact"];
  } = {},
) {
  const stream = new JsonLineStream();
  const canonicalLabel = setup.canonicalLabel ?? true;
  const preset = setup.preset ?? "default";
  const generatorOptions =
    pluginOptions.requestIdHeader === undefined ? {} : { requestIdHeader: pluginOptions.requestIdHeader };
  const app = Fastify({
    loggerInstance: createObservabilityLogger({
      preset,
      level: setup.level ?? "debug",
      ...(setup.redact === undefined ? {} : { redact: setup.redact }),
      destination: stream,
    }),
    requestIdHeader: false,
    genReqId: createRequestIdGenerator(generatorOptions),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: canonicalLabel ? "request_id" : "reqId",
    }),
  });
  await app.register(fastifyObservability, pluginOptions);
  return { app, lines: stream.lines, records: stream.records };
}

export function accessRecords(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.message === "request completed");
}

export function diagnosticRecords(records: readonly LogRecord[]): LogRecord[] {
  return records.filter(
    (record) => typeof record.message === "string" && record.message.startsWith("fastify-observability:"),
  );
}

export function diagnosticKinds(records: readonly LogRecord[]): unknown[] {
  return diagnosticRecords(records).map((record) => record["observability_diagnostic"]);
}
