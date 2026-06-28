# =============================================================================
# SUDO-AI v4  —  Multi-stage Dockerfile
# =============================================================================
# Stage 1 (builder): installs all deps and compiles TypeScript → dist/
# Stage 2 (runtime): lean image with only what the process needs at runtime.
# Both stages use node:20-slim (glibc/Debian) so native modules (better-sqlite3,
# sharp, sqlite-vec) built in stage 1 load correctly in stage 2.
# The final image runs as a non-root user (sudoai) for least-privilege security.
# =============================================================================

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

# Disable Corepack interactive prompts (non-TTY Docker build context)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Skip Playwright browser download — runtime image uses system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
COPY tsconfig.json vite.config.ts esbuild.config.cjs ./

# Compile TypeScript → dist/
RUN pnpm build

# Strip devDependencies — only production deps go to the runtime stage
RUN pnpm prune --prod

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

# Install Chromium, tini (PID-1 zombie reaper), and required shared libraries.
# libatk-bridge, libdrm, libgbm, libgtk, libnss3 are Chromium's Debian-slim
# hard dependencies not always pulled in with --no-install-recommends.
# fonts-liberation provides basic font rendering for headless screenshots.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      tini \
      fonts-liberation \
      libatk-bridge2.0-0 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      procps && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium and skip its own browser download
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Create a dedicated non-root user and group for the process
RUN groupadd -r sudoai && useradd -r -g sudoai -m sudoai

WORKDIR /app

# Copy compiled output, production dependencies, and config from the builder stage.
# --chown avoids a separate chown -R layer that would double the image size.
COPY --from=builder --chown=sudoai:sudoai /app/dist ./dist
COPY --from=builder --chown=sudoai:sudoai /app/node_modules ./node_modules
COPY --from=builder --chown=sudoai:sudoai /app/package.json ./
COPY --chown=sudoai:sudoai config/sudo-ai.json5 ./config/

# Create the persistent data directory owned by the non-root user
RUN mkdir -p data && chown sudoai:sudoai data

# Switch to non-root user — all subsequent commands and the runtime process run as sudoai
USER sudoai

# 3000 — main HTTP / WebSocket API (health endpoint lives here)
# 3001 — WebAdapter / web-chat SPA
EXPOSE 3000 3001

# Lightweight health check on the main API port (GET /health → 200 ok).
# 60s start-period accommodates Playwright + Chromium initialisation time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# tini as PID 1 correctly reaps zombie Chromium subprocesses.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server/cli.js"]
CMD ["start"]
