'use strict';
/**
 * /api/hcl-assist — AI-powered HCL writing/editing for the Studio editor
 *
 * POST /api/hcl-assist
 *   Body: { instruction: string, filename: string, currentCode: string, allFiles?: {[filename]: string} }
 *   Returns: { updated_code: string, summary: string, engine: string }
 *
 * This is the "write/update code" counterpart to routes/hcl-explain.js (which
 * only *explains* existing HCL). It lets a user type a plain-English
 * instruction — "add an S3 bucket with versioning enabled", "add a variable
 * for environment and use it in the provider block" — and get back a
 * complete, ready-to-apply replacement for the file they're editing.
 *
 * There is deliberately no static/offline fallback here (unlike
 * hcl-explain.js): a canned dictionary can describe a known resource type,
 * but it can't *write* arbitrary code for an arbitrary instruction. Without
 * ANTHROPIC_API_KEY this endpoint returns a clear 503 rather than pretending
 * to have generated something.
 */
const router = require('express').Router();
const https  = require('https');
const { authMiddleware } = require('../middleware/auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL              = 'claude-sonnet-4-6';
const MAX_CODE_CHARS     = 20_000; // current file
const MAX_CONTEXT_CHARS  = 20_000; // other files combined, truncated
const MAX_INSTRUCTION_CHARS = 2_000;

// ── Per-user rate limiter (sliding window, in-process) ────────────────────────
// Mirrors routes/hcl-explain.js. Code generation is a heavier/pricier call
// than explanation, so the ceiling is a bit lower.
const _callLog = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_CALLS = 15;

function checkRateLimit(userId) {
  const now   = Date.now();
  const calls = (_callLog.get(userId) || []).filter(t => t > now - WINDOW_MS);
  if (calls.length >= MAX_CALLS) return false;
  calls.push(now);
  _callLog.set(userId, calls);
  return true;
}

router.use(authMiddleware);

router.post('/', async (req, res) => {
  const { instruction, filename, currentCode, allFiles } = req.body;

  if (!instruction || !instruction.trim()) {
    return res.status(400).json({ error: 'instruction is required' });
  }
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }

  if (!checkRateLimit(req.user.id)) {
    return res.status(429).json({ error: 'Rate limit: max 15 AI code requests per 5 minutes.' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'AI code assistant is not configured. Set ANTHROPIC_API_KEY in backend/.env to enable it.',
    });
  }

  const trimmedInstruction = instruction.slice(0, MAX_INSTRUCTION_CHARS);
  const trimmedCode        = (currentCode || '').slice(0, MAX_CODE_CHARS);

  // Build lightweight context from the other open files (variables already
  // declared, provider config, etc.) so the model doesn't invent a variable
  // that already exists elsewhere, or duplicate a provider block.
  let contextBlock = '';
  if (allFiles && typeof allFiles === 'object') {
    let budget = MAX_CONTEXT_CHARS;
    for (const [fname, content] of Object.entries(allFiles)) {
      if (fname === filename || !content) continue;
      const chunk = content.slice(0, Math.max(0, budget));
      if (!chunk) break;
      contextBlock += `\n\n--- ${fname} (context only, do not modify) ---\n${chunk}`;
      budget -= chunk.length;
      if (budget <= 0) break;
    }
  }

  const systemPrompt = `You are a senior Terraform/HCL engineer pair-programming with a developer inside a code editor.
The user will describe a change in plain English. Your job is to return the COMPLETE, updated content for the file they are editing — ready to save and run \`terraform validate\` against.

Rules:
- Return the full file content, not a diff or a snippet. Preserve everything in the file that the instruction doesn't ask you to change (formatting, comments, unrelated resources).
- Only modify the target file. Files under "context only" are for reference (existing variables, providers, resource names) — do not repeat or restate them, and do not invent a resource/variable that already exists there under a different name.
- Write valid, idiomatic HCL2 (Terraform >= 1.5). Follow AWS provider best practices: encryption at rest where applicable, no public S3 ACLs, least-privilege IAM, sensible defaults.
- If the instruction is ambiguous, make the single most reasonable interpretation — do not ask a clarifying question, this is a non-interactive API.
- Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:
{"updated_code": "<the full new file content, with \\n for newlines>", "summary": "<1-3 sentence plain-English summary of what changed>"}`;

  const userMsg = [
    `Instruction: ${trimmedInstruction}`,
    '',
    `Target file: ${filename}`,
    '--- current content of the target file ---',
    trimmedCode || '(empty file)',
    contextBlock,
  ].join('\n');

  try {
    const raw = await callAnthropic(systemPrompt, userMsg);
    const parsed = extractResult(raw);
    if (!parsed.updated_code) throw new Error('Model did not return updated code');
    return res.json({
      updated_code: parsed.updated_code,
      summary: parsed.summary || 'Updated the file per your instruction.',
      engine: 'claude-sonnet-4-6',
    });
  } catch (err) {
    console.error('[hcl-assist] Anthropic API error:', err.message);
    return res.status(502).json({ error: `AI code assistant failed: ${err.message}` });
  }
});

// ── Anthropic API call (raw HTTPS — no SDK needed, matches hcl-explain.js) ───
function callAnthropic(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: 4096,
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
    req.setTimeout(40_000, () => { req.destroy(); reject(new Error('Anthropic request timed out (40s)')); });
    req.write(body);
    req.end();
  });
}

// ── Robustly extract {updated_code, summary} even if the model wraps the ────
// JSON in markdown fences or adds stray text around it.
function extractResult(raw) {
  const text = (raw || '').trim();

  // 1) Try parsing as-is.
  try { return JSON.parse(text); } catch (_) { /* fall through */ }

  // 2) Strip ```json / ``` fences if present, try again.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fall through */ }
  }

  // 3) Try to locate the first '{' ... last '}' as a best-effort JSON slice.
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }

  // 4) Last resort: treat the whole response as raw code (strip any fence
  //    markers), so the user still gets *something* usable instead of an error.
  const codeOnly = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  return { updated_code: codeOnly, summary: 'Applied AI-suggested changes (response was not valid JSON — used raw output).' };
}

module.exports = router;
