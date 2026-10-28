FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
ARG WEB_BASE_PATH=
ENV SIGNALDOCK_WEB_BASE_PATH=$WEB_BASE_PATH
RUN npm ci --ignore-scripts && npm run export:web

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
ARG WEB_BASE_PATH=
ENV WEB_BASE_PATH=$WEB_BASE_PATH
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/client/dist /usr/share/nginx/html${WEB_BASE_PATH}
EXPOSE 8080
