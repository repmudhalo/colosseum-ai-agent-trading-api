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
FROM node:22-alpine

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output and config
COPY --from=builder /app/dist/ dist/
COPY config/ config/

# Create data directory
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "dist/index.js"]
