'use strict';

const router = require('express').Router();
const {
  EC2Client,
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeAvailabilityZonesCommand,
} = require('@aws-sdk/client-ec2');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const db = require('../db/connection');
const { DEFAULT_AWS_REGION } = require('../config/region');
const { audit, attachAuditResponseHook } = require('../middleware/audit');

// SECURITY FIX (L-12 follow-up): saving/rotating/removing AWS credentials is
// exactly the kind of sensitive action that should leave an audit trail —
// it wasn't previously wrapped with audit() at all, so no record of who
// changed a project's AWS credentials (or when) existed. Enabling the hook
// here means the /credentials mutations below get logged through the same,
// already-hardened sanitizeBodyForAudit() redaction (see middleware/audit.js
// for the REDACT_KEYS fix covering access_key_id and friends).
router.use(attachAuditResponseHook);

// ─── STS verification config ──────────────────────────────────────────────────
// Set SKIP_STS_VERIFY=true in .env when the backend has no outbound internet
// access (e.g. an air-gapped K8s pod). Credentials are saved without live
// verification; the user is warned in the API response.
const SKIP_STS_VERIFY = process.env.SKIP_STS_VERIFY === 'true';

// Optionally override the STS endpoint — useful for AWS VPC Interface Endpoints
// or an HTTPS proxy. Leave unset to use the default AWS regional endpoints.
// Example: AWS_STS_ENDPOINT=https://vpce-xxx.sts.us-east-1.vpce.amazonaws.com
const CUSTOM_STS_ENDPOINT = process.env.AWS_STS_ENDPOINT || null;

// ─── Encryption helpers (AES-256-GCM) ────────────────────────────────────────
// BE-10 fix: fail fast if ENCRYPT_KEY is absent or still set to the well-known
// dev placeholder. A silent fallback means all stored AWS credentials would be
// encrypted with a key any attacker can read from the source code.
// Moved to ../utils/awsCrypto so routes/terraform.js (POST /apply) can decrypt
// stored credentials too, without duplicating this logic.
const { encrypt, decrypt } = require('../utils/awsCrypto');

// ─── Build EC2Client (user creds > env creds > instance role) ─────────────────
async function makeClient(region, userId) {
  const cfg = { region: region || process.env.AWS_REGION || DEFAULT_AWS_REGION };
  if (userId) {
    try {
      const row = await db.query(
        'SELECT access_key_id, secret_key_enc FROM user_aws_credentials WHERE user_id = $1',
        [userId]
      );
      if (row.rows.length > 0) {
        cfg.credentials = {
          accessKeyId:     row.rows[0].access_key_id,
          secretAccessKey: decrypt(row.rows[0].secret_key_enc),
        };
      }
    } catch (_) { /* fall through to env/instance creds */ }
  }
  return new EC2Client(cfg);
}

function isCredentialError(e) {
  const msg  = (e.message || '').toLowerCase();
  const code = (e.Code || e.code || e.name || '').toLowerCase();
  return (
    msg.includes('credential') || msg.includes('no credentials') ||
    msg.includes('could not load') || msg.includes('unable to load') ||
    code.includes('credential') || code.includes('nosuchkey') ||
    code.includes('authfailure') || e.name === 'CredentialsProviderError'
  );
}

// ─── Static fallbacks ─────────────────────────────────────────────────────────
const CURATED_INSTANCE_TYPES = [
  't2.micro','t2.small','t2.medium','t2.large',
  't3.nano','t3.micro','t3.small','t3.medium','t3.large','t3.xlarge','t3.2xlarge',
  't3a.nano','t3a.micro','t3a.small','t3a.medium','t3a.large',
  't4g.nano','t4g.micro','t4g.small','t4g.medium','t4g.large',
  'm5.large','m5.xlarge','m5.2xlarge','m5.4xlarge',
  'm5a.large','m5a.xlarge','m5a.2xlarge',
  'm6i.large','m6i.xlarge','m6i.2xlarge','m6i.4xlarge',
  'm6g.medium','m6g.large','m6g.xlarge','m6g.2xlarge',
  'c5.large','c5.xlarge','c5.2xlarge','c5.4xlarge',
  'c5a.large','c5a.xlarge','c5a.2xlarge',
  'c6i.large','c6i.xlarge','c6i.2xlarge','c6i.4xlarge',
  'c6g.medium','c6g.large','c6g.xlarge',
  'r5.large','r5.xlarge','r5.2xlarge','r5.4xlarge',
  'r5a.large','r5a.xlarge','r5a.2xlarge',
  'r6i.large','r6i.xlarge','r6i.2xlarge',
  'r6g.medium','r6g.large','r6g.xlarge',
  'x1e.xlarge','x1e.2xlarge','p3.2xlarge','p3.8xlarge',
  'g4dn.xlarge','g4dn.2xlarge','g4dn.4xlarge',
  'i3.large','i3.xlarge','i3.2xlarge','d3.xlarge','d3.2xlarge',
];

const CURATED_AZS = {
  'ap-south-1':    ['ap-south-1a','ap-south-1b','ap-south-1c'],
  'ap-south-2':    ['ap-south-2a','ap-south-2b','ap-south-2c'],
  'ap-southeast-1':['ap-southeast-1a','ap-southeast-1b','ap-southeast-1c'],
  'ap-southeast-2':['ap-southeast-2a','ap-southeast-2b','ap-southeast-2c'],
  'ap-northeast-1':['ap-northeast-1a','ap-northeast-1c','ap-northeast-1d'],
  'ap-northeast-2':['ap-northeast-2a','ap-northeast-2b','ap-northeast-2c','ap-northeast-2d'],
  'us-east-1':     ['us-east-1a','us-east-1b','us-east-1c','us-east-1d','us-east-1e','us-east-1f'],
  'us-east-2':     ['us-east-2a','us-east-2b','us-east-2c'],
  'us-west-1':     ['us-west-1a','us-west-1c'],
  'us-west-2':     ['us-west-2a','us-west-2b','us-west-2c','us-west-2d'],
  'eu-west-1':     ['eu-west-1a','eu-west-1b','eu-west-1c'],
  'eu-west-2':     ['eu-west-2a','eu-west-2b','eu-west-2c'],
  'eu-central-1':  ['eu-central-1a','eu-central-1b','eu-central-1c'],
  'eu-north-1':    ['eu-north-1a','eu-north-1b','eu-north-1c'],
  'ca-central-1':  ['ca-central-1a','ca-central-1b','ca-central-1d'],
  'sa-east-1':     ['sa-east-1a','sa-east-1b','sa-east-1c'],
  'me-south-1':    ['me-south-1a','me-south-1b','me-south-1c'],
  'af-south-1':    ['af-south-1a','af-south-1b','af-south-1c'],
};

// Curated AMIs — verified real IDs that match the EC2 Launch Wizard console
const CURATED_AMIS = {
  'ap-south-1': [
    { id:'ami-0f58b397bc5c1f2e8', name:'Amazon Linux 2023 (ap-south-1)',   desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',           owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0c768662cc797cd75', name:'Amazon Linux 2 (ap-south-1)',       desc:'Amazon Linux 2 Kernel 5.10 AMI 2.0.20250220.0 x86_64 HVM', owner:'amazon',    os:'amazon-linux-2' },
    { id:'ami-05e00961530ae1b55', name:'Ubuntu 24.04 LTS (ap-south-1)',     desc:'Canonical Ubuntu 24.04 LTS noble amd64 HVM 2025-01-17',    owner:'canonical', os:'ubuntu-24-04' },
    { id:'ami-0287a05f0ef0e9d9a', name:'Ubuntu 22.04 LTS (ap-south-1)',     desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-22-04' },
    { id:'ami-0f5ee92e2d63afc18', name:'Ubuntu 20.04 LTS (ap-south-1)',     desc:'Canonical Ubuntu 20.04 LTS focal amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-20-04' },
    { id:'ami-0d473344347176250', name:'RHEL 9 (ap-south-1)',               desc:'Red Hat Enterprise Linux 9.4 (HVM) SSD Volume Type',       owner:'redhat',    os:'rhel-9' },
    { id:'ami-02b49a24cfb95941c', name:'Windows Server 2022 (ap-south-1)',  desc:'Windows Server 2022 Full Locale English – Amazon',         owner:'amazon',    os:'windows-2022' },
    { id:'ami-03bb6d83c60fc5f7c', name:'Debian 12 Bookworm (ap-south-1)',   desc:'Debian GNU/Linux 12 (Bookworm) – official cloud image',     owner:'debian',    os:'debian-12' },
  ],
  'us-east-1': [
    { id:'ami-0c02fb55956c7d316', name:'Amazon Linux 2023 (us-east-1)',     desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',           owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0cff7528ff583bf9a', name:'Amazon Linux 2 (us-east-1)',         desc:'Amazon Linux 2 Kernel 5.10 AMI 2.0.20250220.0 x86_64 HVM', owner:'amazon',    os:'amazon-linux-2' },
    { id:'ami-04a81a8f3b93b5aca', name:'Ubuntu 24.04 LTS (us-east-1)',       desc:'Canonical Ubuntu 24.04 LTS noble amd64 HVM 2025-01-17',    owner:'canonical', os:'ubuntu-24-04' },
    { id:'ami-0261755bbcb8c4a84', name:'Ubuntu 22.04 LTS (us-east-1)',       desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-22-04' },
    { id:'ami-08d4ac5b634553e16', name:'Ubuntu 20.04 LTS (us-east-1)',       desc:'Canonical Ubuntu 20.04 LTS focal amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-20-04' },
    { id:'ami-0b0dcb5067f052a63', name:'Windows Server 2022 (us-east-1)',    desc:'Windows Server 2022 Full Locale English – Amazon',         owner:'amazon',    os:'windows-2022' },
    { id:'ami-0fe630eb857a6ec83', name:'RHEL 9 (us-east-1)',                 desc:'Red Hat Enterprise Linux 9.4 (HVM) SSD Volume Type',       owner:'redhat',    os:'rhel-9' },
  ],
  'us-west-2': [
    { id:'ami-094125af156557ca2', name:'Amazon Linux 2023 (us-west-2)',     desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',           owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0f1a5f5ada0e7da53', name:'Amazon Linux 2 (us-west-2)',         desc:'Amazon Linux 2 Kernel 5.10 AMI 2.0.20250220.0 x86_64 HVM', owner:'amazon',    os:'amazon-linux-2' },
    { id:'ami-093a4ad9a8cc370f4', name:'Ubuntu 24.04 LTS (us-west-2)',       desc:'Canonical Ubuntu 24.04 LTS noble amd64 HVM 2025-01-17',    owner:'canonical', os:'ubuntu-24-04' },
    { id:'ami-0d70546e43a941d70', name:'Ubuntu 22.04 LTS (us-west-2)',       desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-22-04' },
  ],
  'eu-west-1': [
    { id:'ami-04f7efe62f419d9f5', name:'Amazon Linux 2023 (eu-west-1)',     desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',           owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0905a3c97561e0b69', name:'Ubuntu 24.04 LTS (eu-west-1)',       desc:'Canonical Ubuntu 24.04 LTS noble amd64 HVM 2025-01-17',    owner:'canonical', os:'ubuntu-24-04' },
    { id:'ami-01dd271720c1ba44f', name:'Ubuntu 22.04 LTS (eu-west-1)',       desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-22-04' },
  ],
  'eu-central-1': [
    { id:'ami-04e601abe3e1a910f', name:'Amazon Linux 2023 (eu-central-1)',  desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',           owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0faab6bdbac9486fb', name:'Ubuntu 22.04 LTS (eu-central-1)',   desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',    owner:'canonical', os:'ubuntu-22-04' },
  ],
  'ap-southeast-1': [
    { id:'ami-0df7a207adb9748c7', name:'Amazon Linux 2023 (ap-southeast-1)', desc:'al2023-ami-2023.6.20250128.0-kernel-6.1-x86_64',          owner:'amazon',    os:'amazon-linux-2023' },
    { id:'ami-0be48ea400df66eb5', name:'Ubuntu 24.04 LTS (ap-southeast-1)',  desc:'Canonical Ubuntu 24.04 LTS noble amd64 HVM 2025-01-17',   owner:'canonical', os:'ubuntu-24-04' },
    { id:'ami-062550af7b9fa7d05', name:'Ubuntu 22.04 LTS (ap-southeast-1)',  desc:'Canonical Ubuntu 22.04 LTS jammy amd64 HVM 2024-04-11',   owner:'canonical', os:'ubuntu-22-04' },
  ],
};

const DEFAULT_AMIS = [
  { id:'ami-0c55b159cbfafe1f0', name:'Amazon Linux 2 (placeholder)', desc:'Replace with the actual region-specific AMI ID from AWS console', owner:'amazon', os:'amazon-linux-2' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// CREDENTIAL MANAGEMENT (requires login)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/aws/credentials
router.get('/credentials', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id,aws_region,access_key_id,label,verified_at,created_at,updated_at FROM user_aws_credentials WHERE user_id=$1',
      [req.user.id]
    );
    if (!result.rows.length) return res.json({ credentials: null });
    const r = result.rows[0];
    const masked = r.access_key_id.length > 4
      ? '•'.repeat(r.access_key_id.length - 4) + r.access_key_id.slice(-4)
      : '••••';
    res.json({ credentials: { ...r, access_key_id: masked } });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// POST /api/aws/credentials
router.post('/credentials', authMiddleware, audit('aws.credentials.save'), async (req, res) => {
  const { access_key_id, secret_access_key, aws_region, label } = req.body;
  if (!access_key_id || !secret_access_key || !aws_region)
    return res.status(400).json({ error: 'access_key_id, secret_access_key and aws_region are required' });
  if (!/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(access_key_id))
    return res.status(400).json({ error: 'Invalid Access Key ID format (must start with AKIA or ASIA followed by 16 uppercase characters)' });

  // ── Helper: build an STSClient, respecting CUSTOM_STS_ENDPOINT ──────────────
  function makeStsClient(region, creds) {
    const cfg = { region, credentials: creds };
    if (CUSTOM_STS_ENDPOINT) cfg.endpoint = CUSTOM_STS_ENDPOINT;
    return new STSClient(cfg);
  }

  // ── Helper: save credentials to DB ───────────────────────────────────────────
  async function persistCredentials(verifiedAt) {
    const now = new Date();
    const secretEnc = encrypt(secret_access_key);

    // Auto-create the credentials table if it doesn't exist (safety net for DBs
    // that haven't run the latest migration).
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_aws_credentials (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        aws_region      VARCHAR(50)  NOT NULL DEFAULT '${DEFAULT_AWS_REGION}',
        access_key_id   TEXT         NOT NULL,
        secret_key_enc  TEXT         NOT NULL,
        label           VARCHAR(255) DEFAULT 'My AWS Account',
        verified_at     TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {}); // table likely exists already

    await db.query(
      `INSERT INTO user_aws_credentials(user_id,aws_region,access_key_id,secret_key_enc,label,verified_at,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(user_id) DO UPDATE SET
         aws_region=EXCLUDED.aws_region, access_key_id=EXCLUDED.access_key_id,
         secret_key_enc=EXCLUDED.secret_key_enc, label=EXCLUDED.label,
         verified_at=EXCLUDED.verified_at, updated_at=EXCLUDED.updated_at`,
      [req.user.id, aws_region, access_key_id, secretEnc, label || 'My AWS Account', verifiedAt, now, now]
    );
  }

  // ── Fast-path: skip STS when configured for air-gapped environments ───────────
  if (SKIP_STS_VERIFY) {
    try {
      await persistCredentials(null); // verified_at = NULL signals unverified
      console.warn('[aws/credentials POST] SKIP_STS_VERIFY=true — saved without live verification');
      return res.json({
        success: true,
        warning: 'Credentials saved without live verification (SKIP_STS_VERIFY is enabled). ' +
                 'Ensure your Access Key ID and Secret Access Key are correct before use.',
        accountInfo: null,
      });
    } catch (e) {
      console.error('[aws/credentials POST] DB error (skip-verify path)', e);
      return res.status(500).json({ error: 'Failed to save credentials: ' + e.message });
    }
  }

  // ── Normal path: verify via STS, then persist ────────────────────────────────
  // Strategy: try global STS first (works for all standard regions including
  // ap-south-1), then fall back to the regional endpoint. Using a custom
  // AWS_STS_ENDPOINT (e.g. a VPC Interface Endpoint) bypasses both attempts and
  // goes directly to the configured URL.
  try {
    let identity;
    const creds = { accessKeyId: access_key_id, secretAccessKey: secret_access_key };

    try {
      // Prefer CUSTOM_STS_ENDPOINT when set; otherwise use global (us-east-1)
      const stsFirst = CUSTOM_STS_ENDPOINT
        ? makeStsClient(aws_region, creds)
        : makeStsClient('us-east-1', creds); // global STS — reachable from any region
      identity = await stsFirst.send(new GetCallerIdentityCommand({}));
    } catch (firstErr) {
      const firstMsg  = firstErr.message || '';
      const firstName = firstErr.name || firstErr.Code || '';

      // Surface credential errors immediately — no point retrying regionally
      if (
        isCredentialError(firstErr) ||
        firstName === 'InvalidClientTokenId' ||
        firstName === 'AuthFailure' ||
        firstName === 'InvalidAccessKeyId' ||
        firstName === 'SignatureDoesNotMatch' ||
        firstMsg.includes('security token') ||
        firstMsg.includes('not authorized') ||
        firstMsg.includes('Access Denied')
      ) {
        throw firstErr;
      }

      // Network-level failure on the first attempt — try the regional endpoint
      // (skip if we already used a custom endpoint, since retrying won't help)
      if (CUSTOM_STS_ENDPOINT) throw firstErr;

      const stsRegional = new STSClient({
        region: aws_region,
        credentials: creds,
        endpoint: `https://sts.${aws_region}.amazonaws.com`,
      });
      identity = await stsRegional.send(new GetCallerIdentityCommand({}));
    }

    await persistCredentials(new Date());
    return res.json({ success: true, accountInfo: { account: identity.Account, arn: identity.Arn } });
  } catch (e) {
    const msg  = e.message || '';
    const name = e.name || e.Code || '';

    if (
      isCredentialError(e) ||
      name === 'InvalidClientTokenId' ||
      name === 'AuthFailure' ||
      name === 'InvalidAccessKeyId' ||
      name === 'SignatureDoesNotMatch' ||
      msg.includes('security token') ||
      msg.includes('The security token') ||
      msg.includes('not authorized') ||
      msg.includes('Access Denied')
    ) {
      return res.status(400).json({
        error: 'AWS credential verification failed. Please double-check your Access Key ID and Secret Access Key.',
        detail: msg,
      });
    }

    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('network') || msg.includes('timeout')) {
      const hint = CUSTOM_STS_ENDPOINT
        ? `The configured AWS_STS_ENDPOINT (${CUSTOM_STS_ENDPOINT}) is unreachable.`
        : `The backend cannot reach AWS STS. ` +
          `If this server has no outbound internet, set SKIP_STS_VERIFY=true or ` +
          `point AWS_STS_ENDPOINT to a VPC Interface Endpoint in your .env.`;
      return res.status(503).json({
        error: `Could not reach AWS STS for region "${aws_region}". Check your network connection or try again.`,
        detail: msg,
        hint,
      });
    }

    console.error('[aws/credentials POST]', e);
    // Last resort: save credentials without verification rather than failing
    // completely. The user can still use them and verify manually.
    try {
      await persistCredentials(null);
      return res.json({
        success: true,
        warning: 'Credentials saved but could not be verified with AWS STS. ' +
                 'Please ensure your Access Key ID and Secret Access Key are correct. ' +
                 `Error: ${msg}`,
        accountInfo: null,
      });
    } catch (dbErr) {
      console.error('[aws/credentials POST] DB fallback error:', dbErr.message);
      return res.status(500).json({ error: 'Failed to save credentials: ' + dbErr.message });
    }
  }
});

// DELETE /api/aws/credentials
router.delete('/credentials', authMiddleware, audit('aws.credentials.delete'), async (req, res) => {
  try {
    await db.query('DELETE FROM user_aws_credentials WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete credentials' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AWS DATA ENDPOINTS (optional auth so stored creds are used when logged in)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/instance-types', optionalAuth, async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  try {
    const client = await makeClient(region, req.user?.id);
    let types = [], nextToken;
    do {
      const out = await client.send(new DescribeInstanceTypesCommand({ MaxResults: 100, NextToken: nextToken }));
      (out.InstanceTypes || []).forEach(t => t.InstanceType && types.push(t.InstanceType));
      nextToken = out.NextToken;
    } while (nextToken && types.length < 2000);
    const merged = Array.from(new Set([...types, ...CURATED_INSTANCE_TYPES])).sort();
    return res.json({ region, count: merged.length, instance_types: merged, source: 'aws' });
  } catch (e) {
    if (isCredentialError(e)) {
      return res.json({ region, count: CURATED_INSTANCE_TYPES.length, instance_types: CURATED_INSTANCE_TYPES, source: 'curated', note: 'Add AWS credentials in Settings for live data' });
    }
    res.status(500).json({ error: 'AWS request failed: ' + e.message });
  }
});

router.get('/availability-zones', optionalAuth, async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  try {
    const client = await makeClient(region, req.user?.id);
    const out = await client.send(new DescribeAvailabilityZonesCommand({}));
    const zones = (out.AvailabilityZones || []).filter(z => z.ZoneName && z.State === 'available').map(z => z.ZoneName).sort();
    if (!zones.length) throw new Error('No zones');
    return res.json({ region, count: zones.length, zones, source: 'aws' });
  } catch (_) {
    const fallback = CURATED_AZS[region] || [`${region}a`, `${region}b`, `${region}c`];
    return res.json({ region, count: fallback.length, zones: fallback, source: 'curated' });
  }
});

router.get('/amis', optionalAuth, async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  const q      = (req.query.q || '').trim();
  // FIX-1: raised default from 12 → 50, hard cap from 50 → 200 so a live
  // AWS search actually returns useful breadth instead of just 12 results.
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);

  // Check if live creds available
  let hasUserCreds = false;
  if (req.user?.id) {
    const cr = await db.query('SELECT 1 FROM user_aws_credentials WHERE user_id=$1', [req.user.id]).catch(() => ({ rows:[] }));
    hasUserCreds = cr.rows.length > 0;
  }
  const hasEnvCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (hasUserCreds || hasEnvCreds) {
    try {
      const client = await makeClient(region, req.user?.id);
      const filters = [
        { Name: 'state',               Values: ['available'] },
        { Name: 'virtualization-type', Values: ['hvm'] },
        { Name: 'architecture',        Values: ['x86_64'] },
        { Name: 'image-type',          Values: ['machine'] },
      ];

      // FIX-2: when no search query is given, apply a name-pattern filter so
      // AWS returns only the well-known distro families instead of tens of
      // thousands of marketplace/community images that are useless noise.
      // When the user types a query, use their term instead.
      if (q) {
        filters.push({ Name: 'name', Values: [`*${q}*`] });
      } else {
        filters.push({
          Name: 'name',
          Values: [
            'al2023-ami-*',          // Amazon Linux 2023
            'amzn2-ami-hvm-*',       // Amazon Linux 2
            'ubuntu/images/hvm-ssd/ubuntu-*',   // Ubuntu (Canonical)
            'ubuntu/images/hvm-ssd-gp3/ubuntu-*',
            'RHEL-*',                // Red Hat
            'debian-*',              // Debian
            'Windows_Server-*',      // Windows
            'suse-sles-*',           // SUSE
          ],
        });
      }

      // FIX-3: paginate through all result pages so we are not silently
      // capped at whatever the SDK returns on the first response (~1000 max
      // per page from AWS). Collect up to `limit` images across all pages.
      let allImages = [];
      let nextToken;
      do {
        const cmd = new DescribeImagesCommand({
          Owners: ['amazon', '099720109477', '309956199498'], // amazon, Canonical, Red Hat
          Filters: filters,
          ...(nextToken ? { NextToken: nextToken } : {}),
        });
        const out = await client.send(cmd);
        const page = (out.Images || []).filter(i => i.ImageId && i.Name);
        allImages = allImages.concat(page);
        nextToken = out.NextToken;
        // Stop paginating once we have enough candidates to sort and slice from
      } while (nextToken && allImages.length < limit * 4);

      if (allImages.length > 0) {
        const images = allImages
          .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
          .slice(0, limit)
          .map(i => ({ id: i.ImageId, name: i.Name, desc: i.Description || '', owner: i.OwnerId, created: i.CreationDate }));
        return res.json({ region, query: q, count: images.length, total_found: allImages.length, images, source: 'aws' });
      }
    } catch (err) {
      // Log the real error so it's visible in backend logs, then fall through to curated list
      console.error('[AMI] DescribeImages failed:', err?.message || err);
    }
  }

  let images = CURATED_AMIS[region] || DEFAULT_AMIS;
  if (q) {
    const ql = q.toLowerCase();
    images = images.filter(i =>
      i.name.toLowerCase().includes(ql) || i.desc.toLowerCase().includes(ql) ||
      i.id.toLowerCase().includes(ql)   || (i.os||'').toLowerCase().includes(ql)
    );
  }
  res.json({
    region, query: q, count: images.length, images: images.slice(0, limit),
    source: 'curated',
    note: hasUserCreds || hasEnvCreds ? 'Live AMI query returned no results' : 'Add AWS credentials in Settings to fetch AMIs from your console',
  });
});

module.exports = router;
