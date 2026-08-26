# Stage 1: Build TypeScript source
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy package manifests and workspace configs
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/tsconfig.json ./packages/mcp-server/
COPY packages/watcher/package.json packages/watcher/tsconfig.json ./packages/watcher/

# Install dependencies (skip browser download)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci

# Copy source code and build
COPY packages/ ./packages/
COPY scripts/ ./scripts/
RUN npm run build

# Remove development dependencies
RUN npm prune --omit=dev

# Stage 2: Runtime image with Chromium & CJK Fonts
FROM node:20-bookworm-slim AS runtime

# Install Chromium, CJK fonts, dumb-init, and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    fonts-freefont-ttf \
    dumb-init \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    OBSIDIAN_MERMAID_VAULT_ROOT=/vault

WORKDIR /app

# Create default vault mount point
RUN mkdir -p /vault

# Copy compiled workspaces and production node_modules from builder
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/
COPY --from=builder /app/packages/watcher/package.json ./packages/watcher/
COPY --from=builder /app/packages/watcher/dist ./packages/watcher/
COPY --from=builder /app/node_modules ./node_modules

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
