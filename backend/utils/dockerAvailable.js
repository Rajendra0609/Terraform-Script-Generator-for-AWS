'use strict';
/**
 * Shared, memoised Docker availability check.
 *
 * Both checkov.js and infracost.js previously defined their own
 * isDockerAvailable() function, causing two independent 3-second
 * `docker info` calls on every /validate request (BUG-028).
 *
 * This module provides a single IIFE-wrapped function with a
 * module-scoped TTL cache — identical to the pattern used in
 * backend/terraform/runner.js — so concurrent callers in the same
 * request share one in-flight Promise and subsequent requests within
 * the TTL window return immediately.
 */
const { exec } = require('child_process');

/** Re-check the daemon at most once per TTL window (ms). */
const DOCKER_CHECK_TTL = 60_000; // 60 seconds

/**
 * Returns a Promise<boolean> that resolves to true when the Docker
 * daemon is reachable.  The result is memoised for DOCKER_CHECK_TTL ms
 * so that:
 *   - Two services calling this concurrently share one subprocess.
 *   - Repeated requests within the TTL window skip the docker call.
 *   - A daemon that becomes available after a transient failure is
 *     detected within one TTL window.
 */
const isDockerAvailable = (() => {
  let _cached  = null;
  let _cachedAt = 0;
  let _inflight = null;

  return () => {
    const now = Date.now();

    // Return cached result while still fresh.
    if (_cached !== null && (now - _cachedAt) < DOCKER_CHECK_TTL) {
      return Promise.resolve(_cached);
    }

    // Coalesce concurrent callers onto a single in-flight check.
    if (_inflight) return _inflight;

    _inflight = new Promise(resolve => {
      exec('docker info', { timeout: 3000 }, err => {
        _cached   = !err;
        _cachedAt = Date.now();
        _inflight = null;
        resolve(_cached);
      });
    });

    return _inflight;
  };
})();

module.exports = { isDockerAvailable };
