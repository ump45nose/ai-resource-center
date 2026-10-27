FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY scripts ./scripts
COPY integrations ./integrations
COPY --from=build /app/dist ./dist
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=18323
EXPOSE 18323
CMD ["node", "server/main.mjs"]
