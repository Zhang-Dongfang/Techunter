FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/tsup.config.ts ./packages/core/
COPY packages/core/src ./packages/core/src
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/vite.config.ts ./apps/desktop/
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/desktop/src/web ./apps/desktop/src/web
COPY apps/desktop/src/shared ./apps/desktop/src/shared
RUN npm ci --ignore-scripts
RUN npm run build --workspace @techunter/core && npm run build:web --workspace @techunter/desktop && npm run build --workspace @techunter/api

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/desktop/dist/web ./apps/api/public
USER node
CMD ["node", "apps/api/dist/index.js"]
