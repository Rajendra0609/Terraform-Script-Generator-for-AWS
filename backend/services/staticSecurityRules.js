'use strict';
/**
 * Static (no-Docker) security rules for Terraform AWS resources.
 *
 * Replaces the regex-window rules that used to live in services/checkov.js.
 * The old rules had four confirmed defects (see tests/unit/backend/
 * static-rules.test.js for the regression cases):
 *
 *   1. `passed` was computed as (number of rules − number of findings), so a
 *      file with 20 unencrypted buckets reported passed = −47.
 *   2. S3 checks only looked for inline `versioning {}`, `logging {}` and
 *      `server_side_encryption_configuration {}` blocks, so a bucket configured
 *      with the current AWS provider's companion resources
 *      (aws_s3_bucket_versioning, …) was reported as non-compliant.
 *   3. `port = 80` matched `port = 8080`; the ALB rule also flagged a listener
 *      that only redirects HTTP to HTTPS, which is the recommended pattern.
 *   4. Security-group rules used a 200-character window across the whole file,
 *      so an SSH rule scoped to a private CIDR was flagged because of an
 *      unrelated 0.0.0.0/0 egress rule in another security group.
 *
 * Model: each rule enumerates its *subjects* (a resource block, an ingress
 * rule, a secret-looking attribute, …) and decides per subject whether it is
 * violated. Scoring is per subject: total = Σ max(1, subjects) over rules, and
 * failed = number of violating subjects, so 0 ≤ failed ≤ total always holds.
 */
const {
  parseBlocks,
  parseAttributes,
  makeLineIndex,
  stringLiteral,
} = require('./hclScan');

// ─── model ────────────────────────────────────────────────────────────────────

function buildModel(hcl) {
  const src = String(hcl == null ? '' : hcl);
  const lineOf = makeLineIndex(src);
  const blocks = parseBlocks(src, { base: 0, lineOf });
  const resources = blocks
    .filter((b) => b.type === 'resource' && b.labels.length === 2)
    .map((b) => ({
      ...b,
      resourceType: b.labels[0],
      address: `${b.labels[0]}.${b.labels[1]}`,
    }));
  return { src, lineOf, resources };
}

/** Top-level attributes of a block, as a name → attribute map. */
function attrsOf(model, block) {
  const map = {};
  for (const a of parseAttributes(model.src.slice(block.bodyStart, block.bodyEnd), {
    base: block.bodyStart,
    lineOf: model.lineOf,
  })) map[a.name] = a;
  return map;
}

/** Nested child blocks of a block with the given type (e.g. "ingress"). */
function childBlocks(model, block, type) {
  return parseBlocks(model.src.slice(block.bodyStart, block.bodyEnd), {
    base: block.bodyStart,
    lineOf: model.lineOf,
  }).filter((b) => b.type === type);
}

function ofType(model, type) {
  return model.resources.filter((r) => r.resourceType === type);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A companion resource (e.g. aws_s3_bucket_versioning) refers to its parent
 * either by address (`aws_s3_bucket.logs.id`) or by the literal bucket name.
 */
function refersToBucket(model, companionBody, bucket) {
  if (new RegExp(`\\baws_s3_bucket\\.${escapeRe(bucket.name)}\\b`).test(companionBody)) return true;
  const literal = stringLiteral(attrsOf(model, bucket).bucket?.value);
  return literal !== null && companionBody.includes(`"${literal}"`);
}

function companionsFor(model, companionType, bucket) {
  return ofType(model, companionType).filter((c) => refersToBucket(model, c.body, bucket));
}

// ─── ingress normalisation (shared by the port rules) ─────────────────────────

const OPEN_CIDR_RE = /"(0\.0\.0\.0\/0|::\/0)"/;

function portValue(attr) {
  if (!attr) return null;
  if (/^\d+$/.test(attr.value)) return Number(attr.value);
  const lit = stringLiteral(attr.value);
  if (lit !== null && /^\d+$/.test(lit)) return Number(lit);
  return null; // expression (var.x, locals, …) — unknown, so the rule stays silent
}

function isAllProtocols(attr) {
  if (!attr) return false;
  return attr.value === '-1' || attr.value === '"-1"' || attr.value === '"all"';
}

/** Normalises any ingress-style rule into { owner, line, allPorts, fromPort, toPort, openToWorld }. */
function normaliseIngress(owner, line, a, keys) {
  const cidrs = [keys.v4, keys.v6].map((k) => (a[k] ? a[k].value : '')).join(' ');
  return {
    owner,
    line,
    allPorts: isAllProtocols(a[keys.proto]),
    fromPort: portValue(a.from_port),
    toPort: portValue(a.to_port),
    openToWorld: OPEN_CIDR_RE.test(cidrs),
  };
}

function ingressRules(model) {
  const rules = [];
  const v4 = { v4: 'cidr_blocks', v6: 'ipv6_cidr_blocks', proto: 'protocol' };
  for (const sg of ofType(model, 'aws_security_group')) {
    for (const child of childBlocks(model, sg, 'ingress')) {
      rules.push(normaliseIngress(sg.address, child.line, attrsOf(model, child), v4));
    }
  }
  for (const r of ofType(model, 'aws_security_group_rule')) {
    const a = attrsOf(model, r);
    if (stringLiteral(a.type?.value) === 'ingress') {
      rules.push(normaliseIngress(r.address, r.line, a, v4));
    }
  }
  for (const r of ofType(model, 'aws_vpc_security_group_ingress_rule')) {
    rules.push(normaliseIngress(r.address, r.line, attrsOf(model, r), {
      v4: 'cidr_ipv4', v6: 'cidr_ipv6', proto: 'ip_protocol',
    }));
  }
  return rules;
}

function coversPort(rule, port) {
  if (!rule.openToWorld) return false;
  if (rule.allPorts) return true;
  return rule.fromPort !== null && rule.toPort !== null &&
    rule.fromPort <= port && port <= rule.toPort;
}

// ─── S3 helpers ───────────────────────────────────────────────────────────────

function s3HasVersioning(model, bucket) {
  const inline = childBlocks(model, bucket, 'versioning').some((b) =>
    /\benabled\s*=\s*true\b/.test(b.body));
  if (inline) return true;
  return companionsFor(model, 'aws_s3_bucket_versioning', bucket).some((c) =>
    /\bstatus\s*=\s*"Enabled"/.test(c.body));
}

function s3HasLogging(model, bucket) {
  if (childBlocks(model, bucket, 'logging').length > 0) return true;
  return companionsFor(model, 'aws_s3_bucket_logging', bucket).length > 0;
}

function s3HasEncryption(model, bucket) {
  if (childBlocks(model, bucket, 'server_side_encryption_configuration').length > 0) return true;
  return companionsFor(model, 'aws_s3_bucket_server_side_encryption_configuration', bucket).length > 0;
}

// ─── rule table ───────────────────────────────────────────────────────────────

const SECRET_ATTRIBUTE_NAMES = new Set([
  'password', 'master_password', 'secret', 'secret_key', 'secret_string',
  'api_key', 'private_key', 'access_token', 'token',
]);

const DB_PORTS = [3306, 5432, 1433, 27017, 6379];

const RULES = [
  // ── network ──────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_25', severity: 'CRITICAL',
    message: 'Security group should not allow ingress from 0.0.0.0/0 to port 22 (SSH)',
    fix: 'Restrict cidr_blocks to a bastion or VPN CIDR, or use SSM Session Manager and remove SSH entirely.',
    subjects: (m) => ingressRules(m),
    violated: (r) => coversPort(r, 22),
  },
  {
    id: 'CKV_AWS_24', severity: 'CRITICAL',
    message: 'Security group should not allow ingress from 0.0.0.0/0 to port 3389 (RDP)',
    fix: 'Restrict cidr_blocks to a bastion or VPN CIDR, or use a Session Manager / Fleet Manager connection instead of RDP.',
    subjects: (m) => ingressRules(m),
    violated: (r) => coversPort(r, 3389),
  },
  {
    id: 'TFGEN_SG_DB_PORT_OPEN', severity: 'HIGH',
    message: 'Security group should not expose a database port (3306/5432/1433/27017/6379) to 0.0.0.0/0',
    fix: 'Limit the rule to the application security group (security_groups / referenced_security_group_id) instead of a CIDR.',
    subjects: (m) => ingressRules(m),
    violated: (r) => DB_PORTS.some((p) => coversPort(r, p)),
  },

  // ── S3 (inline blocks OR the modern companion resources) ─────────────────
  {
    id: 'CKV_AWS_18', severity: 'HIGH',
    message: 'S3 bucket should have access logging enabled',
    fix: 'Add a logging {} block, or an aws_s3_bucket_logging resource that references this bucket.',
    subjects: (m) => ofType(m, 'aws_s3_bucket'),
    violated: (b, m) => !s3HasLogging(m, b),
  },
  {
    id: 'CKV_AWS_21', severity: 'HIGH',
    message: 'S3 bucket should have versioning enabled',
    fix: 'Set versioning { enabled = true }, or add an aws_s3_bucket_versioning resource with status = "Enabled".',
    subjects: (m) => ofType(m, 'aws_s3_bucket'),
    violated: (b, m) => !s3HasVersioning(m, b),
  },
  {
    id: 'CKV_AWS_19', severity: 'HIGH',
    message: 'S3 bucket should have server-side encryption enabled',
    fix: 'Add server_side_encryption_configuration, or an aws_s3_bucket_server_side_encryption_configuration resource for this bucket.',
    subjects: (m) => ofType(m, 'aws_s3_bucket'),
    violated: (b, m) => !s3HasEncryption(m, b),
  },

  // ── EC2 ──────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_8', severity: 'MEDIUM',
    message: 'EC2 instance should have encrypted EBS root volume',
    fix: 'Set encrypted = true inside root_block_device {}.',
    subjects: (m) => ofType(m, 'aws_instance'),
    violated: (b) => !/\bencrypted\s*=\s*true\b/.test(b.body),
  },
  {
    id: 'CKV_AWS_135', severity: 'MEDIUM',
    message: 'EC2 instance should have detailed monitoring enabled',
    fix: 'Set monitoring = true.',
    autofix: { attribute: 'monitoring', value: 'true' },
    subjects: (m) => ofType(m, 'aws_instance'),
    violated: (b, m) => attrsOf(m, b).monitoring?.value !== 'true',
  },

  // ── KMS (rotation is only supported for symmetric keys) ──────────────────
  {
    id: 'CKV_AWS_7', severity: 'HIGH',
    message: 'KMS key should have key rotation enabled',
    fix: 'Set enable_key_rotation = true (rotation applies to symmetric keys only).',
    autofix: { attribute: 'enable_key_rotation', value: 'true' },
    subjects: (m) => ofType(m, 'aws_kms_key').filter((k) => {
      const spec = stringLiteral(attrsOf(m, k).customer_master_key_spec?.value);
      return !spec || spec === 'SYMMETRIC_DEFAULT';
    }),
    violated: (b, m) => attrsOf(m, b).enable_key_rotation?.value !== 'true',
  },

  // ── RDS ──────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_16', severity: 'HIGH',
    message: 'RDS instance should have encryption at rest enabled',
    fix: 'Set storage_encrypted = true (and a kms_key_id if you need a customer-managed key).',
    autofix: { attribute: 'storage_encrypted', value: 'true' },
    subjects: (m) => ofType(m, 'aws_db_instance'),
    violated: (b, m) => attrsOf(m, b).storage_encrypted?.value !== 'true',
  },
  {
    id: 'CKV_AWS_17', severity: 'HIGH',
    message: 'RDS instance should not be publicly accessible',
    fix: 'Set publicly_accessible = false and reach the database through private subnets.',
    autofix: { attribute: 'publicly_accessible', value: 'false' },
    subjects: (m) => ofType(m, 'aws_db_instance'),
    violated: (b, m) => attrsOf(m, b).publicly_accessible?.value === 'true',
  },

  // ── load balancing ───────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_2', severity: 'HIGH',
    message: 'ALB listener should use HTTPS (port 443), not plain HTTP on port 80',
    fix: 'Listen on 443 with a certificate, or keep port 80 only as a default_action of type "redirect" to HTTPS.',
    subjects: (m) => [...ofType(m, 'aws_alb_listener'), ...ofType(m, 'aws_lb_listener')],
    violated: (b, m) => {
      const raw = attrsOf(m, b).port?.value ?? '';
      const port = stringLiteral(raw) ?? raw;
      if (port !== '80') return false; // exact match: 8080 and 8000 are not HTTP 80
      return !/\btype\s*=\s*"redirect"/.test(b.body);
    },
  },

  // ── logging / audit ──────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_91', severity: 'MEDIUM',
    message: 'CloudTrail should have log file validation enabled',
    fix: 'Set enable_log_file_validation = true.',
    autofix: { attribute: 'enable_log_file_validation', value: 'true' },
    subjects: (m) => ofType(m, 'aws_cloudtrail'),
    violated: (b, m) => attrsOf(m, b).enable_log_file_validation?.value !== 'true',
  },

  // ── EKS ──────────────────────────────────────────────────────────────────
  {
    id: 'CKV_AWS_65', severity: 'MEDIUM',
    message: 'EKS cluster should have secrets encryption enabled',
    fix: 'Add an encryption_config {} block with a KMS key ARN for "secrets".',
    subjects: (m) => ofType(m, 'aws_eks_cluster'),
    violated: (b, m) => childBlocks(m, b, 'encryption_config').length === 0,
  },

  // ── credentials in code (applies to every resource) ──────────────────────
  {
    id: 'TFGEN_HARDCODED_CREDENTIAL', severity: 'CRITICAL',
    message: 'Credential-like attribute is set to a literal string in resource code',
    fix: 'Move the value to a sensitive input variable, or read it from Secrets Manager / SSM Parameter Store.',
    subjects: (m) => m.resources.flatMap((r) =>
      Object.values(attrsOf(m, r))
        .filter((a) => SECRET_ATTRIBUTE_NAMES.has(a.name))
        .map((a) => ({ address: r.address, line: a.line, attr: a }))),
    violated: (s) => {
      const literal = stringLiteral(s.attr.value);
      return literal !== null && literal.length > 0;
    },
  },
];

// ─── evaluation ───────────────────────────────────────────────────────────────

const GUIDELINE_BASE = 'https://docs.bridgecrew.io/docs/';

function toFinding(rule, subject) {
  const address = subject.address || subject.owner || subject.resource || rule.id;
  const finding = {
    check_id: rule.id,
    resource: address,
    severity: rule.severity,
    message: rule.message,
    line: subject.line ?? null,
    fix: rule.fix,
    guideline_url: rule.id.startsWith('CKV_') ? `${GUIDELINE_BASE}${rule.id.toLowerCase()}` : null,
  };
  if (rule.autofix) {
    finding.autofix = { resource: address, ...rule.autofix };
  }
  return finding;
}

/**
 * Runs every rule against `hcl`.
 * Returns { engine, passed, failed, total, rules, findings }.
 */
function evaluateStaticRules(hcl) {
  const model = buildModel(hcl);
  const findings = [];
  let total = 0;
  for (const rule of RULES) {
    const subjects = rule.subjects(model);
    if (subjects.length === 0) { total += 1; continue; } // nothing to check → vacuously passes
    total += subjects.length;
    for (const subject of subjects) {
      // Rules receive (subject, model); subject-based rules ignore the model.
      if (rule.violated(subject, model)) findings.push(toFinding(rule, subject));
    }
  }
  const failed = findings.length;
  return {
    engine: 'static',
    passed: total - failed,
    failed,
    total,
    rules: RULES.length,
    findings,
  };
}

module.exports = {
  evaluateStaticRules,
  // exported for unit tests and for codeReview's autofix engine
  RULES: RULES.map(({ id, severity, message, fix, autofix }) => ({ id, severity, message, fix, autofix })),
  buildModel,
  ingressRules,
};
