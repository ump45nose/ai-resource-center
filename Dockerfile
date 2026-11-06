FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY web ./web
COPY public ./public
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY scripts/scan-models.mjs ./scripts/scan-models.mjs
COPY scripts/scan-models-browser.mjs ./scripts/scan-models-browser.mjs
USER node
ENV PORT=18321 DATA_DIR=/data
EXPOSE 18321
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:18321/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.mjs"]
