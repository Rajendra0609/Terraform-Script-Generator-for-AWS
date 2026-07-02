'use strict';
/**
 * Terraform runner — local-first execution with Docker-sandbox fallback.
 *
 * Execution priority (all operations) is controlled by the `mode` param:
 *  'auto'   (default) — host binary first, Docker fallback
 *  'local'  — host binary only; error if not installed
 *  'docker' — Docker only; error if daemon unavailable
 *
 * Security model (Docker path):
 *  - Each operation runs in an ephemeral Docker container (--rm)
 *  - --network=none for fmt/validate (no internet needed)
 *  - --memory=512m --cpus=1.0 --pids-limit=50 resource caps
 *  - Container runs as non-root (UID 1000)
 *  - HCL mounted read-only where possible; output via stdout only
 *  - Container destroyed immediately after operation
 */
const { exec, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { v4: uuidv4 } = require('uuid');

// ─── Workspace directories ────────────────────────────────────────────────────
const WORKSPACE    = path.join(os.tmpdir(), 'tfgen-workspaces');
const PLUGIN_CACHE = path.join(os.tmpdir(), 'tfgen-plugin-cache');
[WORKSPACE, PLUGIN_CACHE].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// BUG-011 fix: pin the Terraform image by immutable digest so that the binary
// cannot change silently between server restarts.
const TF_DOCKER_IMAGE = process.env.TF_DOCKER_IMAGE ||
  'hashicorp/terraform@sha256:1a8d5d7c0c2e52434f9a11a5bcd7f9cf1a5eab72c67fd9f2cd1be2f2b87ee41e';

const IS_WINDOWS = process.platform === 'win32';

/** Normalise the runner mode — default to 'auto' */
function resolveMode(mode) {
  if (mode === 'local' || mode === 'docker') return mode;
  return 'auto';
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Detect provider prefixes in HCL (e.g. "aws_instance" → "aws") and write
 * a _providers_override.tf file so `terraform init` knows what to download
 * and can skip credential validation.
 *
 * FIX: The override file now also emits a `terraform { required_providers {} }`
 * block when the HCL doesn't already contain one.  Without this, pasting bare
 * resource blocks (no provider config) caused `terraform init` to fail because
 * Terraform couldn't locate the aws provider registry entry.
 *
 * Naming: _providers_override.tf ends with _override.tf, so Terraform treats
 * it as an override file — provider args are MERGED with (not duplicated from)
 * any existing provider "aws" {} block in the user's HCL.  This is the
 * intentional Terraform override mechanism and does NOT create duplicate blocks.
 */
function writeProviderOverride(workDir, hcl) {
  const prefixes = new Set();
  const re = /(?:resource|data)\s+"([a-z][a-z0-9]*)_/g;
  let m;
  while ((m = re.exec(hcl)) !== null) prefixes.add(m[1]);

  if (/skip_credentials_validation/.test(hcl)) return;

  const overrideParts = [];

  // Emit required_providers when missing so `terraform init` can locate the
  // provider binary even for HCL that has no explicit terraform{} block.
  const hasRequiredProviders = /required_providers\s*\{/.test(hcl);
  if (!hasRequiredProviders && prefixes.has('aws')) {
    overrideParts.push(`terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}`);
  }

  for (const p of prefixes) {
    if (p === 'aws') {
      overrideParts.push(`provider "aws" {
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
  region                      = "us-east-1"
}`);
    }
  }

  if (overrideParts.length > 0) {
    fs.writeFileSync(
      path.join(workDir, '_providers_override.tf'),
      overrideParts.join('\n\n') + '\n',
      'utf8'
    );
  }
}

/**
 * Execute a shell command cross-platform.
 */
function crossExec(cmd, opts = {}) {
  return new Promise(resolve => {
    const execOpts = { timeout: opts.timeout || 120000, ...opts };
    if (IS_WINDOWS) execOpts.shell = 'cmd.exe';
    exec(cmd, execOpts, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Like crossExec, but also streams stdout/stderr chunks to logFn as they
 * arrive. Used by runApply so users see real-time `terraform apply` output
 * over the job WebSocket instead of waiting silently until the whole
 * command finishes (fmt/validate are fast enough that this doesn't matter,
 * but apply can run for minutes).
 */
function crossExecStreaming(cmd, opts = {}, logFn = null) {
  return new Promise(resolve => {
    const execOpts = { timeout: opts.timeout || 120000, maxBuffer: 1024 * 1024 * 20, ...opts };
    if (IS_WINDOWS) execOpts.shell = 'cmd.exe';
    const child = exec(cmd, execOpts, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
    if (logFn) {
      child.stdout?.on('data', d => logFn({ stream: 'stdout', line: d.toString() }));
      child.stderr?.on('data', d => logFn({ stream: 'stderr', line: d.toString() }));
    }
  });
}

/** TTL (ms) for availability caches — allows recovery after transient failures */
const AVAILABILITY_CACHE_TTL = 60_000; // 60 seconds

/**
 * Check if terraform CLI is available on host.
 * Result is cached for AVAILABILITY_CACHE_TTL ms so that:
 *  - terraform installed after startup is detected within one TTL window.
 *  - a transient PATH glitch at boot does not permanently disable local exec.
 */
const checkTerraform = (() => {
  let _cached = null;
  let _cachedAt = 0;
  return () => {
    const now = Date.now();
    if (_cached !== null && (now - _cachedAt) < AVAILABILITY_CACHE_TTL) {
      return Promise.resolve(_cached);
    }
    return new Promise(resolve => {
      exec('terraform version', { timeout: 10000 }, (err) => {
        _cached = !err;
        _cachedAt = Date.now();
        if (_cached) {
          console.info('[runner] Local terraform found — will use host binary (Docker as fallback)');
        } else {
          console.warn('[runner] Local terraform not found — will use Docker sandbox');
        }
        resolve(_cached);
      });
    });
  };
})();

/**
 * Check if Docker daemon is available.
 * Result is cached for AVAILABILITY_CACHE_TTL ms so that Docker becoming
 * available after a slow daemon start (or restart) is detected automatically.
 */
const dockerAvailable = (() => {
  let _cached = null;
  let _cachedAt = 0;
  return () => {
    const now = Date.now();
    if (_cached !== null && (now - _cachedAt) < AVAILABILITY_CACHE_TTL) {
      return Promise.resolve(_cached);
    }
    return new Promise(resolve => {
      exec('docker info --format "{{.ServerVersion}}"', { timeout: 5000 }, (err) => {
        _cached = !err;
        _cachedAt = Date.now();
        if (!_cached) console.warn('[runner] Docker unavailable — local exec only');
        resolve(_cached);
      });
    });
  };
})();

/**
 * Build a shared local env object for host terraform runs.
 */
function localEnv(workDir, extraEnv = {}) {
  const tfrcPath = path.join(workDir, '.terraformrc');
  fs.writeFileSync(tfrcPath, `plugin_cache_dir = "${PLUGIN_CACHE.replace(/\\/g, '/')}"\n`, 'utf8');
  return {
    ...process.env,
    ...extraEnv,
    TF_CLI_CONFIG_FILE: tfrcPath,
    TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
    TF_INPUT: 'false',
  };
}

/**
 * Run terraform inside Docker (writable workDir for init artifacts).
 */
function runInDocker(workDir, tfArgs, opts = {}) {
  const { network = 'none', timeout = 120000, extraEnv = {}, logFn = null } = opts;

  const args = [
    'run', '--rm',
    `--network=${network}`,
    '--memory=512m', '--cpus=1.0', '--pids-limit=50',
    '--user=1000:1000',
    '-v', `${workDir}:/workspace:rw`,
    '-v', `${PLUGIN_CACHE}:/tmp/plugin-cache:rw`,
    '-e', 'TF_PLUGIN_CACHE_DIR=/tmp/plugin-cache',
    '-e', 'TF_INPUT=false',
    '-e', 'TF_CLI_ARGS_init=-backend=false',
  ];
  for (const [k, v] of Object.entries(extraEnv)) {
    args.push('-e', `${k}=${v}`);
  }
  args.push('-w', '/workspace', TF_DOCKER_IMAGE, ...tfArgs);

  return new Promise(resolve => {
    let stdout = '', stderr = '';
    const proc = spawn('docker', args);
    proc.stdout.on('data', d => { stdout += d; if (logFn) logFn({ stream: 'stdout', line: d.toString() }); });
    proc.stderr.on('data', d => { stderr += d; if (logFn) logFn({ stream: 'stderr', line: d.toString() }); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: -1, stdout, stderr: 'Timeout exceeded' }); }, timeout);
    proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    proc.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
  });
}

// ─── Plan JSON parser ─────────────────────────────────────────────────────────
function parsePlanJson(raw) {
  try {
    const lines = raw.trim().split('\n').filter(l => l.startsWith('{'));
    let changes = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.resource_changes) { changes = obj.resource_changes; break; }
      } catch (_) {}
    }
    const summary = { create_count: 0, update_count: 0, delete_count: 0, total: changes.length };
    for (const c of changes) {
      const actions = c.change?.actions || [];
      if (actions.includes('create') && actions.length === 1) summary.create_count++;
      else if (actions.includes('delete') && actions.length === 1) summary.delete_count++;
      else if (actions.length > 0) summary.update_count++;
    }
    return { summary, resource_changes: changes };
  } catch (_) {
    return { summary: { create_count: 0, update_count: 0, delete_count: 0, total: 0 }, resource_changes: [] };
  }
}

// ─── terraform fmt ────────────────────────────────────────────────────────────
async function runFmt(hcl, logFn, mode = 'auto') {
  const resolvedMode = resolveMode(mode);
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  const tfFile = path.join(workDir, 'main.tf');

  try {
    fs.writeFileSync(tfFile, hcl, 'utf8');

    // ── 1. Local path ───────────────────────────────────────────────────────
    if (resolvedMode !== 'docker') {
      const hasTf = await checkTerraform();
      if (hasTf) {
        if (logFn) logFn({ stream: 'info', line: '🖥️  Running terraform fmt locally...\n' });
        const { err, stderr } = await crossExec(
          `cd "${workDir}" && terraform fmt -no-color "main.tf"`,
          { timeout: 15000 }
        );
        if (!err) {
          let formatted = hcl;
          try { formatted = fs.readFileSync(tfFile, 'utf8'); } catch (_) {}
          return { success: true, formatted, message: 'Formatted successfully (local)', runner: 'local' };
        }
        if (resolvedMode === 'local') {
          return { success: false, formatted: hcl, message: `Local terraform fmt failed: ${stderr}`, runner: 'local' };
        }
        // auto: fall through to Docker
        console.warn('[runner:fmt] Local terraform fmt failed, trying Docker:', stderr);
        if (logFn) logFn({ stream: 'info', line: '⚠️  Local fmt failed, falling back to Docker sandbox...\n' });
      } else if (resolvedMode === 'local') {
        return { success: false, formatted: hcl, message: 'Terraform not installed locally. Install from https://developer.hashicorp.com/terraform/install', runner: 'local', offline: true };
      }
    }

    // ── 2. Docker path ──────────────────────────────────────────────────────
    if (resolvedMode !== 'local') {
      const useDocker = await dockerAvailable();
      if (useDocker) {
        if (logFn) logFn({ stream: 'info', line: '🐳 Running terraform fmt in Docker sandbox...\n' });
        const fmtResult = await runInDocker(workDir, ['fmt', '-no-color', 'main.tf'], { network: 'none', timeout: 20000 });
        let formatted = hcl;
        try { formatted = fs.readFileSync(tfFile, 'utf8'); } catch (_) {}
        const success = fmtResult.code === 0;
        return { success, formatted, stderr: fmtResult.stderr, message: success ? 'Formatted successfully (Docker)' : fmtResult.stderr || 'Format failed', runner: 'docker' };
      }
      if (resolvedMode === 'docker') {
        return { success: false, formatted: hcl, message: 'Docker daemon unavailable. Start Docker Desktop or install Docker.', runner: 'docker', offline: true };
      }
    }

    return { success: false, formatted: hcl, message: 'Terraform not available locally or via Docker. Install Terraform: https://developer.hashicorp.com/terraform/install', offline: true, runner: 'none' };
  } finally {
    cleanup(workDir);
  }
}

// ─── terraform validate ───────────────────────────────────────────────────────
async function runValidate(hcl, logFn, mode = 'auto') {
  const resolvedMode = resolveMode(mode);
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');
  writeProviderOverride(workDir, hcl);

  // ── 1. Local path ─────────────────────────────────────────────────────────
  if (resolvedMode !== 'docker') {
    const hasTf = await checkTerraform();
    if (hasTf) {
      if (logFn) logFn({ stream: 'info', line: '🖥️  Running terraform validate locally...\n' });
      const env = localEnv(workDir);

      if (logFn) logFn({ stream: 'info', line: '⏳ terraform init (local)...\n' });
      const initRes = await crossExec(
        `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
        { timeout: 180000, env }
      );
      if (!initRes.err) {
        if (logFn) logFn({ stream: 'info', line: '🔍 terraform validate (local)...\n' });
        const valRes = await crossExec(
          `cd "${workDir}" && terraform validate -json 2>&1`,
          { timeout: 30000, env }
        );
        try {
          const lines = valRes.stdout.split('\n').filter(l => l.trim().startsWith('{'));
          const result = JSON.parse(lines[lines.length - 1]);
          cleanup(workDir);
          return { valid: result.valid, diagnostics: result.diagnostics || [], message: result.valid ? 'Configuration is valid (local)' : 'Validation failed', runner: 'local' };
        } catch (_) {
          // JSON parse failed — fall through to Docker if auto
        }
      }
      if (resolvedMode === 'local') {
        cleanup(workDir);
        return { valid: false, diagnostics: [], message: 'Local terraform validate failed', runner: 'local' };
      }
      console.warn('[runner:validate] Local terraform validate failed, trying Docker fallback');
      if (logFn) logFn({ stream: 'info', line: '⚠️  Local validate failed, falling back to Docker sandbox...\n' });
    } else if (resolvedMode === 'local') {
      cleanup(workDir);
      return { valid: null, diagnostics: [], message: 'Terraform not installed locally. Install from https://developer.hashicorp.com/terraform/install', runner: 'local', offline: true };
    }
  }

  // ── 2. Docker path ──────────────────────────────────────────────────────
  if (resolvedMode !== 'local') {
    const useDocker = await dockerAvailable();
    if (useDocker) {
      if (logFn) logFn({ stream: 'info', line: '🐳 Running terraform validate in Docker sandbox...\n' });
      if (logFn) logFn({ stream: 'info', line: '⏳ terraform init (Docker)...\n' });
      const initResult = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], { network: 'bridge', timeout: 180000, logFn });
      if (initResult.code !== 0) {
        cleanup(workDir);
        return { valid: false, diagnostics: [], message: 'terraform init failed: ' + (initResult.stderr || initResult.stdout || 'Unknown error').slice(0, 500), raw: initResult.stderr, runner: 'docker' };
      }
      if (logFn) logFn({ stream: 'info', line: '🔍 terraform validate (Docker)...\n' });
      const valResult = await runInDocker(workDir, ['validate', '-json', '-no-color'], { timeout: 30000, logFn });
      cleanup(workDir);
      try {
        const lines = valResult.stdout.split('\n').filter(l => l.trim().startsWith('{'));
        const parsed = JSON.parse(lines[lines.length - 1]);
        return { valid: parsed.valid, diagnostics: parsed.diagnostics || [], message: parsed.valid ? 'Configuration is valid (Docker)' : 'Validation failed', runner: 'docker' };
      } catch (_) {
        return { valid: false, diagnostics: [], message: valResult.stdout || valResult.stderr || 'Validation error', raw: valResult.stdout, runner: 'docker' };
      }
    }
    if (resolvedMode === 'docker') {
      cleanup(workDir);
      return { valid: null, diagnostics: [], message: 'Docker daemon unavailable. Start Docker Desktop or install Docker.', runner: 'docker', offline: true };
    }
  }

  cleanup(workDir);
  return { valid: null, diagnostics: [], message: 'Terraform not available locally or via Docker. Install from https://developer.hashicorp.com/terraform/install', offline: true, runner: 'none' };
}

// ─── terraform plan ───────────────────────────────────────────────────────────
async function runPlan(hcl, logFn, awsCredentials = null, mode = 'auto') {
  const resolvedMode = resolveMode(mode);
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');
  if (!awsCredentials) writeProviderOverride(workDir, hcl);

  const credEnv = awsCredentials ? {
    AWS_ACCESS_KEY_ID:     awsCredentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: awsCredentials.secretAccessKey,
    AWS_SESSION_TOKEN:     awsCredentials.sessionToken || '',
    AWS_DEFAULT_REGION:    awsCredentials.region || 'us-east-1',
  } : {};
  const network = awsCredentials ? 'bridge' : 'none';

  // ── 1. Local path ─────────────────────────────────────────────────────────
  if (resolvedMode !== 'docker') {
    const hasTf = await checkTerraform();
    if (hasTf) {
      if (logFn) logFn({ stream: 'info', line: '🖥️  Running terraform plan locally...\n' });
      const env = localEnv(workDir, credEnv);

      if (logFn) logFn({ stream: 'info', line: '⏳ Initialising Terraform providers (local)...\n' });
      const initRes = await crossExec(
        `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
        { timeout: 180000, env }
      );
      if (!initRes.err) {
        if (logFn) logFn({ stream: 'info', line: '📋 Running terraform plan (local)...\n' });
        const planRes = await crossExec(
          `cd "${workDir}" && terraform plan -no-color -refresh=false -json 2>&1`,
          { timeout: 300000, env }
        );
        cleanup(workDir);
        return { success: true, message: 'Plan generated (local)', runner: 'local', ...parsePlanJson(planRes.stdout) };
      }
      if (resolvedMode === 'local') {
        cleanup(workDir);
        return { success: false, message: 'Local terraform plan failed', runner: 'local', resource_changes: [] };
      }
      console.warn('[runner:plan] Local terraform plan failed, trying Docker fallback');
      if (logFn) logFn({ stream: 'info', line: '⚠️  Local plan failed, falling back to Docker sandbox...\n' });
    } else if (resolvedMode === 'local') {
      cleanup(workDir);
      return { success: false, message: 'Terraform not installed locally. Install from https://developer.hashicorp.com/terraform/install', runner: 'local', offline: true, resource_changes: [] };
    }
  }

  // ── 2. Docker path ──────────────────────────────────────────────────────
  if (resolvedMode !== 'local') {
    const useDocker = await dockerAvailable();
    if (useDocker) {
      if (logFn) logFn({ stream: 'info', line: '🐳 Running terraform plan in Docker sandbox...\n' });
      if (logFn) logFn({ stream: 'info', line: '⏳ Initialising Terraform providers (Docker)...\n' });
      const initResult = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], { network: 'bridge', timeout: 180000, extraEnv: credEnv, logFn });
      if (initResult.code !== 0) {
        cleanup(workDir);
        return { success: false, message: 'terraform init failed: ' + (initResult.stderr || initResult.stdout || '').slice(0, 500), raw: initResult.stderr, resource_changes: [], runner: 'docker' };
      }
      if (logFn) logFn({ stream: 'info', line: '📋 Running terraform plan (Docker)...\n' });
      const planResult = await runInDocker(workDir, ['plan', '-no-color', '-refresh=false', '-json'], { network, timeout: 300000, extraEnv: credEnv, logFn });
      cleanup(workDir);
      if (planResult.code !== 0 && !planResult.stdout.includes('"type"')) {
        return { success: false, message: 'terraform plan failed', raw: planResult.stderr, resource_changes: [], runner: 'docker' };
      }
      return { success: true, message: 'Plan generated (Docker)', runner: 'docker', ...parsePlanJson(planResult.stdout) };
    }
    if (resolvedMode === 'docker') {
      cleanup(workDir);
      return { success: false, message: 'Docker daemon unavailable. Start Docker Desktop or install Docker.', runner: 'docker', offline: true, resource_changes: [] };
    }
  }

  cleanup(workDir);
  return { success: false, message: 'Terraform not available locally or via Docker. Install from https://developer.hashicorp.com/terraform/install', offline: true, resource_changes: [], runner: 'none' };
}

// ─── terraform init ───────────────────────────────────────────────────────────
async function runInit(hcl, logFn, mode = 'auto') {
  const resolvedMode = resolveMode(mode);
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');
  writeProviderOverride(workDir, hcl);

  const outputLines = [];
  const capture = (data) => {
    const line = String(data?.line || data || '').trim();
    if (line) outputLines.push(line);
    if (logFn) logFn(data);
  };

  try {
    // ── 1. Local path ──────────────────────────────────────────────────────
    if (resolvedMode !== 'docker') {
      const hasTf = await checkTerraform();
      if (hasTf) {
        capture({ stream: 'info', line: '🖥️  Running terraform init locally...' });
        const env = localEnv(workDir);

        const { err, stdout, stderr } = await crossExec(
          `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
          { timeout: 180000, env }
        );

        if (!err) {
          return {
            success:  true,
            message:  'Terraform initialized successfully (local)',
            output:   [...outputLines, stdout].filter(Boolean).join('\n').slice(0, 4000),
            exitCode: 0,
            runner:   'local',
          };
        }

        if (resolvedMode === 'local') {
          const localErr = (stdout || stderr || '').slice(0, 500);
          return {
            success:  false,
            message:  `Local terraform init failed: ${localErr}`,
            output:   outputLines.join('\n'),
            exitCode: 1,
            runner:   'local',
          };
        }

        const localErr = (stdout || stderr || '').slice(0, 500);
        console.warn('[runner:init] Local terraform init failed:', localErr);
        capture({ stream: 'info', line: `⚠️  Local init failed: ${localErr}\n   → Falling back to Docker sandbox...` });
      } else if (resolvedMode === 'local') {
        return {
          success:  false,
          message:  'Terraform not installed locally. Install from https://developer.hashicorp.com/terraform/install',
          output:   outputLines.join('\n'),
          exitCode: 1,
          runner:   'local',
          offline:  true,
        };
      } else {
        capture({ stream: 'info', line: '🐳 terraform not found locally — trying Docker sandbox...' });
      }
    }

    // ── 2. Docker path ────────────────────────────────────────────────────
    if (resolvedMode !== 'local') {
      const useDocker = await dockerAvailable();
      if (useDocker) {
        capture({ stream: 'info', line: '🐳 Running terraform init in Docker sandbox...' });
        const result = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], {
          network: 'bridge', timeout: 180000, logFn: capture,
        });
        return {
          success:  result.code === 0,
          message:  result.code === 0 ? 'Terraform initialized successfully (Docker)' : 'terraform init failed',
          output:   [...outputLines, result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000),
          exitCode: result.code,
          runner:   'docker',
        };
      }
      if (resolvedMode === 'docker') {
        return {
          success:  false,
          message:  'Docker daemon unavailable. Start Docker Desktop or install Docker.',
          output:   outputLines.join('\n'),
          exitCode: 1,
          runner:   'docker',
          offline:  true,
        };
      }
    }

    // ── 3. Nothing available ─────────────────────────────────────────────
    return {
      success:  false,
      message:  'Terraform not available locally or via Docker. Install from https://developer.hashicorp.com/terraform/install',
      output:   outputLines.join('\n'),
      exitCode: 1,
      runner:   'none',
      offline:  true,
    };
  } finally {
    cleanup(workDir);
  }
}

// ─── terraform apply ──────────────────────────────────────────────────────────
// Unlike fmt/validate/plan, apply always requires REAL AWS credentials and
// always needs network access — it provisions actual infrastructure. We
// never write the mock `skip_credentials_validation` provider override here:
// applying against mock credentials would either fail confusingly or (worse)
// silently no-op, giving the user false confidence that something was
// deployed. Callers MUST pass awsCredentials; this is enforced again in
// services/terraformJobs.js before this function is ever reached.
async function runApply(hcl, logFn, awsCredentials, mode = 'auto') {
  if (!awsCredentials || !awsCredentials.accessKeyId || !awsCredentials.secretAccessKey) {
    return {
      success: false,
      message: 'AWS credentials are required to apply. Connect an AWS account under Settings → AWS Credentials first.',
      resource_changes: [],
    };
  }

  const resolvedMode = resolveMode(mode);
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');

  const credEnv = {
    AWS_ACCESS_KEY_ID:     awsCredentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: awsCredentials.secretAccessKey,
    AWS_SESSION_TOKEN:     awsCredentials.sessionToken || '',
    AWS_DEFAULT_REGION:    awsCredentials.region || 'us-east-1',
  };

  // ── 1. Local path ─────────────────────────────────────────────────────────
  if (resolvedMode !== 'docker') {
    const hasTf = await checkTerraform();
    if (hasTf) {
      if (logFn) logFn({ stream: 'info', line: '🖥️  Running terraform apply locally...\n' });
      const env = localEnv(workDir, credEnv);

      if (logFn) logFn({ stream: 'info', line: '⏳ Initialising Terraform providers (local)...\n' });
      const initRes = await crossExec(
        `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
        { timeout: 180000, env }
      );
      if (initRes.err) {
        cleanup(workDir);
        const localErr = (initRes.stdout || initRes.stderr || '').slice(0, 500);
        if (resolvedMode === 'local') {
          return { success: false, message: `terraform init failed: ${localErr}`, raw: initRes.stderr, resource_changes: [], runner: 'local' };
        }
        console.warn('[runner:apply] Local terraform init failed, trying Docker fallback');
      } else {
        if (logFn) logFn({ stream: 'info', line: '🚀 Running terraform apply -auto-approve (local)...\n' });
        const applyRes = await crossExecStreaming(
          `cd "${workDir}" && terraform apply -auto-approve -no-color -json 2>&1`,
          { timeout: 600000, env },
          logFn
        );
        cleanup(workDir);
        const parsed = parsePlanJson(applyRes.stdout);
        const success = applyRes.err === null || applyRes.err === undefined;
        return {
          success,
          message: success ? 'Apply completed successfully (local)' : 'terraform apply failed',
          runner: 'local',
          ...parsed,
          raw: success ? undefined : (applyRes.stderr || applyRes.stdout || '').slice(0, 4000),
        };
      }
    } else if (resolvedMode === 'local') {
      cleanup(workDir);
      return { success: false, message: 'Terraform not installed locally. Install from https://developer.hashicorp.com/terraform/install', runner: 'local', offline: true, resource_changes: [] };
    }
  }

  // ── 2. Docker path ──────────────────────────────────────────────────────
  if (resolvedMode !== 'local') {
    const useDocker = await dockerAvailable();
    if (useDocker) {
      if (logFn) logFn({ stream: 'info', line: '🐳 Running terraform apply in Docker sandbox...\n' });
      if (logFn) logFn({ stream: 'info', line: '⏳ Initialising Terraform providers (Docker)...\n' });
      const initResult = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], { network: 'bridge', timeout: 180000, extraEnv: credEnv, logFn });
      if (initResult.code !== 0) {
        cleanup(workDir);
        return { success: false, message: 'terraform init failed: ' + (initResult.stderr || initResult.stdout || '').slice(0, 500), raw: initResult.stderr, resource_changes: [], runner: 'docker' };
      }
      if (logFn) logFn({ stream: 'info', line: '🚀 Running terraform apply -auto-approve (Docker)...\n' });
      const applyResult = await runInDocker(workDir, ['apply', '-auto-approve', '-no-color', '-json'], { network: 'bridge', timeout: 600000, extraEnv: credEnv, logFn });
      cleanup(workDir);
      const parsed = parsePlanJson(applyResult.stdout);
      if (applyResult.code !== 0 && !applyResult.stdout.includes('"type"')) {
        return { success: false, message: 'terraform apply failed', raw: applyResult.stderr, resource_changes: [], runner: 'docker' };
      }
      return { success: applyResult.code === 0, message: applyResult.code === 0 ? 'Apply completed successfully (Docker)' : 'terraform apply failed', runner: 'docker', ...parsed };
    }
    if (resolvedMode === 'docker') {
      cleanup(workDir);
      return { success: false, message: 'Docker daemon unavailable. Start Docker Desktop or install Docker.', runner: 'docker', offline: true, resource_changes: [] };
    }
  }

  cleanup(workDir);
  return { success: false, message: 'Terraform not available locally or via Docker. Install from https://developer.hashicorp.com/terraform/install', offline: true, resource_changes: [], runner: 'none' };
}

module.exports = { runFmt, runValidate, runPlan, runInit, runApply };
