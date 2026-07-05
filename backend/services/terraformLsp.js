'use strict';
const { spawn }        = require('child_process');
const fs               = require('fs');
const os               = require('os');
const path             = require('path');
const { v4: uuidv4 }  = require('uuid');
const { pathToFileURL } = require('url');

// ── Workspace base ────────────────────────────────────────────────────────────
const WORKSPACE_BASE = path.join(os.tmpdir(), 'tfgen-terraform-lsp');
if (!fs.existsSync(WORKSPACE_BASE)) fs.mkdirSync(WORKSPACE_BASE, { recursive: true });

// The binary path — set TF_LSP_PATH in backend/.env
const TFLSP_CMD = process.env.TF_LSP_PATH || 'terraform-ls';

// SECURITY FIX: sessions used to live forever as long as the socket stayed
// open, with no bound on how long a spawned terraform-ls process + workspace
// dir could sit idle. Combined with the per-user/global caps added in
// server.js, an idle session now self-terminates instead of permanently
// occupying one of those slots.
const IDLE_TIMEOUT_MS = parseInt(process.env.TF_LSP_IDLE_TIMEOUT_MS || String(20 * 60 * 1000), 10); // 20 min

// ── URI helpers ───────────────────────────────────────────────────────────────
// The frontend uses stable virtual URIs: file:///terraform/<filename>
// We translate these to the actual on-disk workspace paths so terraform-ls
// can index them properly.
const CLIENT_BASE = 'file:///terraform/';

function clientUriToServer(clientUri, workspaceDir) {
  if (!clientUri.startsWith(CLIENT_BASE)) return clientUri;
  const filename = decodeURIComponent(clientUri.slice(CLIENT_BASE.length));
  // Guard against path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return clientUri;
  return pathToFileURL(path.join(workspaceDir, filename)).href;
}

function serverUriToClient(serverUri, workspaceDir) {
  const serverBase = pathToFileURL(workspaceDir).href;
  // Handle both with and without trailing slash
  const base = serverBase.endsWith('/') ? serverBase : serverBase + '/';
  if (serverUri.startsWith(base)) {
    return CLIENT_BASE + serverUri.slice(base.length);
  }
  return serverUri;
}

/**
 * Replace all server-side URIs (workspace paths) in a JSON payload string
 * with their stable client-side equivalents.
 */
function translateAllUrisToClient(payloadStr, workspaceDir) {
  const serverBase = pathToFileURL(workspaceDir).href;
  // Normalise: strip trailing slash so the regex works with or without it
  const base = serverBase.replace(/\/$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return payloadStr.replace(
    new RegExp(escaped + '/?([\\w.%-]+)', 'g'),
    (_, filename) => CLIENT_BASE + decodeURIComponent(filename),
  );
}

/**
 * Replace all client-side virtual URIs in a JSON payload string with their
 * real on-disk paths for terraform-ls.
 */
function translateAllUrisToServer(payloadStr, workspaceDir) {
  const escaped = CLIENT_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return payloadStr.replace(
    new RegExp(escaped + '([\\w.-]+)', 'g'),
    (_, filename) => {
      // Guard against path traversal
      if (filename.includes('..') || filename.includes('\\')) return CLIENT_BASE + filename;
      return pathToFileURL(path.join(workspaceDir, filename)).href;
    },
  );
}

// ── Workspace helpers ─────────────────────────────────────────────────────────
function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function createWorkspaceDirectory() {
  const dir = path.join(WORKSPACE_BASE, uuidv4());
  fs.mkdirSync(dir, { recursive: true });
  // Seed a minimal main.tf so terraform-ls recognises a valid workspace root
  fs.writeFileSync(path.join(dir, 'main.tf'), '', 'utf8');
  return dir;
}

// Write or update a file in the workspace from textDocument/didOpen or
// textDocument/didChange content, so terraform-ls can cross-reference files.
function syncFileToWorkspace(workspaceDir, filename, content) {
  try {
    // Only allow simple .tf filenames (no path separators)
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) return;
    fs.writeFileSync(path.join(workspaceDir, filename), content, 'utf8');
  } catch (_) {}
}

// ── LSP session ───────────────────────────────────────────────────────────────
class TerraformLspSession {
  constructor(ws, logger) {
    this.ws           = ws;
    this.logger       = logger;
    this.workspaceDir = createWorkspaceDirectory();
    this.rootUri      = pathToFileURL(this.workspaceDir).href;
    this.sequence     = 1;
    this.pending      = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.alive        = true;
    this.process      = null;
    this.idleTimer    = null;
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.info(`[terraform-lsp] session idle for ${IDLE_TIMEOUT_MS}ms — closing (workspace: ${this.workspaceDir})`);
      this._sendClientError('Session closed due to inactivity.');
      this.dispose();
    }, IDLE_TIMEOUT_MS);
    // Don't let this timer keep the Node process alive on its own.
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  start() {
    const args = ['serve'];
    this.logger.info(
      `[terraform-lsp] launching: ${TFLSP_CMD} ${args.join(' ')}\n` +
      `  workspace : ${this.workspaceDir}\n` +
      `  rootUri   : ${this.rootUri}\n` +
      `  TF_LSP_PATH env-var controls binary location.`,
    );

    try {
      this.process = spawn(TFLSP_CMD, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this._handleSpawnError(err);
      return;
    }

    this.process.on('error',   (err)          => this._onProcessError(err));
    this.process.stdout.on('data', (chunk)    => this._onStdout(chunk));
    this.process.stderr.on('data', (chunk)    => this._onStderr(chunk));
    this.process.on('exit',    (code, signal) => this._onProcessExit(code, signal));

    this.ws.on('message', (msg) => this._onClientMessage(msg));
    this.ws.on('close',   ()    => this.dispose());
    this.ws.on('error',   ()    => this.dispose());

    this._resetIdleTimer();
    this._sendClientLog('info', `terraform-ls session started (workspace: ${this.workspaceDir})`);
  }

  _handleSpawnError(err) {
    const hint = err.code === 'ENOENT'
      ? `terraform-ls binary not found at "${TFLSP_CMD}". ` +
        `Install it from https://releases.hashicorp.com/terraform-ls/ and set TF_LSP_PATH in backend/.env`
      : `Failed to start terraform-ls: ${err.message}`;
    this.logger.error(`[terraform-lsp] ${hint}`);
    this._sendClientError(hint);
    this.dispose();
  }

  _onProcessError(err) {
    if (err.code === 'ENOENT') {
      const hint =
        `terraform-ls binary not found at "${TFLSP_CMD}".\n` +
        `Install it from https://releases.hashicorp.com/terraform-ls/ ` +
        `and set TF_LSP_PATH=/full/path/to/terraform-ls in backend/.env`;
      this.logger.error(`[terraform-lsp] ${hint}`);
      this._sendClientError(hint);
    } else {
      this.logger.error(`[terraform-lsp] process error: ${err.message}`);
      this._sendClientError(err.message);
    }
    this.dispose();
  }

  // ── stdout: terraform-ls → frontend ──────────────────────────────────────
  _onStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = this.stdoutBuffer.slice(0, headerEnd).toString('utf8');
      const match  = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.logger.error('[terraform-lsp] Missing Content-Length in stdout header');
        return this.dispose();
      }

      const contentLength = parseInt(match[1], 10);
      const msgStart      = headerEnd + 4;
      const msgEnd        = msgStart + contentLength;
      if (this.stdoutBuffer.length < msgEnd) return;

      const raw         = this.stdoutBuffer.slice(msgStart, msgEnd).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.slice(msgEnd);

      try {
        // Translate all on-disk URIs back to stable client URIs
        const translated = translateAllUrisToClient(raw, this.workspaceDir);
        const payload    = JSON.parse(translated);
        if (this.ws.readyState === this.ws.OPEN) {
          this.ws.send(JSON.stringify(payload));
        }
      } catch (err) {
        this.logger.error('[terraform-lsp] Failed to parse server message: ' + err.message);
      }
    }
  }

  // ── stdin: frontend → terraform-ls ────────────────────────────────────────
  _onClientMessage(rawMsg) {
    if (!this.alive) return;
    this._resetIdleTimer();
    let payload;
    try {
      payload = JSON.parse(typeof rawMsg === 'string' ? rawMsg : rawMsg.toString('utf8'));
    } catch (err) {
      this.logger.warn('[terraform-lsp] Invalid JSON from client: ' + err.message);
      return;
    }

    // ── Intercept: initialize — inject real workspace paths ────────────────
    if (payload.method === 'initialize') {
      // Ensure rootUri has a trailing slash — terraform-ls uses it as the
      // workspace root prefix when resolving relative file URIs.
      const rootUri = this.rootUri.endsWith('/')
        ? this.rootUri
        : this.rootUri + '/';

      payload.params = {
        ...payload.params,
        rootUri,
        rootPath:         this.workspaceDir,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        // initializationOptions tells terraform-ls to pre-load the AWS
        // provider schema so completions are available immediately.
        initializationOptions: {
          ...(payload.params?.initializationOptions || {}),
          experimentalFeatures: { prefillRequiredFields: true },
          // Only pass terraform.path if it's an absolute path —
          // terraform-ls rejects relative names like "terraform" with -32098.
          // If unset, terraform-ls auto-discovers the binary from PATH.
          ...(process.env.TERRAFORM_PATH?.startsWith('/')
            ? { terraform: { path: process.env.TERRAFORM_PATH } }
            : {}),
        },
      };
      this._writeToProcess(payload);
      return;
    }

    // ── Intercept: textDocument/didOpen — sync file to workspace ──────────
    if (payload.method === 'textDocument/didOpen') {
      const doc = payload.params?.textDocument;
      if (doc?.uri && doc.uri.startsWith(CLIENT_BASE)) {
        const filename = doc.uri.slice(CLIENT_BASE.length);
        syncFileToWorkspace(this.workspaceDir, filename, doc.text || '');
      }
    }

    // ── Intercept: textDocument/didChange — sync content to workspace ──────
    if (payload.method === 'textDocument/didChange') {
      const uri = payload.params?.textDocument?.uri;
      if (uri && uri.startsWith(CLIENT_BASE)) {
        const filename = uri.slice(CLIENT_BASE.length);
        const changes  = payload.params?.contentChanges || [];
        if (changes.length) {
          syncFileToWorkspace(this.workspaceDir, filename, changes[changes.length - 1].text || '');
        }
      }
    }

    // Translate all client URIs to real on-disk paths before forwarding
    const raw        = JSON.stringify(payload);
    const translated = translateAllUrisToServer(raw, this.workspaceDir);
    const forwarded  = JSON.parse(translated);

    this._writeToProcess(forwarded);
  }

  _onStderr(chunk) {
    const msg = chunk.toString('utf8').trim();
    if (!msg) return;
    this.logger.warn(`[terraform-ls stderr] ${msg}`);
    this._sendClientLog('warning', msg);
  }

  _onProcessExit(code, signal) {
    if (!this.alive) return;
    const reason = code !== null ? `exit code ${code}` : `signal ${signal}`;
    this.logger.info(`[terraform-lsp] process exited (${reason})`);
    this._sendClientError(`terraform-ls stopped: ${reason}`);
    this.dispose();
  }

  _writeToProcess(payload) {
    if (!this.process?.stdin?.writable) return;
    const body   = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    this.process.stdin.write(header + body, 'utf8');
  }

  _sendClientLog(severity, message) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'window/logMessage',
      params: { type: severity, message },
    }));
  }

  _sendClientError(message) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'window/showMessage',
      params: { type: 1, message },
    }));
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try { this.ws.close(); }                                         catch (_) {}
    try { if (this.process && !this.process.killed) this.process.kill('SIGKILL'); } catch (_) {}
    cleanupDir(this.workspaceDir);
  }
}

function attachTerraformLspSession(ws, logger) {
  const session = new TerraformLspSession(ws, logger);
  session.start();
  return session;
}

module.exports = { attachTerraformLspSession };
