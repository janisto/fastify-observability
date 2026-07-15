# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/janisto/fastify-observability/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/janisto/fastify-observability/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/janisto/fastify-observability/releases/tag/v0.1.0
