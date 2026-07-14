# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 - Unreleased

### Added

- Validated request-ID generation integrated with Fastify's `genReqId` lifecycle.
- Strict W3C `traceparent` and `tracestate` correlation.
- Immutable request observability metadata and request-scoped Pino fields.
- One structured terminal access record with default, GCP, AWS, and Azure presets.
- Node 24, Fastify 5, ESM-only TypeScript package and pnpm release gates.
