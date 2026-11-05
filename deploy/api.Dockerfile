FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN --mount=type=cache,id=signaldock-npm,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --prefer-offline && npm run build

FROM build AS production-dependencies
RUN --mount=type=cache,id=signaldock-npm,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefer-offline --workspace=@signaldock/api

FROM node:24.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SIGNALDOCK_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json
COPY --from=build --chown=node:node /app/apps /app/apps
COPY --from=build --chown=node:node /app/packages /app/packages
COPY --from=build --chown=node:node /app/services /app/services
COPY --chown=node:node LICENSE /app/LICENSE
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
ARG VCS_REF=development
LABEL org.opencontainers.image.source="https://github.com/raztor/SignalDock" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision=$VCS_REF
CMD ["node", "apps/api/dist/main.js"]
