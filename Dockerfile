# Optimized Node.js 24 container for Railway and Render
FROM node:24-bookworm-slim AS base

WORKDIR /app

# Install build dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy application source code
COPY . .

# Build static assets (PDF.js assets, public vendor files)
RUN npm run build

# Production runtime stage
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]
