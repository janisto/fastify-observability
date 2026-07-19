# AGENTS.md

Instructions for coding agents working in this repository.

`README.md` is for human users and contributors: setup, capabilities,
architecture, operations, and contribution entry points. `AGENTS.md` is for
coding agents: execution rules, implementation constraints, and validation
policy. Do not duplicate agent instructions into the README or turn this file
into human onboarding documentation.

## Engineering priorities

- Correctness first, then readability and maintainability, then performance.
- Inspect the relevant implementation, callers, and existing tests before
  changing behavior.
- Prefer the smallest safe change that solves the problem.
- Reuse existing local patterns and utilities, refactoring them when needed,
  instead of creating parallel abstractions or adding dependencies.
- State the failure mode before architectural, security, persistence, or
  production-impacting changes.
- Do not declare completion until implementation, validation, and remaining
  risks are reported.
- Keep source comments and documentation concise. Do not add progress
  narration, generated banners, emojis, or speculative TODOs.

## Pull requests

- Format titles as `type[optional scope]: description`. Prefer no scope;
  include one only when it materially improves clarity.
- Use `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`,
  or `revert` as the type. Example: `feat: add response size field`.
- Keep each pull request focused. In the body, explain why the change is
  needed, what changed, how it was validated, and any remaining risk.
- Keep the title suitable for the final squash or merge commit.
- Add applicable user-visible changes under `CHANGELOG.md` -> `[Unreleased]`.
  Skip entries for changes without meaningful user impact.

## Commits

- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Prefer no scope; include one only when it materially improves clarity. Write
  a short, imperative description. Example: `fix: preserve request ID`.
- Mark breaking changes with `!` and explain them in a `BREAKING CHANGE:`
  footer.
- Before committing, run `just qa` and `git diff --check`.

## Repository constraints

- Keep the package ESM-only and preserve the documented Node.js and Fastify
  support lines.
- Reuse the package-created Pino logger and its guarded child path. Do not add a
  second logging backend, global logger, or uncontrolled logger mutation path.
- Do not log queries, bodies, credentials, cookies, arbitrary headers, or
  forwarded IPs.
- Treat exported APIs, structured log fields, defaults, and supported runtime
  versions as compatibility contracts.

## Public API and documentation

- Update applicable tests, README content, examples, type or API documentation,
  and changelog entries when public behavior changes.
- Keep `CHANGELOG.md` in Keep a Changelog format with an `Unreleased` section,
  ISO-dated bracketed versions, applicable change categories, and comparison
  links.
- Keep examples minimal, runnable, and aligned with the documented API.
- Document breaking changes explicitly and provide migration guidance.

## Tests

- Use the repository's `$adversarial-testing` skill when creating, updating, or
  reviewing tests.
- Test observable behavior, boundaries, failure recovery, and forbidden side
  effects. Do not optimize for coverage numbers or mock interactions alone.

## Workflow security

- Use full release tags for third-party GitHub Actions, for example
  `actions/checkout@v7.0.0`. Do not use commit SHAs, moving branches, or major
  version tags.
- `just qa` must run `actionlint` and `zizmor --offline .` in addition to the
  repository's language checks.
- Do not add standalone repository scripts, including under `.github`. Enforce
  repository policy through the existing native test suite and tooling.
- Keep `.github/zizmor.yml` aligned with the exact-tag policy and the
  one-day Dependabot cooldown.

## Releases

- Prepare releases through a pull request titled `chore: prepare vX.Y.Z`.
- Update `package.json`, `CHANGELOG.md`, applicable lockfile metadata, and
  public documentation together.
- Run `just install`, `just qa`, `just package-check`, `just audit`, and
  `git diff --check`.
- Run `just package-check` whenever package contents or release metadata change.
- Merge a green pull request to `main`, then release the exact reviewed commit
  with tag `vX.Y.Z`.
- When drafting a stable GitHub Release, use **Generate release notes** and mark
  it as **Latest**. Edit the notes for accuracy and alignment with
  `CHANGELOG.md` before publishing.
- Never move an existing release tag or overwrite a published npm version.
- Follow `RELEASE.md` for staging, approval, and post-publish verification.
