# ─── Stage 1: Install npm dependencies ────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only manifests first so Docker can cache the npm install layer
COPY package*.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Download Terraform & terraform-ls binaries ──────────────────────
FROM alpine:3.21 AS tools

# ── Pin versions here — bump as needed ────────────────────────────────────────
ARG TERRAFORM_VERSION=1.15.5
ARG TERRAFORM_LS_VERSION=0.38.3

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
    unzip /tmp/terraform.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/terraform; \
    \
    # ── terraform-ls ──────────────────────────────────────────────────────────
    curl -fsSL \
      "https://releases.hashicorp.com/terraform-ls/${TERRAFORM_LS_VERSION}/terraform-ls_${TERRAFORM_LS_VERSION}_linux_${BIN_ARCH}.zip" \
      -o /tmp/terraform-ls.zip; \
    unzip /tmp/terraform-ls.zip -d /usr/local/bin; \
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
# docker-cli  → lets the backend run checkov/infracost via the host Docker daemon
#               (daemon is NOT running inside the container; the socket is bind-mounted
#                in docker-compose.yml using /var/run/docker.sock)
# ca-certificates, wget → needed by the HEALTHCHECK and HTTPS calls
RUN apk add --no-cache \
      docker-cli \
      ca-certificates \
      wget

# ── Copy Terraform binaries from the tools stage ──────────────────────────────
COPY --from=tools /usr/local/bin/terraform      /usr/local/bin/terraform
COPY --from=tools /usr/local/bin/terraform-ls   /usr/local/bin/terraform-ls

# ── Non-root user ─────────────────────────────────────────────────────────────
# appuser runs the Node process.
# We also add appuser to the 'docker' group (created by the docker-cli package)
# so it can talk to /var/run/docker.sock when the socket is bind-mounted.
#
# NOTE: on Linux hosts the Docker socket GID is typically 999 (same as the
# Alpine docker group).  If your host uses a different GID, override at runtime:
#   docker-compose run --group-add <HOST_DOCKER_GID> backend
RUN addgroup -S appgroup \
 && adduser  -S appuser -G appgroup \
 && adduser  appuser docker

# ── Application files ─────────────────────────────────────────────────────────
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 4000

# Health-check — pings the /health endpoint (defined in server.js)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "server.js"]
