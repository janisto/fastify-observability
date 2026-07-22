# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-07-22

Version 2 intentionally removes v1 compatibility-only options rather than
preserving shims.

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
  `response_aborted` to `client_disconnect`, `body_error`, and
  `response_dropped`; timeouts remain `timeout`, and normal responses no longer
  need a terminal reason.
- Treat abnormal terminal records as `error`, opt into native `err` details
  only when their privacy impact is acceptable, and update route dimensions to
  the canonical `{name}` and `{*path}` template syntax.

### Added

- Added independent `capturePath`, `capturePeerIp`, `captureUserAgent`, and
  `captureError` opt-ins plus an injectable monotonic `clock`.
- Added explicit W3C Trace Context Level 2 configuration, including its
  `tracestate` key grammar and `trace_id_random` projection. Level 1 remains the
  default.
- Added a conditional consumer-image build as a packaging and integration
  diagnostic, with Podman-first local builds and Docker fallback. Optional
  independent audits are informational and never a publication requirement.

### Changed

- Defined LF-terminated NDJSON as the package logging boundary.
- Disabled concrete path, direct peer IP, and User-Agent capture by default;
  renamed the opt-in portable peer field from `remote_ip` to `peer_ip`, and
  made matching GCP request members conditional on those opt-ins. Direct peer
  IP literals are canonicalized or omitted.
- Canonicalized retained `tracestate` field-lines while preserving raw wire
  order and valid empty members, without treating 512 characters as a maximum.
- Treated dash-delimited future-version `traceparent` suffixes as opaque while
  retaining strict validation of the common 55-character prefix.
- Standardized observable terminal reasons as `client_disconnect`,
  `body_error`, `response_dropped`, and `timeout`, and made every abnormal
  access record use `error` while retaining the one-shot lifecycle guard.
- Canonicalized Fastify `:name` and `*` route metadata to portable
  `{name}` and `{*path}` templates while preserving richer authoritative
  Fastify optional/composite syntax and repeated escaped literal colons.

### Removed

- Removed v1 compatibility shims from the plugin options; unknown legacy
  options now fail construction like every other unsupported key.

### Fixed

- Prevented plain application log fields from overriding or duplicating exact
  envelope, correlation, and provider fields owned by the active preset. Exact
  aliases owned only by an inactive preset remain application data. Access
  enrichment separately protects its exact terminal fields without reserving
  unrelated names or prefixes.
- Invoked configured request-ID generators once before package-owned fallback,
  avoiding duplicate application callback side effects.
- Classified ambiguous unfinished response closes as `response_dropped`, and
  observed only the response stream Fastify actually pipes after all `onSend`
  transformations, so discarded payload failures cannot contaminate terminal
  records.
- Emitted GCP `httpRequest.latency` with canonical ProtoJSON precision across
  the complete representable range, omitting only an unrepresentable
  projection.
- Applied the RFC 9110 field-content boundary before custom request-ID validation,
  admitting internal space, tab, or a comma in one field-line; direct synthetic
  edge-whitespace values remain a native safety check after real HTTP parsing.
- Preserved custom-admitted request IDs, HTAB User-Agent values, and nonempty
  static operation IDs at their native framework boundaries.
- Preserved nonempty query-free paths from Node's raw request target, including
  malformed percent triplets and the `*` target, without a second adapter
  parser.
- Retained an authoritative committed response status when a timeout terminates
  the body.
- Preserved sampling while omitting the Level 2 random flag for unknown future
  `traceparent` versions.
- Retained canonical `path_template` output for valid whole-segment constraints
  containing nested or noncapturing regular-expression groups.

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

[Unreleased]: https://github.com/janisto/fastify-observability/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/janisto/fastify-observability/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/janisto/fastify-observability/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/janisto/fastify-observability/compare/v0.2.1...v1.0.0
[0.2.1]: https://github.com/janisto/fastify-observability/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/janisto/fastify-observability/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/janisto/fastify-observability/releases/tag/v0.1.0
