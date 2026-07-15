# Examples

The four provider examples contain only the Fastify configuration required by
this package. They intentionally define no routes, handlers, listeners, test
hooks, or shared helpers. Copy the relevant setup into the application before
registering its plugins and routes.

| Example | Purpose |
| --- | --- |
| [`examples/gcp/app.ts`](examples/gcp/app.ts) | Canonical Google Cloud `severity`, bare W3C trace ID, and `httpRequest` shape |
| [`examples/basic/app.ts`](examples/basic/app.ts) | Provider-neutral Pino fields |
| [`examples/aws/app.ts`](examples/aws/app.ts) | Flat derived X-Ray trace correlation without an AWS SDK |
| [`examples/azure/app.ts`](examples/azure/app.ts) | Flat Azure operation correlation without an Azure SDK |
| [`examples/local_wrapper/applog.ts`](examples/local_wrapper/applog.ts) | Optional application-local logging helpers |

The setup modules export `app` only so an application can add its own plugins,
routes, and startup policy. TypeScript checks every example as part of
`pnpm typecheck`.

The examples use the full-fidelity default: no fields are redacted. Applications
that require a privacy policy configure `redact` once in
`createObservabilityLogger()`; package-created children inherit that policy and
cannot replace it.

Provider selection is configured once in `createObservabilityLogger()`. The
plugin derives it from that logger. In the GCP example,
`logging.googleapis.com/trace` intentionally remains the bare trace ID from the
validated W3C `traceparent`; no project resource prefix is added.

The optional local wrapper contains only small application helpers; it does not
duplicate Fastify or plugin setup. Pass the enriched `request.log` explicitly
to preserve request and trace bindings without global state or ambient request
context:

```ts
import * as applog from "./applog.js";

applog.info(request.log, "loading item", { item_id: "42" });
applog.error(request.log, "item load failed", error, { item_id: "42" });
```

The helper provides `debug`, `info`, `warn`, `error`, and `log` for any standard
Pino level. It is application convenience, not package configuration or a
second logger abstraction.
