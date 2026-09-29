FROM node:26-bookworm-slim AS build

WORKDIR /src
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY frontend/shared/package.json frontend/shared/package.json
COPY quest/prototype-server/package.json quest/prototype-server/package.json
RUN npm ci
COPY frontend frontend
RUN npm run build -w @questrelay/shared && npm run build -w @questrelay/web

FROM caddy:2-alpine
COPY tools/config/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/frontend/dist /srv
