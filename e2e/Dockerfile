# syntax=docker/dockerfile:1.19.0

ARG NODE_IMAGE=node:24.18.0-trixie-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot

FROM ${NODE_IMAGE} AS package-builder
WORKDIR /source
RUN corepack enable && corepack install --global pnpm@11.13.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY README.md CHANGELOG.md LICENSE ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile && \
    pnpm build && \
    mkdir -p /package && \
    npm pack --ignore-scripts --pack-destination /package && \
    mv /package/fastify-observability-*.tgz /package/fastify-observability.tgz

FROM ${NODE_IMAGE} AS app-builder
WORKDIR /app
RUN corepack enable && corepack install --global pnpm@11.13.0
COPY e2e/package.json e2e/pnpm-lock.yaml e2e/pnpm-workspace.yaml e2e/tsconfig.json ./
COPY --from=package-builder /package/fastify-observability.tgz ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --lockfile-only --fix-lockfile && \
    pnpm install --frozen-lockfile
COPY e2e/src ./src
RUN pnpm build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
RUN corepack enable && corepack install --global pnpm@11.13.0
COPY --from=app-builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=package-builder /package/fastify-observability.tgz ./
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prod --frozen-lockfile

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=app-builder /app/dist ./dist
COPY --from=app-builder /app/package.json ./package.json
USER 65532:65532
ENV PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
CMD ["dist/server.js"]
