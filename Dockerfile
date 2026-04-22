# =============================================================================
# SUDO-AI v4  —  Multi-stage Dockerfile
# =============================================================================
# Stage 1 (builder): installs all deps and compiles TypeScript → dist/
# Stage 2 (runtime): lean image with only what the process needs at runtime.
# The final image runs as a non-root user (sudoai) for least-privilege security.
# =============================================================================

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Enable corepack so pnpm is available without a separate install step
RUN corepack enable

WORKDIR /app

# Copy lockfile + manifest first so this layer is cached unless deps change
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies (including devDependencies needed to compile)
# --frozen-lockfile ensures the build is reproducible and fails on drift
RUN pnpm install --frozen-lockfile

# Copy source tree and config required by the compiler / bundler
COPY src/ ./src/
COPY config/sudo-ai.json5 ./config/
COPY tsconfig.json vite.config.ts ./

# Compile TypeScript → dist/
RUN pnpm build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install Chromium for Playwright-based browser tools and procps for healthcheck
# We pin to --no-install-recommends to keep the image as small as possible
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      procps && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright / browser-tool to use the system Chromium instead of downloading
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Create a dedicated non-root user and group for the process
RUN groupadd -r sudoai && useradd -r -g sudoai -m sudoai

WORKDIR /app

# Copy compiled output from the builder stage
COPY --from=builder /app/dist ./dist

# Copy production node_modules (already installed in builder; no devDeps needed at runtime)
COPY --from=builder /app/node_modules ./node_modules

# Copy the package manifest (required by Node.js module resolution)
COPY --from=builder /app/package.json ./

# Copy the application config file (secrets are injected via env, not this file)
COPY config/sudo-ai.json5 ./config/

# Create the persistent data directory and hand ownership to the non-root user
RUN mkdir -p data && chown -R sudoai:sudoai /app

# Switch to non-root user — all subsequent commands and the runtime process run as sudoai
USER sudoai

# 3000 — main HTTP / WebSocket API
# 3001 — health-check / metrics endpoint
EXPOSE 3000 3001

# Lightweight health check: hit the /health endpoint on the internal metrics port.
# start-period gives the process time to initialise before the first check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# ENTRYPOINT is fixed; CMD provides the default sub-command (overridable at runtime)
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["start"]
