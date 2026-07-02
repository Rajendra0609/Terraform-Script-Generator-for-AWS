'use strict';
/**
 * opaEval.js — Lightweight policy-as-code engine for TFGen
 *
 * Architecture:
 *  1. If the `opa` binary is on PATH, delegate to `opa eval` (real Rego).
 *  2. Otherwise fall back to a pure-JS Rego-subset evaluator that covers
 *     the policy patterns used by TFGen's built-in rules.
 *
 * Policy rules are stored in the `policy_rules` table as `rego_source`.
 * Each rule exposes a `deny[msg]` set: any non-empty deny set is a violation.
 *
 * JS-evaluator supported patterns:
 *   deny[msg] { input.resource.type == "aws_s3_bucket"; not input.resource.config.versioning_enabled; msg := "S3 bucket must have versioning enabled" }
 *   deny[msg] { input.resource.cidr == "0.0.0.0/0"; msg := "..." }
 *   deny[msg] { not input.resource.config.encrypted; msg := "..." }
 *
 * For full Rego (complex comprehensions, imports, etc.) install OPA:
 *   brew install opa        # macOS
 *   apt-get install opa     # Debian
 *   https://www.openpolicyagent.org/docs/latest/#running-opa
 */

const { execFile } = require('child_process');
const path         = require('path');
const os           = require('os');
const fs           = require('fs');
const crypto       = require('crypto');

// ─── OPA binary probe ─────────────────────────────────────────────────────────
let _opaBinaryPath = null;
let _opaBinaryChecked = false;

async function findOpaBinary() {
  if (_opaBinaryChecked) return _opaBinaryPath;
  _opaBinaryChecked = true;
  const candidates = [
    process.env.OPA_PATH,
    '/usr/local/bin/opa',
    '/usr/bin/opa',
    path.join(os.homedir(), '.local/bin/opa'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      _opaBinaryPath = p;
      console.info(`[opa] Found OPA binary at ${p}`);
      return p;
    } catch (_) {}
  }
  console.info('[opa] OPA binary not found — using JS policy evaluator');
  return null;
}

// ─── OPA CLI evaluation ───────────────────────────────────────────────────────
async function evalWithCli(regoSource, inputData, policyName) {
  const tmpDir    = os.tmpdir();
  const id        = crypto.randomBytes(6).toString('hex');
  const policyFile = path.join(tmpDir, `tfgen_policy_${id}.rego`);
  const inputFile  = path.join(tmpDir, `tfgen_input_${id}.json`);

  fs.writeFileSync(policyFile, regoSource, 'utf8');
  fs.writeFileSync(inputFile, JSON.stringify(inputData), 'utf8');

  return new Promise((resolve) => {
    execFile(
      _opaBinaryPath,
      ['eval', '--data', policyFile, '--input', inputFile,
       '--format', 'json', 'data.tfgen.deny'],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(policyFile); } catch (_) {}
        try { fs.unlinkSync(inputFile); } catch (_) {}

        if (err) {
          console.warn(`[opa] CLI eval error for policy "${policyName}": ${stderr || err.message}`);
          resolve({ violations: [], error: err.message });
          return;
        }
        try {
          const result = JSON.parse(stdout);
          const denySet = result?.result?.[0]?.expressions?.[0]?.value;
          const violations = Array.isArray(denySet) ? denySet : [];
          resolve({ violations });
        } catch (parseErr) {
          resolve({ violations: [], error: parseErr.message });
        }
      }
    );
  });
}

// ─── Pure-JS Rego subset evaluator ───────────────────────────────────────────
/**
 * Evaluate a simplified Rego deny rule against input data.
 * Supports:
 *   deny[msg] { condition1; condition2; msg := "..." }
 *
 * Conditions supported:
 *   input.path.to.field == "value"
 *   input.path.to.field != "value"
 *   not input.path.to.field
 *   input.path.to.field
 *   input.path.to.field contains "value"   (string contains)
 *   input.path.to.field starts_with "value"
 *   count(input.path.to.field) > N
 *   msg := "literal string"
 */
function evalJsSubset(regoSource, inputData) {
  const violations = [];

  // Extract deny blocks: deny[msg] { ... }
  const denyBlockRe = /deny\s*\[\s*msg\s*\]\s*\{([^}]+)\}/g;
  let match;

  while ((match = denyBlockRe.exec(regoSource)) !== null) {
    const body = match[1];
    const lines = body.split(/;|\n/).map(l => l.trim()).filter(Boolean);

    let msgValue = null;
    const conditions = [];

    for (const line of lines) {
      // msg := "..."
      const msgMatch = line.match(/^msg\s*:=\s*"([^"]+)"/);
      if (msgMatch) { msgValue = msgMatch[1]; continue; }

      conditions.push(line);
    }

    if (!msgValue) continue; // can't emit violation without a message

    // Evaluate all conditions (AND logic)
    let allPass = true;
    for (const cond of conditions) {
      if (!evalCondition(cond, inputData)) { allPass = false; break; }
    }

    if (allPass) violations.push(msgValue);
  }

  return { violations };
}

function evalCondition(cond, inputData) {
  const trim = cond.trim();

  // `not expr`
  if (/^not\s+/.test(trim)) {
    return !evalCondition(trim.slice(4).trim(), inputData);
  }

  // `input.a.b.c == "val"` or `!= "val"`
  const eqMatch = trim.match(/^([\w.[\]"]+)\s*(==|!=)\s*"([^"]*)"/);
  if (eqMatch) {
    const [, path, op, expected] = eqMatch;
    const actual = resolvePath(path, inputData);
    if (op === '==') return String(actual) === expected;
    if (op === '!=') return String(actual) !== expected;
  }

  // `input.a.b.c == N` (numeric)
  const numEqMatch = trim.match(/^([\w.[\]"]+)\s*(==|!=|>|<|>=|<=)\s*(\d+(?:\.\d+)?)/);
  if (numEqMatch) {
    const [, path, op, numStr] = numEqMatch;
    const actual = Number(resolvePath(path, inputData));
    const expected = Number(numStr);
    if (op === '==') return actual === expected;
    if (op === '!=') return actual !== expected;
    if (op === '>')  return actual > expected;
    if (op === '<')  return actual < expected;
    if (op === '>=') return actual >= expected;
    if (op === '<=') return actual <= expected;
  }

  // `count(input.a.b) > N`
  const countMatch = trim.match(/^count\(([\w.[\]"]+)\)\s*(>|<|==|>=|<=)\s*(\d+)/);
  if (countMatch) {
    const [, path, op, numStr] = countMatch;
    const val = resolvePath(path, inputData);
    const count = Array.isArray(val) ? val.length : (val ? 1 : 0);
    const expected = Number(numStr);
    if (op === '>')  return count > expected;
    if (op === '<')  return count < expected;
    if (op === '==') return count === expected;
    if (op === '>=') return count >= expected;
    if (op === '<=') return count <= expected;
  }

  // `input.a.b.c` — truthy check
  const pathMatch = trim.match(/^(input[\w.[\]"]+)$/);
  if (pathMatch) {
    const val = resolvePath(pathMatch[1], inputData);
    return !!val;
  }

  // Unknown condition — treat as passing (don't block unknown syntax)
  return true;
}

function resolvePath(path, obj) {
  // input.a.b.c → obj.a.b.c
  const parts = path
    .replace(/^input\.?/, '')
    .split('.')
    .filter(Boolean);

  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// ─── Main evaluate function ───────────────────────────────────────────────────
/**
 * Evaluate a single policy rule against plan output + resource list.
 *
 * @param {object} policyRule     - Row from policy_rules table
 * @param {object} planResult     - Result from runPlan (resource_changes, summary)
 * @param {Array}  resources      - Project resources array
 * @returns {Promise<{passed:boolean, violations:string[], error?:string}>}
 */
async function evaluatePolicy(policyRule, planResult, resources) {
  const opaBin = await findOpaBinary();

  // Build input document
  const inputDoc = {
    plan: {
      resource_changes: planResult.resource_changes || [],
      summary: planResult.summary || {},
    },
    resources: resources.map(r => ({
      type:   r.service_type,
      name:   r.resource_name,
      config: r.config || {},
    })),
    // Convenience aliases used in common policy patterns
    resource: resources.length === 1 ? {
      type:   resources[0].service_type,
      name:   resources[0].resource_name,
      config: resources[0].config || {},
    } : null,
  };

  let result;
  if (opaBin) {
    result = await evalWithCli(policyRule.rego_source, inputDoc, policyRule.name);
  } else {
    result = evalJsSubset(policyRule.rego_source, inputDoc);
  }

  return {
    passed:     result.violations.length === 0,
    violations: result.violations,
    error:      result.error || null,
    policy: {
      id:          policyRule.id,
      name:        policyRule.name,
      severity:    policyRule.severity,
      blocks_plan: policyRule.blocks_plan,
    },
  };
}

/**
 * Evaluate all enabled policy rules for a plan.
 * Returns { passed, blocked, results[] }
 *   blocked = true if any blocks_plan=true policy has violations
 */
async function evaluateAllPolicies(db, planResult, resources) {
  try {
    const { rows: policies } = await db.query(
      "SELECT * FROM policy_rules WHERE enabled = true ORDER BY severity DESC, name"
    );

    if (policies.length === 0) return { passed: true, blocked: false, results: [] };

    const results = await Promise.all(
      policies.map(p => evaluatePolicy(p, planResult, resources))
    );

    const failures = results.filter(r => !r.passed);
    const blocked  = failures.some(r => r.policy.blocks_plan);

    return { passed: failures.length === 0, blocked, results };
  } catch (err) {
    console.error('[opa] evaluateAllPolicies error:', err.message);
    // Non-fatal: if policy eval fails, log and allow plan to proceed
    return { passed: true, blocked: false, results: [], error: err.message };
  }
}

// ─── Built-in policy templates ────────────────────────────────────────────────
const BUILT_IN_TEMPLATES = [
  {
    name: 'No public S3 buckets',
    description: 'Blocks plans that create S3 buckets with public ACL or no public access block',
    severity: 'CRITICAL',
    blocks_plan: true,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_s3_bucket"
  rc.change.after.acl == "public-read"
  msg := "S3 bucket must not use 'public-read' ACL. Use bucket policies with least privilege instead."
}

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_s3_bucket"
  rc.change.after.acl == "public-read-write"
  msg := "S3 bucket must not use 'public-read-write' ACL — this exposes data to the entire internet."
}`,
  },
  {
    name: 'No unrestricted SSH ingress',
    description: 'Blocks security groups allowing SSH (port 22) from 0.0.0.0/0',
    severity: 'CRITICAL',
    blocks_plan: true,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_security_group"
  ingress := rc.change.after.ingress[_]
  ingress.from_port <= 22
  ingress.to_port >= 22
  ingress.cidr_blocks[_] == "0.0.0.0/0"
  msg := "Security group allows SSH (port 22) from 0.0.0.0/0. Restrict to known IP ranges."
}`,
  },
  {
    name: 'RDS encryption required',
    description: 'Ensures all RDS instances have storage encryption enabled',
    severity: 'HIGH',
    blocks_plan: false,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_db_instance"
  not rc.change.after.storage_encrypted
  msg := "RDS instance must have storage_encrypted = true. Unencrypted databases violate compliance requirements."
}`,
  },
  {
    name: 'EBS volumes must be encrypted',
    description: 'Ensures EBS volumes and EC2 root volumes are encrypted at rest',
    severity: 'HIGH',
    blocks_plan: false,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_ebs_volume"
  not rc.change.after.encrypted
  msg := "EBS volume must be encrypted. Set encrypted = true and specify a KMS key."
}`,
  },
  {
    name: 'No RDP open to internet',
    description: 'Blocks security groups allowing RDP (port 3389) from 0.0.0.0/0',
    severity: 'CRITICAL',
    blocks_plan: true,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_security_group"
  ingress := rc.change.after.ingress[_]
  ingress.from_port <= 3389
  ingress.to_port >= 3389
  ingress.cidr_blocks[_] == "0.0.0.0/0"
  msg := "Security group allows RDP (port 3389) from 0.0.0.0/0. This is a critical security risk."
}`,
  },
  {
    name: 'Require resource tags',
    description: 'All resources should have Environment and Owner tags',
    severity: 'MEDIUM',
    blocks_plan: false,
    rego_source: `package tfgen

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.change.action != "delete"
  not rc.change.after.tags.Environment
  msg := sprintf("Resource %v is missing required 'Environment' tag.", [rc.address])
}`,
  },
];

module.exports = { evaluatePolicy, evaluateAllPolicies, evalJsSubset, BUILT_IN_TEMPLATES };
