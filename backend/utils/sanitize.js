'use strict';

// ─── Secret patterns (AWS, GitHub, generic passwords) ─────────────────────────
// Source: OWASP credential detection + AWS key format spec
const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID',       re: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Access Key',   re: /(?:aws_secret|secret_access_key)\s*=\s*["']?[A-Za-z0-9\/+=]{40}["']?/i },
  { name: 'AWS Session Token',       re: /(?:aws_session_token|session_token)\s*=\s*["'][A-Za-z0-9\/+=]{100,}["']/i },
  { name: 'Private Key Material',    re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub Token',            re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'Generic Password Field',  re: /password\s*=\s*["'][^"'${}\s]{8,}["']/i },
  { name: 'Generic Secret Field',    re: /secret\s*=\s*["'][^"'${}\s]{8,}["']/i },
];

/**
 * Scan HCL text for literal secrets.
 * Returns array of { name, excerpt } for each finding, or [] if clean.
 * Does NOT block — callers decide severity.
 */
function detectSecrets(input) {
  if (!input) return [];
  const text = String(input);
  const findings = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const match = text.match(re);
    if (match) {
      // Return a safe excerpt (never the full secret value)
      findings.push({ name, excerpt: match[0].slice(0, 20) + '…' });
    }
  }
  return findings;
}

/**
 * Check HCL for dangerous network rules (0.0.0.0/0 on privileged ports).
 * Returns array of warning strings.
 */
function lintNetworkRules(hcl) {
  if (!hcl) return [];
  const warnings = [];
  const text = String(hcl);

  // Find all ingress/egress blocks that reference 0.0.0.0/0
  const openWorldRe = /0\.0\.0\.0\/0|::\/0/;
  const privilegedPorts = [
    { port: 22,   name: 'SSH' },
    { port: 3389, name: 'RDP' },
    { port: 5432, name: 'PostgreSQL' },
    { port: 3306, name: 'MySQL' },
    { port: 27017, name: 'MongoDB' },
    { port: 6379, name: 'Redis' },
  ];

  if (!openWorldRe.test(text)) return [];

  // Check each block for both open-world CIDR and privileged port in the same block
  // Split on resource blocks for context
  const blocks = text.split(/resource\s+"|ingress\s*{|egress\s*{/);
  for (const block of blocks) {
    if (!openWorldRe.test(block)) continue;
    for (const { port, name } of privilegedPorts) {
      // Match from_port / to_port / port patterns
      const portRe = new RegExp(`(from_port|to_port|port)\\s*=\\s*${port}\\b`);
      if (portRe.test(block)) {
        warnings.push(
          `SECURITY: Open-world CIDR (0.0.0.0/0 or ::/0) detected on port ${port} (${name}). ` +
          `Restrict ingress to known IP ranges.`
        );
      }
    }
  }
  return [...new Set(warnings)]; // deduplicate
}

// ─── HTML/CSS tag stripper (unchanged, defensive) ─────────────────────────────
function stripHtml(input) {
  if (!input) return '';
  let t = String(input);
  try {
    // Only perform heavy work if suspicious characters present
    if (/[<>\u00AB\u00BB]/.test(t) || /&lt;|&gt;|&amp;/.test(t) || /color:|style=/.test(t)) {
      t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      // Remove tags
      t = t.replace(/<[^>]+>/g, '');
      // Remove inline CSS fragments left as plain text
      t = t.replace(/(?:["']?)?color:\s*[^;"'<>]+;?/gi, '');
      t = t.replace(/(?:["']?)?font-weight:\s*[^;"'<>]+;?/gi, '');
      t = t.replace(/(?:["']?)?font-style:\s*[^;"'<>]+;?/gi, '');
      t = t.replace(/(?:["']?)?display:\s*[^;"'<>]+;?/gi, '');
      t = t.replace(/(?:["']?)?user-select:\s*[^;"'<>]+;?/gi, '');
      t = t.replace(/style=\s*["'][^"']*["']/gi, '');
      t = t.replace(/\bclass=["'][^"']*["']/gi, '');
      // Keep legitimate quotes intact — avoid stripping characters that
      // are significant in HCL (e.g. opening quotes). Previously we
      // removed stray quote-like fragments which broke valid strings
      // (left only trailing quotes). Do not remove quotes here.
      // Collapse excessive blank lines
      t = t.replace(/\n{3,}/g, '\n\n').trim();
    }
    return t;
  } catch (e) {
    return String(input).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  }
}

module.exports = { stripHtml, detectSecrets, lintNetworkRules };
