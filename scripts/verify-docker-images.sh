#!/usr/bin/env bash
# verify-docker-images.sh
#
# SECURITY FIX (L-06): backend/terraform/runner.js pins the Terraform Docker
# image by immutable digest (hashicorp/terraform@sha256:...) so the binary
# can't change silently between server restarts. That's good practice, but
# it also means a bad/stale digest fails LOUD only the first time a
# Docker-fallback operation actually runs — and Docker fallback is more
# central to this app than it looks, since Checkov and Infracost have no
# local-binary alternative at all (see backend/services/checkov.js and
# backend/services/infracost.js).
#
# This script re-verifies every pinned image digest against its real
# registry manifest (no image layers are pulled) and fails the build if any
# of them don't resolve — catching a bad pin in CI, where network egress to
# the registry is available, instead of in production.
#
# Usage:
#   ./scripts/verify-docker-images.sh
#
# Wire this into whatever CI system this repo ends up using (a step in a
# GitHub Actions / GitLab CI / Jenkins pipeline, run at build/deploy time).
# There's no CI config in this repo yet to wire it into automatically, so
# it's provided standalone.
#
# Exit code: 0 if every pinned image resolves, 1 if any do not.
set -uo pipefail

# Extract the TF_DOCKER_IMAGE default from runner.js so this script and the
# app can never silently drift apart (no image list hand-maintained here).
RUNNER_JS="$(dirname "$0")/../backend/terraform/runner.js"

if [ ! -f "$RUNNER_JS" ]; then
  echo "ERROR: could not find $RUNNER_JS" >&2
  exit 1
fi

# Pull out the string literal that follows "TF_DOCKER_IMAGE = process.env.TF_DOCKER_IMAGE ||"
TF_DOCKER_IMAGE=$(grep -A1 "const TF_DOCKER_IMAGE = process.env.TF_DOCKER_IMAGE" "$RUNNER_JS" \
  | tail -n1 \
  | sed -n "s/.*'\\([^']*\\)'.*/\\1/p")

if [ -z "$TF_DOCKER_IMAGE" ]; then
  echo "ERROR: could not parse TF_DOCKER_IMAGE default out of $RUNNER_JS" >&2
  exit 1
fi

# Add any other digest-pinned images here as the app grows more of them.
IMAGES=("$TF_DOCKER_IMAGE")

FAILED=0
for IMAGE in "${IMAGES[@]}"; do
  echo "Verifying: $IMAGE"
  if docker manifest inspect "$IMAGE" > /dev/null 2>/tmp/verify-docker-images.err; then
    echo "  OK"
  else
    echo "  FAILED — this digest does not resolve against its registry:"
    sed 's/^/    /' /tmp/verify-docker-images.err
    FAILED=1
  fi
done
rm -f /tmp/verify-docker-images.err

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "One or more pinned Docker images failed verification." >&2
  echo "Re-pin from a known-good 'docker pull <image>:<tag>' — do not hand-edit the hex digest." >&2
  exit 1
fi

echo "All pinned Docker images verified successfully."
exit 0
