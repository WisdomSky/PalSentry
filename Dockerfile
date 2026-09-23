# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PalSentry — single image serving both the API and the built SPA.
#
# One container means no CORS configuration, no second service, and the simplest possible
# compose file. The stages below are ordered so the final image contains only the compiled
# server, the built frontend, and production dependencies.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
#
# Manifests are copied before sources so that a source-only change does not invalidate the
# dependency layer. Build tooling is installed because better-sqlite3 may need to compile from
# source when no prebuilt binary matches this Node ABI; the tools never reach the final image.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps

ENV npm_config_update_notifier=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/

# The image never runs Electron: skip downloading its ~100 MB binary to keep the build fast.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — build the frontend and the server
# ---------------------------------------------------------------------------
FROM deps AS build

WORKDIR /app

COPY tsconfig.base.json ./
COPY packages ./packages

# Builds the web workspace first, then the server, then copies the SPA into the server's dist.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — production dependencies only
#
# `npm prune --omit=dev` drops TypeScript, tsup, Vite, and the rest of the toolchain. The native
# better-sqlite3 binary was compiled in this same image, so the ABI matches the runtime stage.
# ---------------------------------------------------------------------------
FROM deps AS prod-deps

WORKDIR /app

RUN npm prune --omit=dev \
 && mkdir -p packages/server/node_modules

# ---------------------------------------------------------------------------
# Stage 4 — runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PALSENTRY_PORT=3000 \
    PALSENTRY_HOST=0.0.0.0 \
    PALSENTRY_DATA_DIR=/data

WORKDIR /app

# Run unprivileged. The process needs no capabilities, and /data is the only writable path.
RUN groupadd --system --gid 1001 palsentry \
 && useradd --system --uid 1001 --gid palsentry --home /app --shell /usr/sbin/nologin palsentry \
 && mkdir -p /data \
 && chown -R palsentry:palsentry /data /app

COPY --from=prod-deps --chown=palsentry:palsentry /app/node_modules ./node_modules
COPY --from=prod-deps --chown=palsentry:palsentry /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=prod-deps --chown=palsentry:palsentry /app/package.json ./package.json
COPY --from=build --chown=palsentry:palsentry /app/packages/server/package.json ./packages/server/package.json
COPY --from=build --chown=palsentry:palsentry /app/packages/server/scripts/hash-password.mjs ./packages/server/scripts/hash-password.mjs
# dist/public holds the built SPA, which the server serves from its own directory.
COPY --from=build --chown=palsentry:palsentry /app/packages/server/dist ./packages/server/dist

USER palsentry

EXPOSE 3000

# The SQLite database lives here; mount a volume to keep bans, audit history, and metrics.
VOLUME ["/data"]

# Uses Node itself rather than curl/wget so the image needs no extra packages.
# Note this is a liveness check for *PalSentry*; it intentionally does not depend on the
# Palworld server, so an offline game server never marks the dashboard unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PALSENTRY_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
