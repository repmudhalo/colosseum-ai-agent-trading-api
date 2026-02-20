# ---- Build stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files and install all deps (including dev for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY config/ config/
RUN npm run build

# ---- Production stage ----
# Use Debian slim (not Alpine) for Puppeteer/Chromium compatibility.
# Chromium on Alpine requires extra work; Debian ships with all needed libs.
FROM node:22-slim

WORKDIR /app

# Install Chromium and deps needed by Puppeteer.
# Also install fonts for non-latin characters and emoji.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output, config, migrations, and SKILL.md (served via /skill endpoint)
COPY --from=builder /app/dist/ dist/
COPY config/ config/
COPY migrations/ migrations/
COPY SKILL.md ./

# Create data directories (charts subdir for screenshots)
RUN mkdir -p data/charts

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "dist/index.js"]
