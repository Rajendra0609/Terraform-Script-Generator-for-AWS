const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

const WORKSPACE = path.join(os.tmpdir(), 'tfgen-workspaces');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

// Shared plugin cache so AWS provider is downloaded only once
const PLUGIN_CACHE = path.join(os.tmpdir(), 'tfgen-plugin-cache');
if (!fs.existsSync(PLUGIN_CACHE)) fs.mkdirSync(PLUGIN_CACHE, { recursive: true });

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function checkTerraform() {
  return new Promise((resolve) => {
    exec('terraform version', { timeout: 10000 }, (err) => resolve(!err));
  });
}

/**
 * terraform fmt — purely syntactic, NO init or providers needed.
 */
async function runFmt(hcl) {
  const hasTf = await checkTerraform();
  if (!hasTf) {
    return {
      success: false,
      formatted: hcl,
      message: 'Terraform CLI not found on server. Install terraform to use fmt.',
      offline: true,
    };
  }
  const sessionId = uuidv4();
  const workDir = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  const tfFile = path.join(workDir, 'main.tf');
  fs.writeFileSync(tfFile, hcl, 'utf8');

  return new Promise((resolve) => {
    // fmt on a single file — no init required
    exec(`terraform fmt "${tfFile}"`, { timeout: 15000 }, (err, stdout, stderr) => {
      let formatted = hcl;
      try { formatted = fs.readFileSync(tfFile, 'utf8'); } catch (_) {}
      cleanup(workDir);
      resolve({
        success: !err,
        formatted,
        stderr: stderr || '',
        message: !err ? 'Formatted successfully' : (stderr || stdout || 'Format failed'),
      });
    });
  });
}

/**
 * terraform validate — requires providers.
 * Uses a shared TF_PLUGIN_CACHE_DIR so the AWS provider is only downloaded once.
 */
async function runValidate(hcl) {
  const hasTf = await checkTerraform();
  if (!hasTf) {
    return {
      valid: null,
      diagnostics: [],
      message: 'Terraform CLI not found on server. Install terraform to use validate.',
      offline: true,
    };
  }
  const sessionId = uuidv4();
  const workDir = path.join(WORKSPACE, sessionId);
  fs.mkdirSync(workDir);
  fs.writeFileSync(path.join(workDir, 'main.tf'), hcl, 'utf8');

  // Point terraform at the shared plugin cache
  const tfrcPath = path.join(workDir, '.terraformrc');
  fs.writeFileSync(tfrcPath, `plugin_cache_dir = "${PLUGIN_CACHE.replace(/\\/g, '/')}"\n`, 'utf8');

  const env = {
    ...process.env,
    TF_CLI_CONFIG_FILE: tfrcPath,
    TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
  };

  return new Promise((resolve) => {
    exec(
      `cd "${workDir}" && terraform init -backend=false -no-color 2>&1`,
      { timeout: 180000, env },
      (initErr, initOut) => {
        if (initErr) {
          cleanup(workDir);
          return resolve({
            valid: false,
            diagnostics: [],
            message: 'terraform init failed — check network/provider config.',
            raw: initOut,
          });
        }
        exec(
          `cd "${workDir}" && terraform validate -json`,
          { timeout: 30000, env },
          (err, stdout, stderr) => {
            cleanup(workDir);
            try {
              const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
              const result = JSON.parse(lines[lines.length - 1]);
              resolve({
                valid: result.valid,
                diagnostics: result.diagnostics || [],
                message: result.valid ? 'Configuration is valid' : 'Validation failed',
              });
            } catch (_) {
              resolve({
                valid: false,
                diagnostics: [],
                message: stdout || stderr || 'Validation error (could not parse output)',
                raw: stdout,
              });
            }
          }
        );
      }
    );
  });
}

module.exports = { runFmt, runValidate };
