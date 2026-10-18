/**
 * tests/unit/backend/static-rules.test.js
 *
 * Regression tests for the four defects fixed in services/staticSecurityRules.js
 * (negative `passed` count, companion-resource S3 false positives, ALB port
 * matching, cross-block security-group false positives), plus coverage of each
 * rule's compliant and non-compliant forms.
 */
'use strict';
const path = require('path');
const { evaluateStaticRules, ingressRules, buildModel } = require(
  path.join(__dirname, '../../../backend/services/staticSecurityRules')
);
const { runStaticCheckov } = require(path.join(__dirname, '../../../backend/services/checkov'));

const ids = (hcl) => evaluateStaticRules(hcl).findings.map((f) => f.check_id);

describe('defect 1: passed/failed accounting', () => {
  test('passed is never negative, even with many violations', () => {
    const hcl = Array.from({ length: 20 }, (_, i) =>
      `resource "aws_s3_bucket" "b${i}" {\n  bucket = "x${i}"\n}\n`).join('\n');
    const r = evaluateStaticRules(hcl);
    expect(r.failed).toBe(60); // 20 buckets × 3 S3 rules
    expect(r.passed).toBeGreaterThanOrEqual(0);
    expect(r.passed + r.failed).toBe(r.total);
  });

  test('a clean file reports every rule as passing', () => {
    const r = evaluateStaticRules('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n');
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
  });
});

describe('defect 2: S3 companion resources count as compliant', () => {
  const modern = `
resource "aws_s3_bucket" "logs" {
  bucket = "secure-logs"
}
resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}
resource "aws_s3_bucket_logging" "logs" {
  bucket = aws_s3_bucket.logs.id
  target_bucket = "audit"
}`;

  test('modern split configuration produces no S3 findings', () => {
    expect(ids(modern).filter((id) => ['CKV_AWS_18', 'CKV_AWS_19', 'CKV_AWS_21'].includes(id))).toEqual([]);
  });

  test('companion resource that points at a different bucket does not count', () => {
    const hcl = `
resource "aws_s3_bucket" "data" {
  bucket = "data"
}
resource "aws_s3_bucket_versioning" "other" {
  bucket = aws_s3_bucket.other.id
  versioning_configuration { status = "Enabled" }
}`;
    expect(ids(hcl)).toContain('CKV_AWS_21');
  });

  test('versioning present but suspended is still a finding', () => {
    const hcl = `
resource "aws_s3_bucket" "x" {
  bucket = "x"
}
resource "aws_s3_bucket_versioning" "x" {
  bucket = aws_s3_bucket.x.id
  versioning_configuration { status = "Suspended" }
}`;
    expect(ids(hcl)).toContain('CKV_AWS_21');
  });

  test('legacy inline blocks are still accepted (existing behaviour)', () => {
    const hcl = `resource "aws_s3_bucket" "enc_ok" {
  bucket = "secure-bucket"
  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    }
  }
  versioning { enabled = true }
  logging { target_bucket = "log-bucket" }
}`;
    expect(ids(hcl).filter((id) => ['CKV_AWS_18', 'CKV_AWS_19', 'CKV_AWS_21'].includes(id))).toEqual([]);
  });

  test('legacy inline versioning with enabled = false is a finding', () => {
    const hcl = `resource "aws_s3_bucket" "x" {\n  bucket = "x"\n  versioning { enabled = false }\n}`;
    expect(ids(hcl)).toContain('CKV_AWS_21');
  });
});

describe('defect 3: ALB port matching is exact, redirects are allowed', () => {
  test('port 8080 is not reported as HTTP port 80', () => {
    expect(ids('resource "aws_alb_listener" "app" {\n  port = 8080\n  protocol = "HTTPS"\n}')).not.toContain('CKV_AWS_2');
  });

  test('port 80 that only redirects to HTTPS is compliant', () => {
    const hcl = 'resource "aws_lb_listener" "http" {\n  port = 80\n  default_action {\n    type = "redirect"\n  }\n}';
    expect(ids(hcl)).not.toContain('CKV_AWS_2');
  });

  test('port 80 that forwards traffic is reported', () => {
    const hcl = 'resource "aws_lb_listener" "http" {\n  port = 80\n  default_action {\n    type = "forward"\n  }\n}';
    expect(ids(hcl)).toContain('CKV_AWS_2');
  });
});

describe('defect 4: security-group rules are evaluated per rule, not per file', () => {
  test('SSH open only to a private CIDR is not flagged, even with 0.0.0.0/0 egress elsewhere', () => {
    const hcl = `
resource "aws_security_group" "private" {
  ingress {
    from_port = 22
    to_port = 22
    protocol = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}
resource "aws_security_group" "web" {
  egress {
    from_port = 0
    to_port = 0
    protocol = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`;
    expect(ids(hcl)).not.toContain('CKV_AWS_25');
  });

  test('SSH open to the world is flagged with the line of the offending ingress block', () => {
    const hcl = 'resource "aws_security_group" "bad_sg" {\n  name = "bad"\n  ingress {\n    from_port   = 22\n    to_port     = 22\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}';
    const f = evaluateStaticRules(hcl).findings.find((x) => x.check_id === 'CKV_AWS_25');
    expect(f).toBeDefined();
    expect(f.line).toBe(3);
    expect(f.severity).toBe('CRITICAL');
  });

  test('an all-protocols rule open to the world covers SSH, RDP and database ports', () => {
    const hcl = 'resource "aws_vpc_security_group_ingress_rule" "all" {\n  ip_protocol = "-1"\n  cidr_ipv4   = "0.0.0.0/0"\n}';
    expect(ids(hcl)).toEqual(expect.arrayContaining(['CKV_AWS_25', 'CKV_AWS_24', 'TFGEN_SG_DB_PORT_OPEN']));
  });

  test('a port range that includes 22 is flagged; a range that excludes it is not', () => {
    const inRange = 'resource "aws_security_group_rule" "r" {\n  type = "ingress"\n  from_port = 0\n  to_port = 1024\n  protocol = "tcp"\n  cidr_blocks = ["0.0.0.0/0"]\n}';
    const outRange = 'resource "aws_security_group_rule" "r" {\n  type = "ingress"\n  from_port = 80\n  to_port = 443\n  protocol = "tcp"\n  cidr_blocks = ["0.0.0.0/0"]\n}';
    expect(ids(inRange)).toContain('CKV_AWS_25');
    expect(ids(outRange)).not.toContain('CKV_AWS_25');
  });

  test('ports supplied by variables are unknown and do not produce false positives', () => {
    const hcl = 'resource "aws_security_group" "s" {\n  ingress {\n    from_port = var.port\n    to_port = var.port\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}';
    expect(ids(hcl)).not.toContain('CKV_AWS_25');
  });
});

describe('rule coverage', () => {
  test('RDS: unencrypted and publicly accessible instances are both flagged, with autofix metadata', () => {
    const r = evaluateStaticRules('resource "aws_db_instance" "db" {\n  publicly_accessible = true\n}');
    const ids2 = r.findings.map((f) => f.check_id);
    expect(ids2).toEqual(expect.arrayContaining(['CKV_AWS_16', 'CKV_AWS_17']));
    expect(r.findings.find((f) => f.check_id === 'CKV_AWS_17').autofix)
      .toEqual({ resource: 'aws_db_instance.db', attribute: 'publicly_accessible', value: 'false' });
  });

  test('KMS: asymmetric keys are not subject to the rotation rule', () => {
    expect(ids('resource "aws_kms_key" "k" {\n  customer_master_key_spec = "RSA_2048"\n}')).not.toContain('CKV_AWS_7');
  });

  test('EKS: secrets encryption required', () => {
    expect(ids('resource "aws_eks_cluster" "c" {\n  name = "c"\n}')).toContain('CKV_AWS_65');
    expect(ids('resource "aws_eks_cluster" "c" {\n  encryption_config {\n    resources = ["secrets"]\n  }\n}')).not.toContain('CKV_AWS_65');
  });

  test('hard-coded credentials are critical; variable references are not', () => {
    const bad = evaluateStaticRules('resource "aws_db_instance" "db" {\n  password = "hunter2"\n}');
    const f = bad.findings.find((x) => x.check_id === 'TFGEN_HARDCODED_CREDENTIAL');
    expect(f).toBeDefined();
    expect(f.severity).toBe('CRITICAL');
    expect(f.line).toBe(2);
    expect(ids('resource "aws_db_instance" "db" {\n  password = var.db_password\n}')).not.toContain('TFGEN_HARDCODED_CREDENTIAL');
  });

  test('commented-out insecure settings are ignored', () => {
    const hcl = 'resource "aws_db_instance" "db" {\n  # publicly_accessible = true\n  storage_encrypted = true\n}';
    expect(ids(hcl)).not.toContain('CKV_AWS_17');
  });

  test('ingressRules() exposes normalised rules for the code-review service', () => {
    const rules = ingressRules(buildModel('resource "aws_security_group" "s" {\n  ingress {\n    from_port = 22\n    to_port = 22\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}'));
    expect(rules).toEqual([expect.objectContaining({ owner: 'aws_security_group.s', openToWorld: true, fromPort: 22, toPort: 22 })]);
  });
});

describe('runCheckov static wrapper keeps the public contract', () => {
  test('runStaticCheckov returns engine/passed/failed/total/findings', () => {
    const r = runStaticCheckov('resource "aws_instance" "web" {\n  ami = "ami-1"\n}');
    expect(r).toEqual(expect.objectContaining({ engine: 'static' }));
    expect(typeof r.passed).toBe('number');
    expect(Array.isArray(r.findings)).toBe(true);
  });
});
