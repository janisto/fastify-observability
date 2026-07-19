# fastify-observability

[![npm version](https://img.shields.io/npm/v/fastify-observability.svg)](https://www.npmjs.com/package/fastify-observability)
[![Node.js](https://img.shields.io/node/v/fastify-observability.svg)](#requirements-and-installation)
[![CI](https://img.shields.io/github/actions/workflow/status/janisto/fastify-observability/ci.yml?branch=main&label=CI)](https://github.com/janisto/fastify-observability/actions/workflows/ci.yml)
[![Socket Badge](https://badge.socket.dev/npm/package/fastify-observability)](https://socket.dev/npm/package/fastify-observability)

Opinionated Fastify 5 request logging: validated request IDs, strict W3C trace
correlation, request-scoped Pino fields, and exactly one structured terminal
access record.

## Why this package exists

Managed platforms such as Cloud Run already collect container output.
Applications should only need to write structured JSON to standard output
(`stdout`); the platform can handle ingestion and delivery.

Compared with sending logs through an in-process cloud logging client, this
reduces container CPU, memory, and network use by removing logging API calls,
authentication, buffering, batching, and retry work from the application. Under
sustained logging load, that reduction can provide a noticeable performance
improvement. It also avoids the dependency and maintenance cost of a cloud
logging SDK, including its configuration, credentials, and upgrades.

This package turns that simple pipeline into useful production observability.
It provides validated request IDs, strict W3C trace correlation,
request-scoped fields, and one structured terminal access record. Application
and access logs share the same correlation metadata, making all records from a
request easier to find, filter, and understand.

Cloud presets map the same logging contract to provider-oriented fields without
coupling application code to a cloud logging SDK. The package focuses on
structured logging and request correlation: it does not create spans, configure
OpenTelemetry, or ship logs to a backend.

## Package scope

The package creates the Pino logger used by Fastify. Destinations and transports
remain explicit application configuration.

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
  getObservabilityLoggerProfile,
} from "fastify-observability";

const logger = createObservabilityLogger({
  // Intentionally keeps the bare W3C trace ID for GCP correlation.
  // It never prepends projects/{project}/traces/ to that value.
  preset: "gcp",
  level: process.env.NODE_ENV === "development" ? "debug" : "info",
});

// The unpinned GCP preset resolves to the newest profile in this installed
// package. This is currently { preset: "gcp", gcpProfileVersion: "0.1.0" }.
getObservabilityLoggerProfile(logger);

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

The returned runtime is Pino and includes
[Pino's public `bindings()` method](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#loggerbindings).
Its public `ObservabilityLogger` type omits mutation points blocked by the
package, and guarded children retain that type. Use `app.log`, `request.log`,
and `reply.log` for application records; no wrapper logging API is introduced.

Applications that prefer shorter local helpers can wrap those Fastify loggers
without introducing another backend or global logger. The copyable
[`examples/local_wrapper/applog.ts`](https://github.com/janisto/fastify-observability/blob/main/examples/local_wrapper/applog.ts)
helper
accepts `request.log` explicitly, so request and trace bindings are preserved.

## Logger configuration

`createObservabilityLogger()` accepts only options that preserve the package
record contract.

| Logger option | Default | Purpose |
| --- | --- | --- |
| `preset` | `"default"` | `default`, `gcp`, `aws`, or `azure` field shape |
| `gcpProfileVersion` | Newest installed GCP profile | Exact supported GCP profile pin; currently `"0.1.0"` |
| `level` | `"info"` | Standard Pino threshold, including `silent` |
| `base` | Pino default | Stable application bindings such as service metadata |
| `redact` | None | Explicit root Pino redaction; no fields are redacted by default |
| `serializers` | Pino defaults | Serializers for application-owned fields; they must never throw |
| `transport` | None | Pino transport configuration; `gcp` excludes `transport.targets` |
| `destination` | Pino stdout | Explicit Pino destination stream; mutually exclusive with `transport` |

The factory owns `messageKey`, level formatting, `onChild`, child binding
guards, and the absence of `mixin`, `nestedKey`, log formatters, and log-method
hooks. The message key is always `message`. The GCP preset maps Pino levels to
Cloud Logging severities (`warn` becomes `WARNING`; `fatal` becomes
`CRITICAL`); the other presets retain Pino's numeric `level`.

Pino multi-target mode (`transport.targets`) routes records using the numeric
`level` field. The `gcp` preset intentionally replaces that field with
`severity`, so it rejects `transport.targets` at logger creation instead of
leaking Pino's internal configuration error. Use `transport.target` for one
destination or one custom target that performs its own fan-out. The `default`,
`aws`, and `azure` presets retain the numeric level and support
`transport.targets`. This follows Pino 10's
[level-formatter boundary](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#formatters-object).

No redaction is installed automatically. Rich terminal-error capture, request
path, direct peer IP, and User-Agent capture are independently disabled by
default and require plugin opt-ins. With `captureError: true`, the native `err`
field retains Pino's standard type, message, stack, cause text, and enumerable
error properties and can contain sensitive application data.

Redaction is explicit root policy. In addition to application-owned paths, it
may target the privacy-bearing package fields `path`, `peer_ip`, `user_agent`,
nested `err.*`, and nested `httpRequest.*`. Correlation, envelope, structural,
top-level `err`, and top-level `httpRequest` fields remain protected. Direct,
bracket, quoted-bracket, and wildcard path forms are validated consistently.
Package children inherit root redaction and cannot replace or clear it; Pino
[documents that a child redaction option would otherwise override its parent](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#optionsredact-array--object).

Package and envelope names cannot appear in `base`, and custom serializers
cannot target package fields. `err` retains Pino/Fastify's standard serializer
contract. `setBindings()` is blocked. A child can add a new binding, but it
cannot repeat a parent binding, bind Pino's hidden `pid` or `hostname` base
names, or bind an envelope/reserved Pino option name. Public child options are
runtime-guarded because Fastify's structural logger type requires Pino's full
child-options parameter; only standard `level` and application-owned
`serializers` are accepted.

Preset selection belongs only to the logger factory. It is not repeated in
plugin options, so the logger envelope and provider fields cannot drift apart.

## Plugin options and request IDs

| Plugin option | Default | Purpose |
| --- | --- | --- |
| `requestIdHeader` | `"x-request-id"` | Validated incoming request-ID header |
| `responseHeader` | Request-ID header | Response request-ID header, or `false` |
| `traceHeader` | `"traceparent"` | W3C trace context header |
| `tracestateHeader` | `"tracestate"` | W3C vendor trace state header |
| `traceContextLevel` | `1` | Pinned W3C grammar and flag semantics; `1` or explicit `2` |
| `message` | `"request completed"` | Compatibility option; any other value is rejected because the terminal message is fixed |
| `capturePath` | `false` | Include a valid query-free origin-form path and GCP `requestUrl`; omit unavailable or malformed targets |
| `capturePeerIp` | `false` | Include the canonical direct socket IP as `peer_ip` and GCP `remoteIp`; omit non-IP or zoned values |
| `captureUserAgent` | `false` | Include one unambiguous User-Agent and GCP `userAgent` |
| `captureError` | `false` | Include the native privacy-sensitive `err` field on abnormal terminal records |
| `clock` | `performance.now` | Monotonic millisecond clock; primarily for deterministic tests |
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

`isValidRequestId(value)` exposes the baseline check. `parseTraceparent(value,
level?)` exposes strict W3C parsing, and `resolveTraceContextLevel(value)`
returns the effective supported level or throws for any value other than `1`
or `2`.

## Request context

The immutable context is available throughout Fastify's request lifecycle:

```ts
request.observability.requestId;
request.observability.correlationId; // trace ID, otherwise request ID
request.observability.traceContext;  // validated TraceContext | null
```

The selected request ID is also `request.id`, the `request_id` Pino binding,
and the configured response header.

`traceparent` parsing defaults to the pinned W3C Trace Context Level 1
Recommendation and rejects uppercase hex, zero IDs, duplicates, malformed
delimiters, invalid version framing, and oversized input. A dash-delimited
future-version suffix is opaque. Valid `tracestate`
field-lines retain wire order and are canonicalized by removing HTTP optional
whitespace around members while enforcing the selected-level key grammar,
unique keys, 32 members, and 512 bytes. Empty members are valid and count
toward the limit. Invalid trace input is ignored and correlation falls back to
the request ID.

Level 2 is explicit and immutable after plugin registration:

```ts
await app.register(fastifyObservability, { traceContextLevel: 2 });
```

Both levels preserve `trace_flags` and derive `trace_sampled` from bit zero.
Level 2 additionally exposes `traceIdRandom` on the request trace context and
emits `trace_id_random` from bit one. Level 1 deliberately omits the random
field. The flag reports caller input; it does not prove that this application
generated a random trace ID.

The incoming parent ID identifies the caller's span. The package does not claim
that it is a span created by this service and does not emit a fake current-span
field.

## Terminal access record

Normal, handled-error, and unhandled-error responses produce one terminal
record in `onResponse`, using the final status sent on the wire. Authoritative
client disconnects, timeouts, and observable response-stream failures share the
same one-shot terminal guard.

| Field | Meaning |
| --- | --- |
| `method` | HTTP method |
| `path` | Opt-in concrete escaped path without a query string |
| `path_template` | Canonical matched template (`{name}` and `{*path}`); omitted for a normal 404 or an unsafe/ambiguous native form |
| `operation_id` | Explicit `schema.operationId` only |
| `status` | Final status when trustworthy |
| `duration_ms` | Non-negative monotonic duration including streaming |
| `peer_ip` | Opt-in direct socket peer; forwarded and proxy-derived values are ignored |
| `user_agent` | Opt-in single unambiguous raw User-Agent value |
| `terminal_reason` | `timeout`, `client_disconnect`, or `body_error` |
| `err` | Opt-in observed `Error` (`captureError: true`), including standard type, message, and stack |
| `httpRequest` | GCP HTTP request object, on the GCP preset only |

Queries, bodies, cookies, authorization, forwarded IPs, and arbitrary headers
are never logged. Use `path_template` for low-cardinality aggregation; opt-in
concrete `path` remains high-cardinality diagnostic data.

Fastify whole-segment `:name` parameters are emitted as `{name}` and its
unnamed `*` catch-all is emitted as `{*path}`. Regex constraints are removed
while the parameter name is retained. Optional or composite native segments
are omitted because they do not have one unambiguous portable template.

That is deliberate terminal-schema selection, not hidden redaction. Fields an
application explicitly passes to `app.log`, `request.log`, or `reply.log` are
serialized normally unless the application configured root redaction or a
serializer for that application-owned field.

There is no automatic redaction after `captureError` or another sensitive field
is explicitly enabled. Configure the root `redact` option for any opted-in data
that must be censored, including nested `err.*` and GCP `httpRequest.*` paths.

Default levels are `error` for 5xx, `warn` for 4xx, and `info` otherwise.
Every abnormal terminal reason uses `error`, including a disconnect without an
exposed `Error`. `levelForStatus` applies only to normal responses and can
return the public `AccessLogLevel` union: `debug | info | warn | error`. Pino
must also enable the selected level.

If none of the package access levels are enabled, the package performs no
status-level callback, binding inspection, field construction, or extra-field
callback. If some access levels are enabled but the selected level is filtered,
the selected level is resolved and enrichment is skipped.

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

For package terminal records, the supported configuration guarantees that
every emitted package, provider, envelope, access, base, and extra field has
exactly one top-level occurrence. Fields explicitly removed by root redaction
are absent rather than duplicated:

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
  Omitting `gcpProfileVersion` resolves once to the newest GCP profile supported
  by the installed package, currently `0.1.0`; exact pinning accepts `"0.1.0"`.
  Unsupported pins fail logger creation and resolution performs no network
  lookup.
- `aws` adds flat `xray_trace_id` in `1-8hex-24hex` form. It does not create an
  X-Ray segment or parse legacy X-Ray headers.
- `azure` adds flat `operation_Id` and `operation_ParentId`. It does not start
  Application Insights telemetry or parse legacy request headers.
- `default` emits provider-neutral request and W3C correlation fields.

Provider fields correlate logs only. No provider SDK is initialized and no span
is created. See
[EXAMPLES.md](https://github.com/janisto/fastify-observability/blob/main/EXAMPLES.md)
for focused setup modules.

## Diagnostics and failure boundaries

Internal diagnostics go through the canonical root Pino logger at `warn` with
an `observability_diagnostic` code and the normal `message` key. Each diagnostic
kind is emitted at most once per plugin instance. `stderr` is used only if Pino
throws synchronously while writing the diagnostic. A `silent` or higher logger
threshold filters diagnostics normally.

Logger inspection, the package's clock, `levelForStatus`, and `extraFields`
callbacks, direct-peer resolution, stream observation, and access emission are
failure-contained after Fastify has created the request. Unsafe constructor
wiring and failures before Fastify enters the request lifecycle can still fail
startup or the request.

Pino executes application serializers and functional redaction censors during
ordinary application log calls. Those callbacks are outside the package's
failure containment and must never throw;
[Fastify warns that a throwing serializer can terminate the Node.js process](https://fastify.dev/docs/latest/Reference/Logging/#serializers).

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
follows semantic versioning. Starting with `1.0.0`, exported APIs, option
behavior, structured fields, defaults, and supported runtime versions are
compatibility contracts. Breaking changes require a new major release and
migration guidance in [CHANGELOG.md](CHANGELOG.md). Deep imports are
unsupported.

Development requires [pnpm 11.13.0](https://pnpm.io/installation), pinned by
the `packageManager` field, and [just](https://github.com/casey/just). With both
installed, install the workflow linters on macOS and use the repository's
grouped commands:

```bash
brew install actionlint zizmor
```

```bash
just install
just qa
```

The repository
[`Justfile`](https://github.com/janisto/fastify-observability/blob/main/Justfile)
groups the common test, QA, package, and lifecycle commands. `just qa` removes
`dist/` before running the same `pnpm qa` gate used
for releases, preventing deleted or renamed modules from surviving a local
rebuild. `just clean` removes generated outputs but preserves installed
dependencies; use `just fresh` for a clean dependency installation. The pnpm
scripts remain available directly for CI and environments without `just`.

The complete gate covers formatting/lint, strict TypeScript, unit and real
HTTP/1.1/HTTP/2 behavior, raw log-line assertions, 90% global coverage
thresholds, build output, [actionlint](https://github.com/rhysd/actionlint), and
[zizmor](https://docs.zizmor.sh/). `just package-check` additionally creates the
exact npm tarball, verifies its file set, installs it with the minimum supported
Fastify version in an isolated consumer, typechecks its declarations, and runs
a real request through the installed package.

Releases use `pnpm stage publish`, GitHub OIDC, and npm trusted publishing
without a stored npm write token. See
[RELEASE.md](https://github.com/janisto/fastify-observability/blob/main/RELEASE.md).

## Planned mutation testing

Mutation testing with
[StrykerJS](https://github.com/stryker-mutator/stryker-js) is planned once
upstream [TypeScript 7 support](https://github.com/stryker-mutator/stryker-js/pull/6099)
is merged and included in a release. Until then, Stryker is intentionally not
installed and no `just mutation` recipe is provided. Add the dependencies,
configuration, and Justfile recipe together when support is available.

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
  [`isLevelEnabled()`](https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md#loggerislevelenabledlevel),
  the [child-logger duplicate-key caveat](https://github.com/pinojs/pino/blob/v10.3.1/docs/child-loggers.md#duplicate-keys-caveat),
  and [redaction](https://github.com/pinojs/pino/blob/v10.3.1/docs/redaction.md)
  define the logger behavior guarded by the package.
- [W3C Trace Context Level 1 Recommendation](https://www.w3.org/TR/2021/REC-trace-context-1-20211123/)
  defines the default `traceparent` and `tracestate` contract.
- [W3C Trace Context Level 2 Candidate Recommendation Draft](https://www.w3.org/TR/2024/CRD-trace-context-2-20240328/)
  defines the explicit Level 2 key grammar and random trace-ID flag.
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
