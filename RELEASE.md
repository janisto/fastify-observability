# Release architecture and maintainer guide

This project publishes to npm without storing an npm write token in GitHub.
GitHub Actions authenticates to npm through OpenID Connect (OIDC), stages the
package, and leaves the final publication decision to a human maintainer using
two-factor authentication (2FA).

This document describes the public release architecture and the steps a
maintainer follows. It intentionally contains no credentials, one-time
passwords, recovery codes, session data, or secret values.

## Architecture

```mermaid
flowchart LR
    A[Reviewed change merged to main] --> B[Publish GitHub Release vX.Y.Z]
    B --> C[GitHub Actions release workflow]
    C --> D[GitHub Environment npm]
    D -->|Short-lived OIDC identity| E[npm staged package]
    E --> F[Maintainer inspection]
    F -->|2FA approval| G[Public npm release with provenance]
```

The release boundary has five parts:

1. **GitHub Release:** Publishing a GitHub Release triggers the workflow. A
   standalone tag push does not publish anything.
2. **GitHub Environment:** The workflow job uses Environment `npm`, restricted
   to selected `v*` tags. The Environment contains no npm credential.
3. **GitHub OIDC:** The job receives `id-token: write` permission and requests a
   short-lived identity for this workflow run.
4. **npm trusted publisher:** npm accepts `npm stage publish` only when the
   repository, workflow filename, and Environment match its configured trust
   relationship.
5. **Human approval:** Approval happens on npm, not GitHub. After the workflow
   succeeds, a maintainer opens npmjs.com's **Staged Packages** view or uses the
   authenticated npm CLI, inspects the stage, and approves it with npm 2FA.

Trusted publication from this public GitHub repository automatically creates
npm provenance. The workflow does not need `--provenance` and does not use
`NODE_AUTH_TOKEN`, `NPM_TOKEN`, or another long-lived registry secret.

## Public release configuration

| Setting | Value |
| --- | --- |
| npm package | `fastify-observability` |
| GitHub repository | `janisto/fastify-observability` |
| Workflow | `.github/workflows/release.yml` |
| GitHub Environment | `npm` |
| Workflow trigger | GitHub Release `published` |
| Trusted action | `npm stage publish` only |
| Stable npm dist-tag | `latest` |
| Prerelease npm dist-tag | `next` |

The npm trusted-publisher form uses the workflow filename `release.yml`, not
the full `.github/workflows/release.yml` path. All identity fields are
case-sensitive.

## What the workflow does

The workflow deliberately stays close to npm's official trusted-publishing
example:

1. checks out the GitHub Release tag;
2. installs pnpm and the latest Node 24 release;
3. configures the public npm registry with `actions/setup-node`;
4. installs dependencies from the frozen pnpm lockfile;
5. runs `pnpm qa`, including build and tests;
6. stages the package using `npm stage publish` and OIDC.

Normal GitHub Releases stage with npm dist-tag `latest`. GitHub Releases marked
as prereleases stage with `next`; the GitHub prerelease checkbox must therefore
match the package's SemVer version.

The workflow does not update npm globally. The latest Node 24 release includes
an npm version new enough for OIDC and staged publishing.

## Maintainer release guide

### 1. Prepare the version

Create a normal review branch and:

1. update `package.json.version`;
2. add the release date and user-visible changes to `CHANGELOG.md`;
3. update documentation for any public API or structured-field change;
4. update `pnpm-lock.yaml` only when the reviewed package metadata requires it.

Do not create the Git tag during version preparation. Version, changelog, code,
and documentation must be reviewed together.

### 2. Run the release checks

```bash
pnpm install --frozen-lockfile
pnpm qa
pnpm audit --prod
pnpm pack --dry-run
actionlint .github/workflows/ci.yml .github/workflows/release.yml
git diff --check
```

Review the package file list printed by `pnpm pack --dry-run`. It must contain
the compiled package, declarations, README, changelog, license, and package
metadata—never local plans, tests, coverage, environment files, npm
configuration, or credentials.

Merge the release preparation through a green pull request to `main`.

### 3. Publish the GitHub Release

From the repository's GitHub Releases page:

1. create a draft release;
2. create the tag `vX.Y.Z`, where `X.Y.Z` exactly matches
   `package.json.version`;
3. target the exact reviewed commit on `main`;
4. use `vX.Y.Z` as the title;
5. write release notes from `CHANGELOG.md`;
6. mark the release as a prerelease only for a SemVer prerelease;
7. review everything, then publish the release.

Do not push the release tag separately. The published GitHub Release is the
authorization event, and release immutability locks its tag and release assets.

### 4. Confirm npm staging

Open the GitHub Actions run named **Publish to npm**. It must finish successfully
without an npm token or manual 2FA prompt.

The stage appears only after this workflow succeeds. Sign in to npmjs.com as an
npm maintainer, open the **Staged Packages** view, and select the staged
`fastify-observability` version. If no workflow has staged a version, there is
nothing to approve.

An authenticated maintainer can inspect the same stage with the npm CLI:

```bash
npm stage list fastify-observability
npm stage view <stage-id>
npm stage download <stage-id>
```

Check the package name, version, dist-tag, file list, integrity, repository,
workflow identity, and provenance. Compare the staged package with the reviewed
GitHub Release.

### 5. Approve with 2FA

Approve only after the stage is exact. On npmjs.com, click **Approve** for the
selected staged package and complete the interactive 2FA prompt. Alternatively,
approve through the authenticated npm CLI:

```bash
npm stage approve <stage-id>
```

Use the interactive npm or website prompt for 2FA. Never place an OTP, recovery
code, password, or session token in a command, file, issue, release note, CI
variable, or log.

Approval makes the staged version public. npm versions are immutable and cannot
be overwritten.

### 6. Verify the public release

Set the released version locally and inspect public metadata:

```bash
VERSION=X.Y.Z
npm view "fastify-observability@$VERSION" \
  name version dist-tags repository engines peerDependencies dependencies \
  maintainers dist --json
```

Verify that stable releases update `latest`, prereleases update `next`, and no
unexpected maintainer or dependency appears.

In a fresh Node 24 directory, install from the public registry:

```bash
pnpm add fastify@5.10.0 "fastify-observability@$VERSION"
```

Run the README's GCP setup and a TypeScript typecheck. Repeat with the latest
compatible Fastify 5 version when validating a stable release.

Finally, verify:

- the npm package page shows provenance for the release;
- provenance points to this repository and `release.yml`;
- the GitHub Release tag points to the reviewed commit;
- the GitHub Release is marked immutable;
- the changelog and published package behavior agree.

`npm audit signatures` should run in a separate temporary npm-managed project.
Do not create or commit `package-lock.json` in this pnpm repository.

## Failure and recovery

- **OIDC reports `E404`:** Check the npm trusted publisher's owner, repository,
  workflow filename, Environment, and stage-only permission. Check that the job
  has `id-token: write`. Do not add a token fallback.
- **The workflow fails before staging:** No npm version was published. A purely
  transient run may be retried against the unchanged release. A source or
  workflow correction requires a new reviewed version and GitHub Release.
- **The stage is wrong:** Do not approve it. Reject it with 2FA, correct the
  release, and follow npm's staged-version rules.
- **A public release is defective:** Deprecate it when appropriate and publish
  a corrected higher version. Never reuse or overwrite the version.
- **Provenance is missing:** Treat the release as incomplete. Verify trusted
  OIDC publication, public repository visibility, and the exact workflow
  identity before claiming provenance.

## Bootstrap history

`0.1.0` was a one-time metadata-only bootstrap used to create the npm package
record. It was published interactively and therefore has no GitHub Actions
provenance. `0.2.0` is the first implementation release intended to use this
OIDC staging architecture.

## Official documentation

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [`npm stage` CLI](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [`actions/setup-node` trusted-publisher guide](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc)
- [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
- [GitHub Release workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
