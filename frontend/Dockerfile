# ─── Stage 1: Build React app ─────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Receive the build-time API URL (REACT_APP_* are baked in at build time by CRA)
ARG REACT_APP_API_URL=
ARG REACT_APP_API_URL_LS=

ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV REACT_APP_API_URL_LS=$REACT_APP_API_URL_LS

# Install dependencies first (cached layer)
COPY package*.json ./
# PRODUCTION FIX: `npm ci` for a reproducible, lockfile-exact install
# (fails fast if package-lock.json drifts from package.json) instead of
# `npm install`.
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Serve with nginx (non-root) ─────────────────────────────────────
FROM nginx:1.27-alpine

# Remove the default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy our custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built React app
COPY --from=build /app/build /usr/share/nginx/html

# nginx can bind to port 8080 as a non-root user
# (we keep 80 in the compose and map host→container, but inside the
#  container we run on 8080 with the nginx user, not root)
RUN apk add --no-cache curl \
 && chown -R nginx:nginx /usr/share/nginx/html \
 && chown -R nginx:nginx /var/cache/nginx \
 && touch /var/run/nginx.pid \
 && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 8080

# BUG FIX: no HEALTHCHECK existed at all — orchestrators (Kubernetes,
# Compose, ECS) had no built-in signal that nginx had actually come up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:8080/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
