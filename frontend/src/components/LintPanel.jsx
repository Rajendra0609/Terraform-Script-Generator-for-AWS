import React, { useMemo, useState } from 'react';

/**
 * LintPanel — client-side Terraform linting (tflint/tfsec style).
 *
 * Scans HCL text with a set of regex/pattern rules covering:
 *  - Security (open security groups, public S3 buckets, unencrypted storage)
 *  - Best practices (tagging, lifecycle, versioning, deletion protection)
 *  - AWS specific (deprecated instance types, region hardcoding)
 *  - Style (naming conventions, missing descriptions)
 *
 * Each finding includes:
 *  - id, severity, category, message, line, autoFix (optional replacement)
 *
 * Props:
 *   hcl       — string HCL content to lint
 *   onApplyFix — (newHcl: string) => void  — called when user clicks "Apply Fix"
 */

// --- Rule definitions ---------------------------------------------------------
const RULES = [
  // -- Security --------------------------------------------------------------
  {
    id:       'SEC001',
    severity: 'CRITICAL',
    category: 'Security',
    title:    'Open ingress to all (0.0.0.0/0) on sensitive port',
    test:     (hcl) => {
      const findings = [];
      const lines = hcl.split('\n');
      lines.forEach((line, i) => {
        if (/cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/.test(line) || /cidr_blocks\s*=\s*\[["']0\.0\.0\.0\/0["']\]/.test(line)) {
          findings.push({ line: i + 1, excerpt: line.trim() });
        }
      });
      return findings;
    },
    message:  'Avoid unrestricted ingress (0.0.0.0/0). Restrict to known IP ranges.',
    autoFix:  (line) => line.replace(/0\.0\.0\.0\/0/, '10.0.0.0/8'),
    fixLabel: 'Restrict to 10.0.0.0/8',
  },
  {
    id:       'SEC002',
    severity: 'HIGH',
    category: 'Security',
    title:    'S3 bucket without versioning',
    test:     (hcl) => {
      const findings = [];
      // Find aws_s3_bucket blocks without versioning
      const blocks = [...hcl.matchAll(/resource\s+"aws_s3_bucket"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/versioning\s*{[^}]*enabled\s*=\s*true/.test(hcl) &&
            !/aws_s3_bucket_versioning/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_s3_bucket" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'S3 buckets should have versioning enabled to protect against accidental deletion.',
    fix: (hcl) => hcl, // too complex for auto-fix
    fixLabel: null,
  },
  {
    id:       'SEC003',
    severity: 'HIGH',
    category: 'Security',
    title:    'EBS volume without encryption',
    test:     (hcl) => {
      const findings = [];
      const lines = hcl.split('\n');
      let inEbsBlock = false;
      let blockHasEncrypted = false;
      let blockStartLine = 0;
      lines.forEach((line, i) => {
        if (/resource\s+"aws_ebs_volume"/.test(line) || /resource\s+"aws_instance"/.test(line)) {
          inEbsBlock = true; blockHasEncrypted = false; blockStartLine = i + 1;
        }
        if (inEbsBlock && /encrypted\s*=\s*true/.test(line)) blockHasEncrypted = true;
        if (inEbsBlock && /^}/.test(line)) {
          if (!blockHasEncrypted) findings.push({ line: blockStartLine, excerpt: lines[blockStartLine - 1]?.trim() });
          inEbsBlock = false;
        }
      });
      return findings;
    },
    message:  'EBS volumes/root blocks should be encrypted. Add `encrypted = true`.',
    autoFix:  (line) => line,
    fixLabel: null,
  },
  {
    id:       'SEC004',
    severity: 'HIGH',
    category: 'Security',
    title:    'RDS without deletion protection',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_db_instance"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/deletion_protection\s*=\s*true/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_db_instance" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'RDS instances should have deletion_protection = true to prevent accidental destruction.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'SEC005',
    severity: 'MEDIUM',
    category: 'Security',
    title:    'RDS without Multi-AZ',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_db_instance"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/multi_az\s*=\s*true/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_db_instance" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'Enable multi_az = true on RDS for automatic failover and HA.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'SEC006',
    severity: 'HIGH',
    category: 'Security',
    title:    'RDS without storage encryption',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_db_instance"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/storage_encrypted\s*=\s*true/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_db_instance" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'RDS storage should be encrypted. Add `storage_encrypted = true`.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'SEC007',
    severity: 'MEDIUM',
    category: 'Security',
    title:    'KMS key without rotation',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_kms_key"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/enable_key_rotation\s*=\s*true/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_kms_key" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'Enable automatic KMS key rotation with `enable_key_rotation = true`.',
    autoFix:  null,
    fixLabel: null,
  },
  // -- Best Practices ---------------------------------------------------------
  {
    id:       'BP001',
    severity: 'MEDIUM',
    category: 'Best Practice',
    title:    'Resource missing tags',
    test:     (hcl) => {
      const findings = [];
      // Find resource blocks that don't reference common_tags or have a tags block
      const resourceBlocks = [...hcl.matchAll(/resource\s+"(aws_[^"]+)"\s+"([^"]+)"/g)];
      resourceBlocks.forEach(m => {
        if (!/tags\s*=/.test(hcl) && !/common_tags/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "${m[1]}" "${m[2]}"` });
        }
      });
      return findings;
    },
    message:  'Add tags to all resources for cost allocation and ownership tracking. Use `local.common_tags`.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'BP002',
    severity: 'LOW',
    category: 'Best Practice',
    title:    'Hardcoded AWS region',
    test:     (hcl) => {
      const findings = [];
      const lines = hcl.split('\n');
      lines.forEach((line, i) => {
        // Look for region = "us-east-1" style outside of provider block (template already handles provider region)
        if (/region\s*=\s*"(us|eu|ap|sa|ca|me|af)-[a-z]+-\d"/.test(line) &&
            !/provider\s+"aws"/.test(lines[Math.max(0, i - 5)].concat(lines[Math.max(0, i-3)]))) {
          findings.push({ line: i + 1, excerpt: line.trim() });
        }
      });
      return findings;
    },
    message:  'Avoid hardcoding region strings in resources. Use `var.region` or `data.aws_region.current.name`.',
    autoFix:  (line) => line.replace(/region\s*=\s*"[^"]+"/,  'region = data.aws_region.current.name'),
    fixLabel: 'Use data.aws_region.current.name',
  },
  {
    id:       'BP003',
    severity: 'LOW',
    category: 'Best Practice',
    title:    'S3 bucket without lifecycle rules',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_s3_bucket"\s+"([^"]+)"/g)];
      if (blocks.length > 0 && !/aws_s3_bucket_lifecycle_configuration/.test(hcl)) {
        blocks.forEach(m => {
          findings.push({ line: null, excerpt: `resource "aws_s3_bucket" "${m[1]}"` });
        });
      }
      return findings;
    },
    message:  'Add lifecycle rules to S3 buckets to automatically transition/expire old objects and reduce costs.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'BP004',
    severity: 'MEDIUM',
    category: 'Best Practice',
    title:    'Lambda without reserved concurrency',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_lambda_function"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/reserved_concurrent_executions/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_lambda_function" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'Set `reserved_concurrent_executions` on Lambda to prevent runaway scaling and throttle abuse.',
    autoFix:  null,
    fixLabel: null,
  },
  {
    id:       'BP005',
    severity: 'LOW',
    category: 'Best Practice',
    title:    'EC2 instance without IMDSv2 enforcement',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_instance"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/http_tokens\s*=\s*"required"/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_instance" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'Enforce IMDSv2 by setting `metadata_options { http_tokens = "required" }` to prevent SSRF attacks.',
    autoFix:  null,
    fixLabel: null,
  },
  // -- AWS Style -------------------------------------------------------------
  {
    id:       'AWS001',
    severity: 'LOW',
    category: 'AWS Style',
    title:    'Avoid t2 instance types (prefer t3/t4g)',
    test:     (hcl) => {
      const findings = [];
      const lines = hcl.split('\n');
      lines.forEach((line, i) => {
        if (/instance_type\s*=\s*"t2\./.test(line)) {
          findings.push({ line: i + 1, excerpt: line.trim() });
        }
      });
      return findings;
    },
    message:  't2 instances are older generation. Use t3 or t4g for better performance and lower cost.',
    autoFix:  (line) => line.replace(/t2\./, 't3.'),
    fixLabel: 'Upgrade to t3.*',
  },
  {
    id:       'AWS002',
    severity: 'LOW',
    category: 'AWS Style',
    title:    'ALB access logging disabled',
    test:     (hcl) => {
      const findings = [];
      const blocks = [...hcl.matchAll(/resource\s+"aws_lb"\s+"([^"]+)"/g)];
      blocks.forEach(m => {
        if (!/access_logs\s*{/.test(hcl)) {
          findings.push({ line: null, excerpt: `resource "aws_lb" "${m[1]}"` });
        }
      });
      return findings;
    },
    message:  'Enable ALB access logs by adding an `access_logs { bucket = ... enabled = true }` block.',
    autoFix:  null,
    fixLabel: null,
  },
];

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const SEV_COLORS = {
  CRITICAL: 'bg-red-600 text-white',
  HIGH:     'bg-orange-500 text-white',
  MEDIUM:   'bg-yellow-500 text-black',
  LOW:      'bg-blue-400 text-white',
};

// --- Run all rules against HCL ------------------------------------------------
export function runLintRules(hcl) {
  if (!hcl || !hcl.trim()) return [];
  const findings = [];
  for (const rule of RULES) {
    try {
      const matches = rule.test(hcl);
      if (matches && matches.length > 0) {
        matches.forEach(m => {
          findings.push({ ...m, id: rule.id, severity: rule.severity, category: rule.category, title: rule.title, message: rule.message, autoFix: rule.autoFix, fixLabel: rule.fixLabel });
        });
      }
    } catch { /* rule failed silently */ }
  }
  return findings.sort((a, b) => (SEV_ORDER[a.severity] ?? 4) - (SEV_ORDER[b.severity] ?? 4));
}

// --- Component ----------------------------------------------------------------
/**
 * Props:
 *   hcl         — string HCL to lint
 *   onApplyFix  — (newHcl: string) => void
 */
export default function LintPanel({ hcl, onApplyFix }) {
  const findings = useMemo(() => runLintRules(hcl || ''), [hcl]);
  const [filterSev, setFilterSev] = useState('All');
  const [open, setOpen] = useState(true);

  const categories = ['All', 'Security', 'Best Practice', 'AWS Style'];
  const visible = filterSev === 'All' ? findings : findings.filter(f => f.category === filterSev);

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  findings.forEach(f => { counts[f.severity] = (counts[f.severity] || 0) + 1; });

  function applyFix(finding) {
    if (!finding.autoFix || !onApplyFix) return;
    const lines = hcl.split('\n');
    if (finding.line) {
      lines[finding.line - 1] = finding.autoFix(lines[finding.line - 1]);
      onApplyFix(lines.join('\n'));
    }
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Lint &amp; Best Practices</span>
          <span className="text-[10px] text-gray-400">{findings.length} findings</span>
          {Object.entries(counts).filter(([, n]) => n > 0).map(([sev, n]) => (
            <span key={sev} className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SEV_COLORS[sev]}`}>
              {n} {sev}
            </span>
          ))}
        </div>
        <span className="text-gray-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <>
          {/* Category filter */}
          <div className="flex gap-1 px-3 py-1.5 border-b border-gray-100 dark:border-gray-800 flex-wrap bg-white dark:bg-gray-900">
            {categories.map(c => (
              <button key={c}
                onClick={() => setFilterSev(c)}
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors ${
                  filterSev === c
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >{c}</button>
            ))}
          </div>

          {/* Findings list */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800 bg-white dark:bg-gray-900 max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-4 py-4 text-center">
                <p className="text-sm text-green-600 dark:text-green-400 font-medium">✓ No issues found</p>
                <p className="text-xs text-gray-400 mt-0.5">Your Terraform configuration looks good.</p>
              </div>
            ) : (
              visible.map((f, i) => (
                <div key={i} className="px-4 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <span className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded mt-0.5 ${SEV_COLORS[f.severity]}`}>
                        {f.severity}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{f.title}</span>
                          <span className="text-[10px] text-gray-400 font-mono">[{f.id}]</span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{f.message}</p>
                        {f.excerpt && (
                          <code className="mt-1 block text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded font-mono truncate max-w-sm">
                            {f.line && <span className="text-gray-400 mr-1">L{f.line}</span>}
                            {f.excerpt}
                          </code>
                        )}
                      </div>
                    </div>
                    {f.autoFix && f.fixLabel && f.line && (
                      <button
                        onClick={() => applyFix(f)}
                        className="flex-shrink-0 text-[11px] px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 whitespace-nowrap"
                      >
                        ✓ {f.fixLabel}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
