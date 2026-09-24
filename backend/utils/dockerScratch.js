'use strict';
/**
 * Shared scratch-space helper for the Docker-outside-of-Docker (DooD)
 * pattern this app uses: the backend container spawns SIBLING containers
 * (terraform / checkov / infracost) via a Docker socket that is serviced by
 * the HOST's dockerd (now via docker-socket-proxy — see docker-compose.yml),
 * not by anything running "inside" the backend container.
 *
 * SECURITY FIX (critical — "governance/security-scan gate is a structural
 * no-op", sibling-container path mismatch): every caller of this module used
 * to build scratch paths under `os.tmpdir()`, e.g. `/tmp/tfgen-checkov/<id>`,
 * and hand that path straight to `docker run -v <path>:/workspace`. A bind
 * mount's source is resolved by the DAEMON against its own (the HOST's)
 * filesystem — `/tmp/tfgen-checkov/<id>` only exists inside the *backend*
 * container's own overlay filesystem, not on the host. Docker's behavior for
 * a bind-mount source that doesn't exist on the host is to silently create
 * an EMPTY directory there and mount that — so every sibling container
 * (terraform fmt/validate/plan/apply in Docker mode, Checkov, Infracost) was
 * seeing an empty `/workspace`, not the HCL that was actually written.
 * Concretely, this meant `runCheckov()` always scanned nothing and always
 * returned 0 findings, so the "block plan on CRITICAL findings" gate could
 * never fire regardless of how insecure the real HCL was.
 *
 * Fix: use a Docker NAMED VOLUME instead of a host bind-mount path. A named
 * volume is a daemon-managed object referenced *by name*, not a raw
 * filesystem path — so passing it to `-v tfgen_scratch:/tfgen-scratch` works
 * correctly no matter which container issued the `docker run`, as long as
 * that same volume is also mounted into the backend service at the same
 * path (see docker-compose.yml → backend.volumes → tfgen_scratch). Anything
 * this container writes under SCRATCH_MOUNT is immediately visible, at the
 * exact same absolute path, inside a sibling container that mounts the same
 * volume — so callers can keep using ordinary absolute-path fs.* calls and
 * hand those same absolute paths to `docker run -w <path>` unchanged.
 */
const fs = require('fs');

// Must match the volume name declared in docker-compose.yml.
const SCRATCH_VOLUME_NAME = process.env.TFGEN_SCRATCH_VOLUME || 'tfgen_scratch';
// Must match where that volume is mounted inside THIS (backend) container.
const SCRATCH_MOUNT = process.env.TFGEN_SCRATCH_MOUNT || '/tfgen-scratch';

// Pass these two args as part of any `docker run` invocation that needs to
// see files this container wrote under SCRATCH_MOUNT.
const SCRATCH_VOLUME_ARGS = ['-v', `${SCRATCH_VOLUME_NAME}:${SCRATCH_MOUNT}:rw`];
// Read-only variant for sibling containers that only ever read (Checkov,
// Infracost) — terraform itself still needs :rw for init/plan/apply artifacts.
const SCRATCH_VOLUME_ARGS_RO = ['-v', `${SCRATCH_VOLUME_NAME}:${SCRATCH_MOUNT}:ro`];

/**
 * Create (or re-create) a scratch directory that both this container and a
 * sibling container spawned via SCRATCH_VOLUME_ARGS can read/write.
 */
function ensureScratchDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // The sibling containers this app spawns run as a hardcoded
  // --user=1000:1000, which will not, in general, match this container's
  // own (appuser) uid — there's no reliable way to know the host-visible
  // uid mapping in advance. These are short-lived, per-job directories,
  // freshly created and cleaned up right after use (see cleanup() in each
  // caller), so 0777 here is a deliberate, narrowly-scoped trade-off rather
  // than a broad permissions weakening.
  fs.chmodSync(dir, 0o777);
}

module.exports = { SCRATCH_VOLUME_NAME, SCRATCH_MOUNT, SCRATCH_VOLUME_ARGS, SCRATCH_VOLUME_ARGS_RO, ensureScratchDir };
