# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added specification-defined GCP profile `0.1.0`, newest-installed resolution,
  exact pinning through `gcpProfileVersion`, and safe effective-profile
  introspection through `getObservabilityLoggerProfile()`.
- Added independent `capturePath`, `capturePeerIp`, and `captureUserAgent`
  opt-ins plus an injectable monotonic `clock` for deterministic tests.
- Added explicit W3C Trace Context Level 2 configuration, including its
  `tracestate` key grammar and `trace_id_random` projection. Level 1 remains the
  default.

### Changed

- Omit unavailable, malformed, and non-origin-form request paths; canonicalize
  direct peer IP literals; and distinguish response-stream failures from
  unrelated handler errors when classifying disconnects.
- Disabled concrete path, direct peer IP, and User-Agent capture by default;
  renamed the opt-in portable peer field from `remote_ip` to `peer_ip`, and
  made the matching GCP request members conditional on those opt-ins.
- Aligned the GCP health integration fixture with service version `1.0.0`,
  operation ID `health_check`, and deterministic `12.5` ms output.
- Canonicalized retained `tracestate` field-lines while preserving raw wire
  order and valid empty members.
- Treated dash-delimited future-version `traceparent` suffixes as opaque while
  retaining strict validation of the common 55-character prefix.
- Standardized observable terminal reasons as `client_disconnect`,
  `body_error`, and `timeout`, and made every abnormal access record use
  `error` while retaining the one-shot lifecycle guard.
- **Breaking:** Canonicalized Fastify `:name` and `*` route metadata to portable
  `{name}` and `{*path}` templates; ambiguous optional/composite forms are
  omitted.

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
