# fastify-observability

Focused Fastify 5 request observability for validated request IDs, W3C trace
correlation, request-scoped Pino fields, and one structured terminal access
record.

The package deliberately does not create or export traces, metrics, profiles,
or logs. It has no OpenTelemetry, provider SDK, exporter, transport, or ambient
request-context dependency. Fastify and the application retain ownership of
Pino configuration, error handlers, redaction, and destinations.

## Requirements and installation

- Node.js 24
- Fastify 5.10.0 or newer within the Fastify 5 line
- ESM

Add the package to an existing pnpm project:

```bash
pnpm add fastify-observability
```

For a new application, install the minimum reviewed peer explicitly:

```bash
pnpm add fastify@^5.10.0 fastify-observability
```

## Complete setup

All four Fastify options shown here are part of the safe integration:

```ts
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createRequestIdGenerator,
} from "fastify-observability";

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
    formatters: {
      level: (label) => ({ severity: label.toUpperCase() }),
    },
  },
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: "request_id",
  }),
});

await app.register(fastifyObservability, { preset: "gcp" });
```

Register the plugin once at the root, before application plugins and routes.

- `requestIdHeader: false` prevents Fastify from accepting an unvalidated
  caller value before `genReqId` runs.
- `createRequestIdGenerator()` validates or generates the ID before Fastify
  creates `request.log`.
- `requestIdLogLabel: "request_id"` prevents competing `reqId` and
  `request_id` bindings.
- `disableRequestLogging: true` disables Fastify's separate incoming and
  completed request lines. This package emits one terminal record.

## Request and trace context

A caller request ID is accepted only when exactly one configured raw header is
present and its value contains 1–128 ASCII URI-unreserved characters:
`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, or `~`. Missing, empty, duplicate,
oversized, non-ASCII, or otherwise invalid values are replaced with a UUID v4.
Custom generators and narrowing validators are supported and failure-contained.

The selected value is available as:

- `request.id`;
- `request.observability.requestId`;
- the `request_id` Pino binding;
- the access record;
- the configured response header.

`traceparent` parsing is strict: uppercase hex, zero IDs, duplicates, malformed
delimiters, and oversized input are rejected. Version `00` is exactly 55
characters; future versions follow W3C framing. Valid `tracestate` values retain
wire order and enforce key grammar, unique keys, 32 members, and 512 bytes.
Invalid trace input is ignored and correlation falls back to the request ID.

```ts
request.observability.traceContext; // immutable TraceContext | null
request.observability.correlationId; // trace ID, otherwise request ID
```

The incoming parent ID is not a span created by this service. No preset emits a
fake current-span field.

## Access record contract

The normal terminal message is `request completed`. Pino owns the actual
message key (`msg` by default), timestamp, level formatter, serializers,
redaction, and destination.

| Field | Meaning |
| --- | --- |
| `method` | HTTP method |
| `path` | Concrete escaped path without a query string |
| `path_template` | Matched Fastify route template; omitted for a normal 404 |
| `operation_id` | Explicit `schema.operationId` only |
| `status` | Status sent on the wire, when trustworthy |
| `duration_ms` | Non-negative monotonic duration including response streaming |
| `remote_ip` | Fastify `request.ip`, honoring application `trustProxy` |
| `user_agent` | One unambiguous raw User-Agent value |
| `terminal_reason` | `timeout`, `request_aborted`, or `response_aborted` on abnormal completion |
| `err` | Observed `Error`, using Pino's error serializer contract |

Queries, bodies, cookies, authorization, and arbitrary headers are never logged.
Use `path_template` for low-cardinality aggregation; concrete `path` remains
high-cardinality diagnostic data.

Default levels are `error` for 5xx, `warn` for 4xx, and `info` otherwise.
Timeouts and observed internal stream failures use `error`; connection aborts
without an exposed error use `warn`. A final response status controls normal
completion even when an error handler translated an exception.

Development environments can opt into `debug` access records without changing
production defaults:

```ts
await app.register(fastifyObservability, {
  preset: "gcp",
  levelForStatus: (status) => status < 400 ? "debug" : status < 500 ? "warn" : "error",
});
```

Pino must also have a `debug` threshold for those records to be written.

`extraFields(request, reply)` can add synchronous application fields. Package,
Pino, provider, request/response, error, and prototype keys are reserved and
cannot be replaced. Callback and synchronous logger failures are diagnosed once
and never alter the HTTP response.

The public option unions are intentionally small: `LoggingPreset` is
`"default" | "gcp" | "aws" | "azure"`, and `AccessLogLevel` is
`"debug" | "info" | "warn" | "error"`.

## Cloud presets

Pass `preset: "gcp"`, `"aws"`, `"azure"`, or `"default"` when registering.

- `gcp` adds `logging.googleapis.com/trace`,
  `logging.googleapis.com/trace_sampled`, and structured `httpRequest`. Its
  `requestUrl` is intentionally path-only to avoid reconstructing an
  attacker-controlled or deployment-specific public URL. The application may
  configure Pino's level formatter to emit uppercase `severity`.
- `aws` adds flat `xray_trace_id` in `1-8hex-24hex` form. It does not create an
  X-Ray segment or parse legacy X-Ray headers.
- `azure` adds flat `operation_Id` and `operation_ParentId`. It does not start
  Application Insights telemetry or parse legacy request headers.

Provider fields correlate logs only. No SDK is initialized and no span is
created. See [EXAMPLES.md](EXAMPLES.md) for focused setup modules.

## Failure and lifecycle boundaries

Normal, handled-error, and unhandled-error responses emit in `onResponse` with
the final status. Connection timeouts omit the unsent default status. Upload
aborts, response disconnects, and observable Node stream errors share one
terminal guard, so overlapping hooks cannot produce a second package record.

Node parser failures before Fastify creates a request, WebSocket messages,
hijacked/raw responses, and manually managed upgrades are outside the v0.1.0
guarantee. Fastify documents client-abort detection as not completely reliable;
the package also uses the raw response close signal for supported HTTP paths.

Logging disabled in Fastify remains a deliberate no-op: request context and the
response header still work, but the package does not create an alternate stderr
access log.

## Troubleshooting

| Symptom | Cause | Correction |
| --- | --- | --- |
| Setup error on the first request | Fastify did not use the package generator, or header names differ | Keep `requestIdHeader: false`; pass the same header to generator and plugin |
| Both `reqId` and `request_id` | Default request logger label is active | Set `requestIdLogLabel: "request_id"` inside `LogController` |
| Extra incoming/completed lines | Fastify request logging is enabled | Set `disableRequestLogging: true` |
| No access record | Logging is disabled, Pino filtered the level, or a base `request_id` conflicts | Enable the intended level and remove conflicting bindings |
| Duplicate records or startup rejection | Package or superseded local plugin registered more than once | Register once at root and remove the old request/access plugin |
| Routes lack correlation | Plugin registered after routes or in a narrower scope | Register it before application plugins and routes |
| Response ID is missing/different | Later application code replaced the header | Remove or document the later application-owned mutation |
| Custom logger conflicts | Hidden base `reqId` or `request_id` binding | Use the canonical Pino setup or remove the custom binding |
| Duplicate error details | Generic error handler also logs request completion | Retain domain diagnostics; remove duplicate generic completion logs |
| GCP has `level`, not `severity` | Level formatting belongs to the application | Use the formatter shown in `examples/gcp` |

Fastify does not expose active `LogController` settings through a public getter.
The plugin can reject an active `requestIdHeader`, but it cannot prove that
built-in request logging is disabled. A legacy `reqId` label produces one
value-free diagnostic and equal validated aliases without failing traffic. A
conflicting base `request_id` suppresses only that request's package access
record.

Custom Fastify-compatible loggers without a public `bindings()` method cannot
provide the same schema proof as Fastify's Pino logger. Pino redaction,
serializers, transports, and destination error handling remain application
responsibilities. Configure `trustProxy` only for proxies the application
actually trusts.

## Compatibility and stability

The package is ESM-only, supports Node 24 or newer and Fastify `^5.10.0`, and follows
semantic versioning. During `0.x`, public types, option behavior, and structured
field changes are called out in the changelog. Deep imports are unsupported.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm qa
```

The complete gate covers formatting/lint, strict TypeScript, unit and real
HTTP/1.1/HTTP/2 behavior, 90% global coverage thresholds, and build output.

## License

MIT
