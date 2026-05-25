'use strict';
/**
 * Terraform runner — Docker-sandboxed execution with host-exec fallback.
 *
 * Security model:
 *  - Each operation runs in an ephemeral Docker container (--rm)
 *  - --network=none for fmt/validate (no internet needed)
 *  - --memory=512m --cpus=1.0 --pids-limit=50 resource caps
 *  - Container runs as non-root (UID 1000)
 *  - HCL mounted read-only where possible; output via stdout only
 *  - Container destroyed immediately after operation
 *
 * Fallback: if Docker daemon is unavailable, falls back to host exec()
 * with a warning. Acceptable in development only.
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
// cannot change silently between server restarts (mutable tags like ":1.7" can
// be re-pointed at any time, including to a supply-chain-compromised image).
//
// Digest below is terraform 1.10.5 (linux/amd64) — update intentionally on
// each planned upgrade and verify with:
//   docker pull hashicorp/terraform:1.10.5
//   docker inspect hashicorp/terraform:1.10.5 --format='{{index .RepoDigests 0}}'
//
// Override at runtime via the TF_DOCKER_IMAGE environment variable.
const TF_DOCKER_IMAGE = process.env.TF_DOCKER_IMAGE ||
  'hashicorp/terraform@sha256:1a8d5d7c0c2e52434f9a11a5bcd7f9cf1a5eab72c67fd9f2cd1be2f2b87ee41e';

const IS_WINDOWS = process.platform === 'win32';

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Detect provider prefixes in HCL (e.g. "aws_instance" → "aws") and write
 * a _providers_override.tf file so `terraform init` knows what to download
 * and can skip credential validation.  This prevents init failures when the
 * user has no AWS credentials configured on the server.
 */
function writeProviderOverride(workDir, hcl) {
  const prefixes = new Set();
  const re = /(?:resource|data)\s+"([a-z][a-z0-9]*)_/g;
  let m;
  while ((m = re.exec(hcl)) !== null) prefixes.add(m[1]);

  // Only inject if the HCL doesn't already include skip_credentials_validation
  if (/skip_credentials_validation/.test(hcl)) return;

  const blocks = [];
  for (const p of prefixes) {
    if (p === 'aws') {
      blocks.push(`provider "aws" {
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  access_key                  = "mock"
  secret_key                  = "mock"
  region                      = "us-east-1"
}`);
    }
    // Add other cloud providers here if needed (azurerm, google, etc.)
  }

  if (blocks.length > 0) {
    fs.writeFileSync(
      path.join(workDir, '_providers_override.tf'),
      blocks.join('\n\n') + '\n',
      'utf8'
    );
  }
}

/**
 * Execute a shell command cross-platform (handles Windows vs Unix).
 * On Windows, uses cmd.exe; on Unix, uses sh.
 */
function crossExec(cmd, opts = {}) {
  return new Promise(resolve => {
    const execOpts = { timeout: opts.timeout || 120000, ...opts };
    if (IS_WINDOWS) {
      // Use cmd.exe /c on Windows for && chaining and 2>&1 redirect
      execOpts.shell = 'cmd.exe';
    }
    exec(cmd, execOpts, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Check if Docker daemon is available — result is memoised after first call */
const dockerAvailable = (() => {
  let _cached = null;
  return () => {
    if (_cached !== null) return Promise.resolve(_cached);
    return new Promise(resolve => {
      exec('docker info --format "{{.ServerVersion}}"', { timeout: 5000 }, (err) => {
        _cached = !err;
        if (!_cached) console.warn('[runner] Docker unavailable — using host-exec fallback (dev only)');
        resolve(_cached);
      });
    });
  };
})();

/** Check if terraform CLI is available on host (fallback path) */
function checkTerraform() {
  return new Promise(resolve => exec('terraform version', { timeout: 10000 }, (err) => resolve(!err)));
}

/**
 * Run terraform inside Docker (writable workDir for init artifacts).
 * @param {string}   workDir  - host temp directory
 * @param {string[]} tfArgs   - terraform subcommand args
 * @param {object}   opts     - { network, timeout, extraEnv, logFn }
 */
function runInDocker(workDir, tfArgs, opts = {}) {
  const { network = 'none', timeout = 120000, extraEnv = {}, logFn = null } = opts;

  // BUG-002 fix: build an explicit argument array instead of a shell command
  // string. This bypasses shell interpretation entirely, preventing credential
  // values that contain backticks, $(...) or other metacharacters from being
  // executed as shell commands on the host.
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
  // Each env-var is a separate '-e', 'KEY=VALUE' pair — no shell involved
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
async function runFmt(hcl, logFn) {
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  const tfFile = path.join(workDir, 'main.tf');
  fs.writeFileSync(tfFile, hcl, 'utf8');

  const useDocker = await dockerAvailable();
  if (useDocker) {
    const dockerCmd = [
      'docker run --rm',
      '--network=none --memory=256m --cpus=0.5 --pids-limit=20',
      '--user=1000:1000',
      `-v "${workDir}":/workspace:rw`,
      '-w /workspace', TF_DOCKER_IMAGE,
      'fmt', '-no-color', 'main.tf',
    ].join(' ');
    return new Promise(resolve => {
      exec(dockerCmd, { timeout: 20000 }, (err, _out, stderr_) => {
        let formatted = hcl;
        try { formatted = fs.readFileSync(tfFile, 'utf8'); } catch (_) {}
        cleanup(workDir);
        resolve({ success: !err, formatted, stderr: stderr_, message: !err ? 'Formatted successfully' : stderr_ || 'Format failed' });
      });
    });
  }

  // Host fallback
  const hasTf = await checkTerraform();
  if (!hasTf) { cleanup(workDir); return { success: false, formatted: hcl, message: 'Terraform CLI not found. Install Terraform to enable formatting.', offline: true }; }
  const { err, stdout: _, stderr: stderr_ } = await crossExec(
    `cd "${workDir}" && terraform fmt -no-color "main.tf"`,
    { timeout: 15000 }
  );
  let formatted = hcl;
  try { formatted = fs.readFileSync(tfFile, 'utf8'); } catch (_) {}
  cleanup(workDir);
  return { success: !err, formatted, stderr: stderr_, message: !err ? 'Formatted successfully' : stderr_ || 'Format failed' };
}

// ─── terraform validate ───────────────────────────────────────────────────────
async function runValidate(hcl, logFn) {
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');
  // Inject provider override so init doesn't need real AWS credentials
  writeProviderOverride(workDir, hcl);

  const useDocker = await dockerAvailable();
  if (useDocker) {
    if (logFn) logFn({ stream: 'info', line: '⏳ Running terraform init...\n' });
    const initResult = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], { network: 'bridge', timeout: 180000, logFn });
    if (initResult.code !== 0) {
      cleanup(workDir);
      return { valid: false, diagnostics: [], message: 'terraform init failed: ' + (initResult.stderr || initResult.stdout || 'Unknown error').slice(0, 500), raw: initResult.stderr };
    }
    if (logFn) logFn({ stream: 'info', line: '🔍 Running terraform validate...\n' });
    const valResult = await runInDocker(workDir, ['validate', '-json', '-no-color'], { timeout: 30000, logFn });
    cleanup(workDir);
    try {
      const lines = valResult.stdout.split('\n').filter(l => l.trim().startsWith('{'));
      const parsed = JSON.parse(lines[lines.length - 1]);
      return { valid: parsed.valid, diagnostics: parsed.diagnostics || [], message: parsed.valid ? 'Configuration is valid' : 'Validation failed' };
    } catch (_) {
      return { valid: false, diagnostics: [], message: valResult.stdout || valResult.stderr || 'Validation error', raw: valResult.stdout };
    }
  }

  // Host fallback
  const hasTf = await checkTerraform();
  if (!hasTf) { cleanup(workDir); return { valid: null, diagnostics: [], message: 'Terraform CLI not found. Install Terraform from https://developer.hashicorp.com/terraform/install to enable validation.', offline: true }; }

  const tfrcPath = path.join(workDir, '.terraformrc');
  fs.writeFileSync(tfrcPath, `plugin_cache_dir = "${PLUGIN_CACHE.replace(/\\/g, '/')}"\n`, 'utf8');
  const env = { ...process.env, TF_CLI_CONFIG_FILE: tfrcPath, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_INPUT: 'false' };

  if (logFn) logFn({ stream: 'info', line: '⏳ Running terraform init (host)...\n' });
  const initRes = await crossExec(
    `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
    { timeout: 180000, env }
  );
  if (initRes.err) {
    cleanup(workDir);
    const raw = initRes.stdout || initRes.stderr || '';
    return { valid: false, diagnostics: [], message: 'terraform init failed: ' + raw.slice(0, 500), raw };
  }

  if (logFn) logFn({ stream: 'info', line: '🔍 Running terraform validate (host)...\n' });
  const valRes = await crossExec(
    `cd "${workDir}" && terraform validate -json 2>&1`,
    { timeout: 30000, env }
  );
  cleanup(workDir);
  try {
    const lines = valRes.stdout.split('\n').filter(l => l.trim().startsWith('{'));
    const result = JSON.parse(lines[lines.length - 1]);
    return { valid: result.valid, diagnostics: result.diagnostics || [], message: result.valid ? 'Configuration is valid' : 'Validation failed' };
  } catch (_) {
    return { valid: false, diagnostics: [], message: valRes.stdout || valRes.stderr || 'Validation error', raw: valRes.stdout };
  }
}

// ─── terraform plan ───────────────────────────────────────────────────────────
async function runPlan(hcl, logFn, awsCredentials = null) {
  const sessionId = uuidv4();
  const workDir   = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');
  // Only inject provider override when NO real credentials are supplied
  if (!awsCredentials) writeProviderOverride(workDir, hcl);

  const useDocker = await dockerAvailable();
  const credEnv = awsCredentials ? {
    AWS_ACCESS_KEY_ID:     awsCredentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: awsCredentials.secretAccessKey,
    AWS_SESSION_TOKEN:     awsCredentials.sessionToken || '',
    AWS_DEFAULT_REGION:    awsCredentials.region || 'us-east-1',
  } : {};
  const network = awsCredentials ? 'bridge' : 'none';

  if (useDocker) {
    if (logFn) logFn({ stream: 'info', line: '⏳ Initialising Terraform providers...\n' });
    const initResult = await runInDocker(workDir, ['init', '-backend=false', '-no-color'], { network: 'bridge', timeout: 180000, extraEnv: credEnv, logFn });
    if (initResult.code !== 0) {
      cleanup(workDir);
      return { success: false, message: 'terraform init failed: ' + (initResult.stderr || initResult.stdout || '').slice(0, 500), raw: initResult.stderr, resource_changes: [] };
    }
    if (logFn) logFn({ stream: 'info', line: '📋 Running terraform plan...\n' });
    const planResult = await runInDocker(workDir, ['plan', '-no-color', '-refresh=false', '-json'], { network, timeout: 300000, extraEnv: credEnv, logFn });
    cleanup(workDir);
    if (planResult.code !== 0 && !planResult.stdout.includes('"type"')) {
      return { success: false, message: 'terraform plan failed', raw: planResult.stderr, resource_changes: [] };
    }
    return { success: true, message: 'Plan generated', ...parsePlanJson(planResult.stdout) };
  }

  // Host fallback
  const hasTf = await checkTerraform();
  if (!hasTf) { cleanup(workDir); return { success: false, message: 'Terraform CLI not found. Install Terraform to enable plan.', offline: true, resource_changes: [] }; }
  const tfrcPath = path.join(workDir, '.terraformrc');
  fs.writeFileSync(tfrcPath, `plugin_cache_dir = "${PLUGIN_CACHE.replace(/\\/g, '/')}"\n`, 'utf8');
  const env = { ...process.env, ...credEnv, TF_CLI_CONFIG_FILE: tfrcPath, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_INPUT: 'false' };

  const initRes = await crossExec(
    `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
    { timeout: 180000, env }
  );
  if (initRes.err) {
    cleanup(workDir);
    return { success: false, message: 'terraform init failed: ' + (initRes.stdout || initRes.stderr || '').slice(0, 500), raw: initRes.stdout, resource_changes: [] };
  }
  const planRes = await crossExec(
    `cd "${workDir}" && terraform plan -no-color -refresh=false -json 2>&1`,
    { timeout: 300000, env }
  );
  cleanup(workDir);
  return { success: true, message: 'Plan generated', ...parsePlanJson(planRes.stdout) };
}

module.exports = { runFmt, runValidate, runPlan };
