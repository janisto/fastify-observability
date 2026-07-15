# Changelog

All notable changes to this project will be documented in this file.

## 0.2.0 - Unreleased

### Added

- Validated request-ID generation integrated with Fastify's `genReqId` lifecycle.
- Strict W3C `traceparent` and `tracestate` correlation.
- Immutable request observability metadata and request-scoped Pino fields.
- One structured terminal access record with default, GCP, AWS, and Azure presets.
- `createObservabilityLogger()` as the only supported logger construction path,
  with a fixed `message` key, canonical GCP `severity`, guarded children, and a
  narrow Pino option surface.
- Pino-only logging contract using public binding inspection; independently
  created Pino instances, custom logger adapters, and disabled logging are
  rejected.
- Node 24, Fastify 5, ESM-only TypeScript package and pnpm release gates.

### Fixed

- Reject package-owned Pino root bindings, repeated child bindings,
  `setBindings()`, protected redaction and serializer paths, and uncontrolled
  Pino envelope options, including hidden `pid` and `hostname` collisions and
  custom replacements for the standard `err` serializer. Protected redaction
  checks include Pino's direct, bracket, quoted-bracket, and root-wildcard path
  forms.
- Normalize Fastify's internal standard error serializer to the package-owned
  Pino implementation, preserving valid Fastify installations that resolve a
  separate compatible Pino copy without allowing custom `err` serializers.
- Require Fastify's exact default request-child shape, verify the actual
  correlation child, recheck every binding before terminal emission, and
  suppress only the package access record when integrity cannot be proven.
- Reuse structurally equal stable base fields returned by `extraFields` and
  omit conflicting extra values with one diagnostic.
- Diagnose async and other non-record `extraFields` results instead of silently
  treating them as empty access metadata.
- Route internal diagnostics through the canonical Pino logger with a structured
  `observability_diagnostic` code, retaining `stderr` only as a synchronous
  logger-failure fallback.
- Clarify custom request-ID validation as `validateIncoming`; generated and
  fallback IDs are always checked by the package baseline instead.
- Preserve the GCP preset's bare W3C trace ID without adding a project resource
  prefix or treating the incoming parent ID as a current span.
- Map Pino `warn` and `fatal` to Cloud Logging's standard `WARNING` and
  `CRITICAL` severities.
- Preserve HTTP responses when Fastify remote-IP resolution fails, omitting
  only `remote_ip` from the access record.

## 0.1.0 - 2026-07-14

### Added

- Bootstrap release establishing the package on npm with metadata only and no
  runtime API.
