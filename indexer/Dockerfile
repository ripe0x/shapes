# Built from the repo root, not from indexer/: indexer/deploy.sh runs `fly deploy` from the
# root with --dockerfile indexer/Dockerfile and `.` as the build context. `src/api/routes.ts`
# imports the shapes-sdk package by name (a `file:../packages/shapes-sdk` dependency in
# package.json), and shapes-sdk's own deployments.ts reads deployments/<chainId>.json and
# indexer/abis; all three need to be present in the same relative layout as the repo itself, which
# a build scoped to indexer/ alone cannot provide.
FROM node:22.19.0-slim

WORKDIR /app

# shapes-sdk needs its own node_modules (viem): Node resolves a bare import from the real path
# of a symlinked package, not from wherever it was imported, so indexer's own node_modules is not
# on that resolution path. shapes-sdk is a root npm workspace in local dev (sharing the repo
# root's node_modules and lockfile) but has no lockfile of its own; installed here in isolation,
# against only its own package.json, since the image never carries the full monorepo root.
COPY packages/shapes-sdk ./packages/shapes-sdk
WORKDIR /app/packages/shapes-sdk
RUN npm install --omit=dev --no-audit --no-fund

WORKDIR /app
COPY deployments ./deployments

COPY indexer/package.json indexer/package-lock.json ./indexer/
WORKDIR /app/indexer
RUN npm ci

COPY indexer ./

ENV NODE_ENV=production
ENV PONDER_TELEMETRY_DISABLED=true

EXPOSE 42069

# Runs the flags directly (not `npm start`) so `exec` replaces this shell with the ponder
# process itself, and Fly's SIGTERM (kill_signal) reaches it straight, for a graceful shutdown.
CMD ["sh", "-c", "exec ./node_modules/.bin/ponder start --schema \"$DATABASE_SCHEMA\" --views-schema \"$DATABASE_VIEWS_SCHEMA\" --port \"${PORT:-42069}\""]
