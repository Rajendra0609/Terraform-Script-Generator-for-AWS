# ─── Stage 1: Build React app ─────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Receive the build-time API URL (REACT_APP_* are baked in at build time by CRA)
ARG REACT_APP_API_URL=
ARG REACT_APP_API_URL_LS=

ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV REACT_APP_API_URL_LS=$REACT_APP_API_URL_LS

# Install dependencies first (cached layer).
# npm ci gives a reproducible, lockfile-exact install and fails fast if
# package-lock.json drifts from package.json.
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# ─── Stage 2: Serve with nginx (non-root) ─────────────────────────────────────
FROM nginx:1.27-alpine

# Install curl while still root (needed for health checks)
RUN apk add --no-cache curl

# Replace the default config with ours (it must listen on 8080)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The non-root nginx user can't write to /var/run, so move the PID file to /tmp.
# The pid directive belongs in the main nginx.conf, not in conf.d.
RUN sed -i 's#^pid .*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf

# Copy the built React app
COPY --from=build /app/build /usr/share/nginx/html

# Let the nginx user read the app and write its cache
RUN chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx

USER nginx

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
