# ─── Stage 1: Install npm dependencies ────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only manifests first so Docker can cache the npm install layer
COPY package*.json ./
# PRODUCTION FIX: `npm ci` (not `npm install`) — installs exactly what's
# pinned in package-lock.json, fails if the lockfile is out of sync with
# package.json, and is faster/more reproducible in CI than `npm install`.
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Stage 2: Download Terraform & terraform-ls binaries ──────────────────────
FROM alpine:3.21 AS tools

# ── Pin versions here — bump as needed ────────────────────────────────────────
ARG TERRAFORM_VERSION=1.15.3
ARG TERRAFORM_LS_VERSION=0.38.6

RUN apk add --no-cache curl unzip

# Detect CPU architecture once and reuse for both downloads
RUN set -eux; \
    ARCH=$(uname -m); \
    case "$ARCH" in \
      x86_64)  BIN_ARCH="amd64" ;; \
      aarch64) BIN_ARCH="arm64" ;; \
      armv7l)  BIN_ARCH="arm"   ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    \
    # ── Terraform ─────────────────────────────────────────────────────────────
    curl -fsSL \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${BIN_ARCH}.zip" \
      -o /tmp/terraform.zip; \
    unzip -o /tmp/terraform.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/terraform; \
    \
    # ── terraform-ls ──────────────────────────────────────────────────────────
    curl -fsSL \
      "https://releases.hashicorp.com/terraform-ls/${TERRAFORM_LS_VERSION}/terraform-ls_${TERRAFORM_LS_VERSION}_linux_${BIN_ARCH}.zip" \
      -o /tmp/terraform-ls.zip; \
    unzip -o /tmp/terraform-ls.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/terraform-ls; \
    \
    # Cleanup
    rm /tmp/terraform.zip /tmp/terraform-ls.zip; \
    \
    # Smoke-test both binaries
    terraform version || true; \
    terraform-ls version || true

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# ── System tools ──────────────────────────────────────────────────────────────
# docker-cli  → lets the backend run checkov/infracost/terraform-sandbox
#               containers. SECURITY FIX: this used to talk to a raw
#               /var/run/docker.sock bind-mounted straight into this
#               container (equivalent to host root for anything that could
#               reach it). It now talks over TCP to a locked-down
#               `docker-socket-proxy` service instead — see DOCKER_HOST in
#               docker-compose.yml and the comments on that service. This
#               container never mounts the real socket and does not need
#               (and no longer has) membership in a `docker` group.
# ca-certificates, wget → needed by the HEALTHCHECK and HTTPS calls
RUN apk add --no-cache \
      docker-cli \
      ca-certificates \
      wget \
      tini

# ── Copy Terraform binaries from the tools stage ──────────────────────────────
COPY --from=tools /usr/local/bin/terraform      /usr/local/bin/terraform
COPY --from=tools /usr/local/bin/terraform-ls   /usr/local/bin/terraform-ls

# ── Non-root user ─────────────────────────────────────────────────────────────
# appuser runs the Node process. It is NOT a member of any docker-socket
# group — DOCKER_HOST points the `docker` CLI at the docker-socket-proxy
# service over TCP, so no local socket permissions are needed at all.
RUN addgroup -S appgroup \
 && adduser  -S appuser -G appgroup

# ── Application files ─────────────────────────────────────────────────────────
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chown -R appuser:appgroup /app

# ── Shared scratch volume mount point ─────────────────────────────────────────
# See backend/utils/dockerScratch.js + docker-compose.yml (tfgen_scratch
# volume). Pre-created with appuser ownership so that when Compose mounts
# the (initially empty) named volume here, Docker seeds the volume with this
# directory's ownership instead of defaulting to root:root — appuser needs
# to create session subdirectories under this mount at runtime.
RUN mkdir -p /tfgen-scratch && chown appuser:appgroup /tfgen-scratch

USER appuser

EXPOSE 4000

# BUG FIX: this HEALTHCHECK was documented in a comment but never actually
# written — `docker ps` / orchestrators had no way to detect a hung/crashed
# Node process short of the container exiting outright. Pings the real
# /api/health route (see backend/server.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null --tries=1 http://127.0.0.1:4000/api/health || exit 1

# tini as PID 1 so SIGTERM/SIGINT from `docker stop` / Kubernetes actually
# reach the Node process (and get forwarded to any children) instead of
# being swallowed — Node is not a real init system.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
