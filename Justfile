# Justfile for fastify-observability
# https://github.com/casey/just
# Local development and package checks for fastify-observability.

@_:
    just --list

# Run formatting and lint checks.
[group('qa')]
lint:
    pnpm check

# Check TypeScript types without emitting files.
[group('qa')]
typing:
    pnpm typecheck

# Apply formatting and safe lint fixes.
[group('qa')]
fix:
    pnpm check:fix

# Run tests, optionally forwarding Vitest arguments.
[group('test')]
test *args:
    pnpm exec vitest run {{ args }}

# Run tests with coverage, optionally forwarding Vitest arguments.
[group('test')]
coverage *args:
    pnpm exec vitest run --coverage {{ args }}

# Run tests in watch mode, optionally forwarding Vitest arguments.
[group('test')]
test-watch *args:
    pnpm exec vitest {{ args }}

# Run the complete non-mutating repository gate from a clean build directory.
[group('qa')]
qa: clean-dist
    pnpm qa

# Audit production dependencies.
[group('qa')]
audit:
    pnpm audit --prod

# Remove emitted package files before rebuilding.
[group('package')]
build: clean-dist
    pnpm build

# Run the complete gate and inspect the files npm would publish.
[group('package')]
package-check: qa
    pnpm pack --dry-run

# Install dependencies exactly as locked.
[group('lifecycle')]
install:
    pnpm install --frozen-lockfile

# Update dependencies within the ranges declared in package.json.
[group('lifecycle')]
update:
    pnpm update

# Remove emitted package files.
[group('lifecycle')]
clean-dist:
    rm -rf dist

# Remove generated build, test, and package artifacts, preserving dependencies.
[group('lifecycle')]
clean: clean-dist
    rm -rf artifacts coverage
    rm -f -- *.tgz *.tsbuildinfo

# Recreate installed dependencies after removing generated outputs.
[group('lifecycle')]
fresh: clean
    rm -rf node_modules
    pnpm install --frozen-lockfile
