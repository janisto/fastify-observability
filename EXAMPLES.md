# Examples

The four provider examples contain only the Fastify configuration required by
this package. They intentionally define no routes, handlers, listeners, test
hooks, or shared helpers. Copy the relevant setup into the application before
registering its plugins and routes.

| Example | Purpose |
| --- | --- |
| [`examples/gcp/app.ts`](examples/gcp/app.ts) | Canonical Google Cloud `severity`, trace aliases, and `httpRequest` shape |
| [`examples/basic/app.ts`](examples/basic/app.ts) | Provider-neutral Pino fields |
| [`examples/aws/app.ts`](examples/aws/app.ts) | Flat derived X-Ray trace correlation without an AWS SDK |
| [`examples/azure/app.ts`](examples/azure/app.ts) | Flat Azure operation correlation without an Azure SDK |
| [`examples/local_wrapper/app.ts`](examples/local_wrapper/app.ts) | GCP setup using optional explicit-logger application helpers |

The setup modules export `app` only so an application can add its own plugins,
routes, and startup policy. TypeScript checks every example as part of
`pnpm typecheck`.

The local wrapper application registers this package, then passes its enriched
`request.log` to an application-local helper. The helper accepts a
`FastifyBaseLogger` explicitly, preserving request and trace bindings:

```ts
import * as applog from "../local_wrapper/applog.js";

applog.info(request.log, "loading item", { item_id: "42" });
applog.error(request.log, "item load failed", error, { item_id: "42" });
```

It provides `debug`, `info`, `warn`, `error`, and arbitrary supported-level
helpers without global state or ambient request context.
