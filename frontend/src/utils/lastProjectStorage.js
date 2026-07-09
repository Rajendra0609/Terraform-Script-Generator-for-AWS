/**
 * Per-user-namespaced storage for the "last active project" id.
 *
 * SECURITY FIX (L-04): 'tfgen.lastProjectId' used to be a single global
 * localStorage key, unscoped by user. On a shared/kiosk browser profile, if
 * User A logs out and User B logs in, the Navbar/History page would try to
 * auto-navigate B toward A's last project id. The backend still correctly
 * denies B access to A's actual project data — this never exposed project
 * contents — but it leaked the existence/UUID of another user's project and
 * produced a confusing "not found/access denied" flash for User B.
 *
 * Namespacing the key by user id means each account only ever reads back
 * its own last-project pointer, never another account's.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keyFor(userId) {
  return userId ? `tfgen.lastProjectId.${userId}` : null;
}

/** Persist `projectId` as the given user's last active project. No-op if userId is falsy. */
export function setLastProjectId(userId, projectId) {
  const key = keyFor(userId);
  if (!key || !projectId) return;
  try { localStorage.setItem(key, projectId); } catch { /* storage unavailable — non-fatal */ }
}

/** Read back the given user's last active project id, or null if absent/invalid/no user. */
export function getLastProjectId(userId) {
  const key = keyFor(userId);
  if (!key) return null;
  try {
    const id = localStorage.getItem(key);
    return id && UUID_RE.test(id) ? id : null;
  } catch { return null; }
}
