# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The changes in this section target `2.0.0` and must not be published on the
`1.x` release line.

### Migration from 1.x

- Remove the v1 terminal `message` option. Version 2 always emits
  `"request completed"`; move application-specific text to separate
  application log events.
- Provide `traceContextLevel` on every manually constructed `TraceContext`;
  version 2 rejects the v1 shape that omitted it instead of assuming Level 1.
- Enable `capturePath`, `capturePeerIp`, `captureUserAgent`, and `captureError`
  explicitly where the corresponding data is still required. These fields are
  privacy-sensitive and are disabled by default.
- Rename consumers of `remote_ip` to `peer_ip`. The new field uses only the
  direct socket peer and does not trust proxy-derived addresses.
- Update abnormal-outcome queries from `request_aborted` and
  `response_aborted` to `client_disconnect` and `body_error`; timeouts remain
  `timeout`, and normal responses no longer need a terminal reason.
- Treat abnormal terminal records as `ERROR`, opt into native `err` details
  only when their privacy impact is acceptable, and update route dimensions to
  the canonical `{name}` and `{*path}` template syntax.

### Added

- Added exact current `0.1.0` profiles for GCP, AWS, and Azure, exact pinning
  through their provider-specific options, and safe effective-profile
  introspection through `getObservabilityLoggerProfile()`.
- Added independent `capturePath`, `capturePeerIp`, and `captureUserAgent`
  opt-ins plus an injectable monotonic `clock` for deterministic tests.
- Added explicit W3C Trace Context Level 2 configuration, including its
  `tracestate` key grammar and `trace_id_random` projection. Level 1 remains the
  default.

### Changed

- Expanded the provider-neutral basic example with the Level 1 default, an
  explicit Level 2 application factory, and behavioral output tests.
- Removed v1 compatibility shims from the plugin options; unknown legacy
  options now fail construction like every other unsupported key.
- Set package metadata to `2.0.0` so local package validation cannot produce a
  breaking artifact mislabeled for the v1 release line.
- Documented LF-terminated NDJSON as the logging boundary and added raw-writer
  regression coverage for independently parseable records.

- Preserve a nonempty query-free path from Node's raw request target, including
  malformed percent triplets that reached Fastify and the `*` target, without a
  second adapter parser; canonicalize direct peer IP literals; and distinguish
  response-stream failures from unrelated handler errors.
- Disabled concrete path, direct peer IP, and User-Agent capture by default;
  renamed the opt-in portable peer field from `remote_ip` to `peer_ip`, and
  made the matching GCP request members conditional on those opt-ins.
- Aligned the GCP health integration fixture with service version `1.0.0`,
  operation ID `health_check`, and deterministic `12.5` ms output.
- Canonicalized retained `tracestate` field-lines while preserving raw wire
  order and valid empty members, without treating 512 characters as a maximum.
- Treated dash-delimited future-version `traceparent` suffixes as opaque while
  retaining strict validation of the common 55-character prefix.
- Standardized observable terminal reasons as `client_disconnect`,
  `body_error`, and `timeout`, and made every abnormal access record use
  `error` while retaining the one-shot lifecycle guard.
- **Breaking:** Canonicalized Fastify `:name` and `*` route metadata to portable
  `{name}` and `{*path}` templates while preserving richer authoritative
  Fastify optional/composite syntax and repeated escaped literal colons.

### Fixed

- Prevented plain application log fields from overriding or duplicating exact
  envelope, correlation, and selected-profile provider fields. Exact aliases
  owned only by an inactive profile remain application data. Access enrichment
  separately protects its exact terminal fields without reserving unrelated
  names or prefixes.
- Invoke configured request-ID generators once before package-owned fallback,
  avoiding duplicate application callback side effects.
- Classify ambiguous unfinished response closes as `response_dropped`, and
  observe the final route payload after later `onSend` transformations.
- Emit GCP `httpRequest.latency` with canonical ProtoJSON fractional widths:
  0, 3, 6, or 9 digits according to the required precision.
- Apply the RFC 9110 field-content boundary before custom request-ID validation,
  admitting internal space, tab, or a comma in one field-line; direct synthetic
  edge-whitespace values remain a native safety check after real HTTP parsing.
- Preserve framework-valid native route forms, HTTP-safe opaque future
  `traceparent` suffixes without an invented length cap, custom-admitted native
  request IDs, HTAB User-Agent values, and nonempty static operation IDs.
- Preserve portable duration at the GCP protobuf boundary, format the complete
  representable range without precision loss, and omit only an unrepresentable
  GCP latency projection.

- Retained an authoritative committed response status when a timeout terminates
  the body.
- Preserved sampling while omitting the Level 2 random flag for unknown future
  `traceparent` versions.
- Retained canonical `path_template` output for valid whole-segment Fastify
  constraints containing nested or noncapturing regular-expression groups.

## [1.0.1] - 2026-07-17

### Added

- Added a tested GCP health-route use case showing developer `INFO` and `DEBUG`
  records alongside one terminal request record on the logger's stdout-style
  destination.

## [1.0.0] - 2026-07-16

### Added

- Added npm version, CI, Node.js support, and license status badges to the
  README.

### Changed

- Promoted the existing documented logger, plugin, request-context, structured
  field, default, and runtime-support contracts to a stable 1.0 public API.
  This release requires no migration from `0.2.1`.
- Expanded the README with package motivation, explicit scope boundaries, and
  the planned mutation-testing status.

## [0.2.1] - 2026-07-15

### Fixed

- Removed setup-node's token-oriented npm registry configuration from trusted
  publishing, eliminating the unused `${NODE_AUTH_TOKEN}` placeholder while
  retaining registry selection through `package.json#publishConfig`.

## [0.2.0] - 2026-07-15

### Added

- Opinionated Pino logger and Fastify 5 plugin for structured application and
  request logging.
- Validated request-ID generation integrated with Fastify's request lifecycle.
- Strict W3C `traceparent` and `tracestate` correlation with immutable,
  request-scoped observability metadata.
- One structured terminal access record containing request, route, response,
  timing, client, error, and correlation fields.
- Default, Google Cloud, AWS, and Azure logging presets, including Google
  Cloud's bare trace-ID correlation format.
- Full-fidelity logging by default with explicit logger levels, base bindings,
  serializers, root redaction, destinations, and transports.
- Public TypeScript APIs for the guarded logger, plugin options, request
  context, request-ID generation, and trace-context parsing.
- ESM package for Node.js 24 and Fastify 5.

## [0.1.0] - 2026-07-14

### Added

- Bootstrap release establishing the package on npm with metadata only and no
  runtime API.

[Unreleased]: https://github.com/janisto/fastify-observability/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/janisto/fastify-observability/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/janisto/fastify-observability/compare/v0.2.1...v1.0.0
[0.2.1]: https://github.com/janisto/fastify-observability/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/janisto/fastify-observability/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/janisto/fastify-observability/releases/tag/v0.1.0
