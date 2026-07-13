# Two stages so the attested image carries no toolchain and no node_modules.
# The runtime is app/ only — server.js uses nothing outside the Node stdlib.
# What you audit is what runs.

FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY badge/ badge/
COPY app/ app/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /src/app/server.js /src/app/store.js ./app/
COPY --from=build /src/app/api/ ./app/api/
COPY --from=build /src/app/public/ ./app/public/

ENV PORT=8080
ENV DATA_FILE=/app/data/suggestions.jsonl
EXPOSE 8080
CMD ["node", "app/server.js"]
