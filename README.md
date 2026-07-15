# fastify-observability

Opinionated Fastify 5 request logging: validated request IDs, strict W3C trace
correlation, request-scoped Pino fields, and exactly one structured terminal
access record.

The package creates the Pino logger used by Fastify. It does not initialize
OpenTelemetry or a cloud SDK, create spans, or ship logs to a backend.
Destinations and transports remain explicit application configuration.

This is an independently maintained package, not official Fastify middleware.

## Requirements and installation

- Node.js 24 or newer
- Fastify 5.10.0 or newer within the Fastify 5 line
- ESM

```bash
pnpm add fastify@^5.10.0 fastify-observability
```

`pino` is a direct package dependency; applications do not need to install a
second logger.

## Complete setup

```ts
import Fastify, { LogController } from "fastify";
import fastifyObservability, {
  createObservabilityLogger,
  createRequestIdGenerator,
} from "fastify-observability";

const logger = createObservabilityLogger({
  // Intentionally keeps the bare W3C trace ID for GCP correlation.
  // It never prepends projects/{project}/traces/ to that value.
  preset: "gcp",
  level: process.env.NODE_ENV === "development" ? "debug" : "info",
});

const app = Fastify({
  loggerInstance: logger,
  requestIdHeader: false,
  genReqId: createRequestIdGenerator(),
  logController: new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: "request_id",
  }),
});

await app.register(fastifyObservability);
```

Register the plugin once at the root, before application plugins and routes.
The Fastify logger and request-logging settings above are required by the
supported integration:

- `loggerInstance` uses the package-created Pino instance and its controlled
  record envelope.
- `requestIdHeader: false` prevents Fastify from accepting an unvalidated
  caller value before `genReqId` runs.
- `createRequestIdGenerator()` establishes the validated ID before Fastify
  creates `request.log`.
- `requestIdLogLabel: "request_id"` prevents competing `reqId` and
  `request_id` bindings.
- `disableRequestLogging: true` removes Fastify's separate incoming and
  completed lines; this package emits one terminal access record.

Pino is the only supported logger, and it must come from
`createObservabilityLogger()`. Fastify `logger: true`, Fastify logger options,
an independently created Pino instance, a Fastify-compatible custom logger,
`logger: false`, and an omitted logger are rejected. This deliberately narrows
Fastify's broader [logging API](https://fastify.dev/docs/latest/Reference/Logging/)
to one configuration the package can verify.

The returned value is still a normal Pino logger, including
[Pino's public `bindings()` method](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#loggerbindings).
Use `app.log`, `request.log`, and `reply.log` for application records; no wrapper
logging API is introduced.

Applications that prefer shorter local helpers can wrap those Fastify loggers
without introducing another backend or global logger. The copyable
[`examples/local_wrapper/applog.ts`](examples/local_wrapper/applog.ts) helper
accepts `request.log` explicitly, so request and trace bindings are preserved.

## Logger configuration

`createObservabilityLogger()` accepts only options that preserve the package
record contract.

| Logger option | Default | Purpose |
| --- | --- | --- |
| `preset` | `"default"` | `default`, `gcp`, `aws`, or `azure` field shape |
| `level` | `"info"` | Standard Pino threshold, including `silent` |
| `base` | Pino default | Stable application bindings such as service metadata |
| `redact` | None | Pino redaction for application-owned paths |
| `serializers` | Pino defaults | Serializers for application-owned fields |
| `transport` | None | Pino transport configuration |
| `destination` | Pino stdout | Explicit Pino destination stream; mutually exclusive with `transport` |

The factory owns `messageKey`, level formatting, `onChild`, child binding
guards, and the absence of `mixin`, `nestedKey`, log formatters, and log-method
hooks. The message key is always `message`. The GCP preset maps Pino levels to
Cloud Logging severities (`warn` becomes `WARNING`; `fatal` becomes
`CRITICAL`); the other presets retain Pino's numeric `level`.

Package and envelope names cannot appear in `base`. Redaction and custom
serializers cannot target package fields; this includes direct, bracket, quoted
bracket, and root-wildcard redaction paths such as `[*]`. `err` retains
Pino/Fastify's standard serializer contract. `setBindings()` is blocked. A
child can add a new binding, but it cannot repeat a parent binding, bind Pino's
hidden `pid` or `hostname` base names, or bind an envelope/reserved Pino option
name.

Preset selection belongs only to the logger factory. It is not repeated in
plugin options, so the logger envelope and provider fields cannot drift apart.

## Plugin options and request IDs

| Plugin option | Default | Purpose |
| --- | --- | --- |
| `requestIdHeader` | `"x-request-id"` | Validated incoming request-ID header |
| `responseHeader` | Request-ID header | Response request-ID header, or `false` |
| `traceHeader` | `"traceparent"` | W3C trace context header |
| `tracestateHeader` | `"tracestate"` | W3C vendor trace state header |
| `message` | `"request completed"` | Terminal access-record message |
| `levelForStatus` | Built-in mapping | Synchronous status-to-level override |
| `extraFields` | None | Synchronous application fields for the access record |

Unknown options are rejected instead of being silently ignored.

`createRequestIdGenerator()` accepts `requestIdHeader`, `generate`, and
`validateIncoming`. `validateIncoming` narrows only caller-provided IDs; it does
not reject an application generator's output or the package fallback. Every ID,
regardless of source, must still pass the package baseline: 1–128 ASCII
URI-unreserved characters (`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, or `~`).

Missing, empty, duplicate, oversized, non-ASCII, or invalid incoming values are
replaced. A custom generator is tried twice and then failure-contained with a
package fallback. When a custom request-ID header is used, pass the same name to
the generator and plugin.

`isValidRequestId(value)` exposes the baseline check. `parseTraceparent(value)`
exposes strict W3C parsing.

## Request context

The immutable context is available throughout Fastify's request lifecycle:

```ts
request.observability.requestId;
request.observability.correlationId; // trace ID, otherwise request ID
request.observability.traceContext;  // validated TraceContext | null
```

The selected request ID is also `request.id`, the `request_id` Pino binding,
and the configured response header.

`traceparent` parsing rejects uppercase hex, zero IDs, duplicates, malformed
delimiters, invalid version framing, and oversized input. Valid `tracestate`
retains wire order while enforcing W3C key grammar, unique keys, 32 members, and
512 bytes. Invalid trace input is ignored and correlation falls back to the
request ID.

The incoming parent ID identifies the caller's span. The package does not claim
that it is a span created by this service and does not emit a fake current-span
field.

## Terminal access record

Normal, handled-error, and unhandled-error responses produce one terminal
record in `onResponse`, using the final status sent on the wire. Timeouts,
request aborts, response aborts, and observable response-stream failures share
the same one-shot terminal guard.

| Field | Meaning |
| --- | --- |
| `method` | HTTP method |
| `path` | Concrete escaped path without a query string |
| `path_template` | Matched Fastify route template; omitted for a normal 404 |
| `operation_id` | Explicit `schema.operationId` only |
| `status` | Final status when trustworthy |
| `duration_ms` | Non-negative monotonic duration including streaming |
| `remote_ip` | `request.ip`, honoring the application's `trustProxy` policy |
| `user_agent` | One unambiguous raw User-Agent value |
| `terminal_reason` | `timeout`, `request_aborted`, or `response_aborted` |
| `err` | Observed `Error`, through Pino's error serializer |
| `httpRequest` | GCP HTTP request object, on the GCP preset only |

Queries, bodies, cookies, authorization, and arbitrary headers are never
logged. Use `path_template` for low-cardinality aggregation; concrete `path`
remains high-cardinality diagnostic data.

Default levels are `error` for 5xx, `warn` for 4xx, and `info` otherwise.
Timeouts and observed internal stream failures use `error`; connection aborts
without an exposed error use `warn`. `levelForStatus` can return the public
`AccessLogLevel` union: `debug | info | warn | error`. Pino must also enable the
selected level.

`extraFields(request, reply)` must synchronously return a plain or
null-prototype record of application fields. Reserved package, Pino, provider,
request/response, error, prototype, and diagnostic names are ignored. Async or
otherwise invalid returns and callback failures produce one diagnostic and
never alter the HTTP response.

## Duplicate-field guarantee

Pino pre-serializes child bindings. If a parent and child reuse a name, the raw
line contains duplicate JSON names even though `bindings()` and `JSON.parse()`
show only the final value. Pino documents this
[duplicate-key behavior](https://github.com/pinojs/pino/blob/v10.3.1/docs/child-loggers.md#duplicate-keys-caveat).
The public `bindings()` method is necessary for inspection, but it is not
sufficient proof by itself.

For package terminal records, the supported configuration guarantees one
top-level occurrence of every package, provider, envelope, access, base, and
extra field:

1. The factory rejects protected root bindings and uncontrolled envelope
   options.
2. Every package-created Pino child is marked and guarded; repeated child
   bindings and `setBindings()` are blocked.
3. The plugin inspects Pino's public `bindings()` snapshot at the Fastify root,
   request child, package correlation child, and immediately before emission.
4. The Fastify request child must be exactly the root bindings plus the
   canonical `request_id`; custom request-child shapes are rejected for package
   access logging.
5. An application extra field equal to a stable root binding is reused; a
   conflicting extra field is omitted with one diagnostic.
6. Tests inspect the raw JSON line before parsing it.

This guarantee covers records emitted by this package. Application log calls
must not pass a key already bound on `request.log`; Pino itself permits that and
will serialize both names. Replacing or mutating the logger, bypassing its
guarded methods through Pino internals, custom or route-specific
`childLoggerFactory` behavior, and downstream transports that rewrite records
are outside the contract. The exact default Fastify child logger shape is the
supported path.

## Cloud presets

Set `preset` in `createObservabilityLogger()`.

- `gcp` emits `severity`, `message`, structured `httpRequest`,
  `logging.googleapis.com/trace`, and
  `logging.googleapis.com/trace_sampled`. The trace field intentionally remains
  the bare 32-character trace ID from the validated W3C `traceparent`. The
  preset does not prepend `projects/{project}/traces/`. It also omits
  `logging.googleapis.com/spanId`, because the incoming parent ID is not a
  current span created by this package. This matches Cloud Trace's current
  [preferred trace field format](https://docs.cloud.google.com/trace/docs/trace-log-integration).
- `aws` adds flat `xray_trace_id` in `1-8hex-24hex` form. It does not create an
  X-Ray segment or parse legacy X-Ray headers.
- `azure` adds flat `operation_Id` and `operation_ParentId`. It does not start
  Application Insights telemetry or parse legacy request headers.
- `default` emits provider-neutral request and W3C correlation fields.

Provider fields correlate logs only. No provider SDK is initialized and no span
is created. See [EXAMPLES.md](EXAMPLES.md) for focused setup modules.

## Diagnostics and failure boundaries

Internal diagnostics go through the canonical root Pino logger at `warn` with
an `observability_diagnostic` code and the normal `message` key. Each diagnostic
kind is emitted at most once per plugin instance. `stderr` is used only if Pino
throws synchronously while writing the diagnostic. A `silent` or higher logger
threshold filters diagnostics normally.

Logger inspection, application callbacks, remote-IP resolution, stream
observation, and access emission are failure-contained after Fastify has created
the request. Unsafe constructor wiring and failures before Fastify enters the
request lifecycle can still fail startup or the request.

Node parser failures before Fastify creates a request, WebSocket messages,
hijacked/raw responses, and manually managed upgrades are outside the runtime
guarantee. Fastify documents client-abort detection as not completely reliable;
the package also observes the raw response close signal for supported HTTP
paths.

## Troubleshooting

| Symptom | Cause | Correction |
| --- | --- | --- |
| Logger rejected at startup | Fastify is not using the exact package-created logger | Pass `createObservabilityLogger()` as `loggerInstance` |
| Setup error on the first request | Fastify did not use the package request-ID generator, or header names differ | Keep `requestIdHeader: false`; use matching generator and plugin header names |
| `request_id` diagnostic and no access record | Fastify's default `reqId` label is active | Set `requestIdLogLabel: "request_id"` in `LogController` |
| Extra incoming/completed lines | Fastify request logging is enabled | Set `disableRequestLogging: true` |
| Root binding rejected | `base` reuses an envelope or package field | Rename or remove that base binding |
| No access record | Pino filtered its level or logger integrity changed | Enable the level and keep the default guarded child path |
| Routes lack correlation | Plugin registered after routes or in a narrower scope | Register once at root before application plugins and routes |
| Duplicate generic error details | An application error handler logs the same error captured by the terminal record | Remove generic error logging; retain domain diagnostics only when they add distinct context |

Fastify does not expose active `LogController` settings through public getters,
so the plugin cannot prove at startup that request logging is disabled or that
the request-ID label is canonical. A legacy label is detected on the request,
traffic is preserved, and the ambiguous package access record is omitted.

## Compatibility and development

The package is ESM-only, supports Node 24 or newer and Fastify `^5.10.0`, and
follows semantic versioning. During `0.x`, option behavior and structured-field
changes are called out in [CHANGELOG.md](CHANGELOG.md). Deep imports are
unsupported.

Development requires [pnpm 11.13.0](https://pnpm.io/installation), pinned by
the `packageManager` field, and [just](https://github.com/casey/just). With both
installed, use the repository's grouped commands:

```bash
just install
just qa
```

The [`Justfile`](Justfile) groups the common test, QA, package, and lifecycle
commands. `just qa` removes `dist/` before running the same `pnpm qa` gate used
for releases, preventing deleted or renamed modules from surviving a local
rebuild. `just clean` removes generated outputs but preserves installed
dependencies; use `just fresh` for a clean dependency installation. The pnpm
scripts remain available directly for CI and environments without `just`.

The complete gate covers formatting/lint, strict TypeScript, unit and real
HTTP/1.1/HTTP/2 behavior, raw log-line assertions, 90% global coverage
thresholds, and build output. `just package-check` additionally creates the
exact npm tarball, verifies its file set, installs it with the minimum supported
Fastify version in an isolated consumer, typechecks its declarations, and runs
a real request through the installed package.

Releases use GitHub OIDC and npm trusted publishing without a stored npm write
token. See [RELEASE.md](RELEASE.md).

## References

- [Fastify logging](https://fastify.dev/docs/latest/Reference/Logging/) documents
  Pino integration, `loggerInstance`, request logging, serializers, redaction,
  and the unvalidated `requestIdHeader` behavior narrowed by this package.
- [Fastify server options](https://fastify.dev/docs/latest/Reference/Server/)
  document `LogController`, `disableRequestLogging`, `requestIdLogLabel`,
  `requestIdHeader`, and `genReqId`.
- [Fastify request](https://fastify.dev/docs/latest/Reference/Request/) documents
  `request.id`, `request.log`, and proxy-aware `request.ip`.
- [Pino `bindings()`](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#loggerbindings),
  the [child-logger duplicate-key caveat](https://github.com/pinojs/pino/blob/v10.3.1/docs/child-loggers.md#duplicate-keys-caveat),
  and [redaction](https://github.com/pinojs/pino/blob/v10.3.1/docs/redaction.md)
  define the logger behavior guarded by the package.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) defines strict
  `traceparent` and `tracestate` syntax and identifies `parent-id` as the
  caller's span rather than a span created by this service.
- [Google Cloud trace and log integration](https://docs.cloud.google.com/trace/docs/trace-log-integration)
  documents the bare `TRACE_ID` as the preferred trace field format.
- [Google Cloud Trace release notes](https://docs.cloud.google.com/trace/docs/release-notes)
  record the January 26, 2026 change that made the trace ID preferred while
  retaining the full project resource name as a supported legacy format.
- [Google Cloud structured logging](https://docs.cloud.google.com/logging/docs/structured-logging)
  documents `severity`, `message`, `httpRequest`, and the special
  `logging.googleapis.com/*` JSON fields.
- [AWS X-Ray trace IDs](https://docs.aws.amazon.com/xray/latest/devguide/xray-api-sendingdata.html)
  document converting a W3C trace ID to `1-8hex-24hex` form.
- [Azure Application Insights data model](https://learn.microsoft.com/en-us/azure/azure-monitor/app/data-model-complete)
  documents `operation_Id` and `operation_ParentId` correlation fields.

## License

MIT
