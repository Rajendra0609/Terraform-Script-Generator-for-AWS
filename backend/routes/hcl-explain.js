'use strict';
/**
 * /api/hcl-explain  — AI-powered HCL explanation (Phase 4)
 *
 * POST /api/hcl-explain
 *   Body: { hcl: string, resource_type?: string, focus?: string }
 *   Returns: { explanation: string, blocks: [...], cost_hints: [...] }
 *
 * Uses the Anthropic Messages API (claude-sonnet-4-6) when ANTHROPIC_API_KEY
 * is set.  Falls back to the static KB explanations when the key is absent.
 *
 * Rate-limited to 20 calls / 5 minutes per user to avoid abuse.
 */
const router = require('express').Router();
const https  = require('https');
const { authMiddleware } = require('../middleware/auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL             = 'claude-sonnet-4-6';
const MAX_HCL_CHARS     = 12_000; // ~3 k tokens — keep cost low

// ── Per-user rate limiter (sliding window, in-process) ────────────────────────
const _callLog = new Map();          // userId → [timestamps]
const WINDOW_MS = 5 * 60 * 1000;    // 5 minutes
const MAX_CALLS = 20;

function checkRateLimit(userId) {
  const now  = Date.now();
  const calls = (_callLog.get(userId) || []).filter(t => t > now - WINDOW_MS);
  if (calls.length >= MAX_CALLS) return false;
  calls.push(now);
  _callLog.set(userId, calls);
  return true;
}

router.use(authMiddleware);

// ── POST /api/hcl-explain ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { hcl, resource_type, focus } = req.body;

  if (!hcl || !hcl.trim()) {
    return res.status(400).json({ error: 'hcl is required' });
  }

  if (!checkRateLimit(req.user.id)) {
    return res.status(429).json({ error: 'Rate limit: max 20 AI explanations per 5 minutes.' });
  }

  const trimmed = hcl.slice(0, MAX_HCL_CHARS);

  // ── If no API key configured, return a structured stub ──────────────────────
  if (!ANTHROPIC_API_KEY) {
    return res.json({
      explanation: buildStaticExplanation(trimmed, resource_type),
      engine: 'static-kb',
      note: 'Set ANTHROPIC_API_KEY in backend/.env to enable AI-powered explanations.',
    });
  }

  // ── Call Anthropic API ────────────────────────────────────────────────────────
  const systemPrompt = `You are a senior DevOps engineer and Terraform expert.
Your job is to explain Terraform HCL configurations in plain English to developers who are learning infrastructure.
Rules:
- Be clear, concrete and practical — no jargon without explanation.
- For each resource block: explain WHAT it creates, WHY it's needed, and WHAT HAPPENS after terraform apply.
- Highlight security concerns (e.g. public access, open ports, unencrypted storage) with ⚠️.
- Add rough cost hints where relevant (e.g. "~$X/month").
- Format your response as clean Markdown with ## headings for each resource block.
- Keep the full response under 800 words.
- At the end, add a "## Architecture Flow" section showing the dependency order with → arrows.`;

  const userMsg = [
    focus ? `The user is specifically asking about: ${focus}\n\n` : '',
    resource_type ? `Focus on the "${resource_type}" resource.\n\n` : '',
    '```hcl\n' + trimmed + '\n```',
  ].join('');

  try {
    const aiResponse = await callAnthropic(systemPrompt, userMsg);
    return res.json({
      explanation: aiResponse,
      engine: 'claude-sonnet-4-6',
    });
  } catch (err) {
    console.error('[hcl-explain] Anthropic API error:', err.message);
    // Graceful fallback — never leave the user with a blank panel
    return res.json({
      explanation: buildStaticExplanation(trimmed, resource_type),
      engine: 'static-kb',
      error: `AI explanation unavailable: ${err.message}`,
    });
  }
});

// ── Anthropic API call (raw HTTPS — no SDK needed) ────────────────────────────
function callAnthropic(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          const text = parsed.content?.[0]?.text;
          if (!text) reject(new Error('Empty response from Anthropic'));
          else resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25_000, () => { req.destroy(); reject(new Error('Anthropic request timed out (25s)')); });
    req.write(body);
    req.end();
  });
}

// ── Static fallback builder (no LLM) ─────────────────────────────────────────
function buildStaticExplanation(hcl, resourceType) {
  const blocks = extractBlocks(hcl);
  if (!blocks.length) return '> No Terraform resource blocks detected in the provided HCL.';

  const lines = ['# HCL Explanation\n'];

  for (const b of blocks) {
    const known = RESOURCE_SUMMARIES[b.type];
    lines.push(`## \`${b.type}\` — \`${b.name}\``);
    if (known) {
      lines.push(`**What:** ${known.what}`);
      lines.push(`\n**Why:** ${known.why}`);
      if (known.cost) lines.push(`\n💰 **Cost hint:** ${known.cost}`);
      if (known.warn) lines.push(`\n⚠️ **Watch out:** ${known.warn}`);
    } else {
      lines.push(`This is a \`${b.type}\` resource named \`${b.name}\`.`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('> 💡 **Tip:** Set `ANTHROPIC_API_KEY` in `backend/.env` for AI-powered explanations.');

  return lines.join('\n');
}

function extractBlocks(hcl) {
  const re = /^resource\s+"([^"]+)"\s+"([^"]+)"/gm;
  const results = [];
  let m;
  while ((m = re.exec(hcl)) !== null) results.push({ type: m[1], name: m[2] });
  return results;
}

const RESOURCE_SUMMARIES = {
  aws_vpc:                  { what: 'Isolated private network in AWS with a defined CIDR IP range.', why: 'All other resources (subnets, EC2, RDS) must live inside a VPC.', cost: 'Free (VPC itself has no hourly cost).' },
  aws_subnet:               { what: 'A segment of the VPC\'s IP range tied to one Availability Zone.', why: 'Segments your network into public/private zones.', cost: 'Free.' },
  aws_internet_gateway:     { what: 'Bridge between your VPC and the public internet.', why: 'Without it, nothing in the VPC can reach the internet.', cost: 'Free.' },
  aws_security_group:       { what: 'A stateful firewall controlling inbound/outbound traffic.', why: 'AWS blocks all inbound traffic by default — SGs open specific ports.', warn: 'Avoid 0.0.0.0/0 ingress on SSH (22) or RDP (3389).' },
  aws_instance:             { what: 'A virtual machine (EC2) in your VPC.', why: 'The workhorse for running applications in AWS.', cost: 't3.micro ~$8.50/month, t3.medium ~$33/month.' },
  aws_db_instance:          { what: 'A managed relational database (RDS).', why: 'AWS handles backups, patching and HA — you just connect.', cost: 'db.t3.micro ~$13/month.', warn: 'Always set storage_encrypted = true.' },
  aws_s3_bucket:            { what: 'Object storage for files, static assets, backups.', why: 'Infinitely scalable storage — $0.023/GB/month.', warn: 'Never set acl = "public-read" unless serving static websites.' },
  aws_lambda_function:      { what: 'Serverless function that runs code in response to events.', why: 'No servers to manage — pay only for invocations.', cost: 'First 1M requests/month free, then $0.20/1M.' },
  aws_iam_role:             { what: 'An AWS identity with specific permissions for services to assume.', why: 'EC2, Lambda, ECS tasks need roles to call other AWS services.', warn: 'Follow least-privilege: never use AdministratorAccess on service roles.' },
  aws_eks_cluster:          { what: 'A managed Kubernetes control plane.', why: 'Run containerised workloads at scale without managing etcd.', cost: '$0.10/hour per cluster (~$73/month) + node costs.' },
  aws_lb:                   { what: 'An Application Load Balancer (HTTP/HTTPS layer 7).', why: 'Distributes traffic across multiple targets (EC2, ECS, Lambda).', cost: '~$16/month base + $0.008/LCU-hour.' },
  aws_cloudfront_distribution: { what: 'AWS\'s CDN — caches content at 400+ edge locations.', why: 'Reduces latency globally and offloads origin traffic.', cost: '$0.0085–$0.12/GB depending on region.' },
  aws_route53_record:       { what: 'A DNS record (A, CNAME, ALIAS, etc.) in Route 53.', why: 'Points a domain name to your AWS resource.' , cost: '$0.50/hosted zone/month + $0.40/1M queries.' },
};

module.exports = router;
