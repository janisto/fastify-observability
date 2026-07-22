# E2E consumer

This is a minimal packaged Fastify consumer used by the central observability
repository. It builds the package tarball from this checkout, refreshes the
local archive entry in the E2E dependency plan, and then performs frozen
development and production installs. It selects one of the five explicit
configurations through `OBS_E2E_CASE` and exposes `GET /trace` on
`0.0.0.0:$PORT`.

Build it with a central-supplied tag:

```sh
just e2e-image observability-e2e-local:ci
```

This repository does not evaluate or publish cross-repository parity.
