FROM node:24-bookworm-slim AS builder

WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts vitest.config.ts tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 4310
CMD ["node", "dist/server/index.mjs"]
