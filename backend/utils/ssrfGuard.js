'use strict';
/**
 * SSRF guard for server-initiated outbound HTTP(S) requests to a
 * user-supplied URL (currently: POST /api/notifications/webhook-test).
 *
 * SECURITY FIX (critical): the previous implementation made a live outbound
 * request to any http(s) URL the caller supplied, with zero restriction on
 * the target host — no blocklist for loopback (127.0.0.1), link-local/cloud
 * metadata (169.254.169.254 — the AWS/GCP/Azure instance metadata endpoint),
 * or RFC1918 private ranges, and no protection against DNS rebinding (the
 * pre-connect DNS answer and the actual connect-time answer can differ). Any
 * authenticated user (any role) could point it at the cloud metadata
 * endpoint to try to steal the host's IAM credentials, or use it to
 * port-scan/fingerprint internal services (Redis, Postgres, etc.) with no
 * external exposure of their own.
 *
 * Fix:
 *  1. Resolve the hostname ourselves (dns.lookup, ALL addresses) rather than
 *     trusting the hostname string alone.
 *  2. Reject if ANY resolved address is loopback/private/link-local/
 *     multicast/reserved/carrier-grade-NAT/etc — classified via ipaddr.js
 *     (a maintained library), not a hand-rolled regex, and checked against
 *     the actual resolved IP (including IPv4-mapped IPv6 addresses like
 *     ::ffff:169.254.169.254, which are unwrapped before checking).
 *  3. The caller (routes/notifications.js) then PINS the outbound request to
 *     this exact validated IP — never re-resolving the hostname at connect
 *     time — which closes the DNS-rebinding TOCTOU gap between this check
 *     and the real connection.
 */
const dns    = require('dns').promises;
const net    = require('net');
const ipaddr = require('ipaddr.js');

class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * True if `addr` (a literal IP string) is NOT a safe, publicly-routable
 * unicast address — i.e. it's loopback, private, link-local (includes cloud
 * metadata), multicast, reserved/test-net, carrier-grade NAT, unique-local
 * IPv6, a tunneling range, etc. Fails closed (returns true/"unsafe") on
 * anything unparseable.
 */
function isUnsafeIp(addr) {
  try {
    let ip = ipaddr.parse(addr);
    // Unwrap IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) so e.g.
    // ::ffff:169.254.169.254 is correctly classified using the embedded
    // IPv4 address rather than slipping through as an opaque IPv6 literal.
    if (ip.kind() === 'ipv6' && ip.range() === 'ipv4Mapped') {
      ip = ip.toIPv4Address();
    }
    return ip.range() !== 'unicast';
  } catch (_) {
    return true; // unparseable — fail closed
  }
}

/**
 * Resolve `hostname` (or accept a literal IP) and return a single,
 * verified-safe { address, family } to connect to, or throw
 * SsrfBlockedError. Rejects the whole hostname if ANY resolved address is
 * unsafe, even if others are public.
 */
async function resolveSafeAddress(hostname) {
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isUnsafeIp(hostname)) {
      throw new SsrfBlockedError(`Target address ${hostname} is not a publicly routable address.`);
    }
    return { address: hostname, family: literalFamily };
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new SsrfBlockedError(`Could not resolve hostname: ${e.message}`);
  }
  if (!records.length) {
    throw new SsrfBlockedError('Hostname did not resolve to any address.');
  }
  const unsafe = records.find(r => isUnsafeIp(r.address));
  if (unsafe) {
    throw new SsrfBlockedError(
      `Target host resolves to a non-public address (${unsafe.address}) and is not permitted.`
    );
  }
  // Pin to the first resolved address — the SAME one just validated above —
  // rather than letting the HTTP client re-resolve the hostname later.
  return { address: records[0].address, family: records[0].family };
}

module.exports = { resolveSafeAddress, isUnsafeIp, SsrfBlockedError };
