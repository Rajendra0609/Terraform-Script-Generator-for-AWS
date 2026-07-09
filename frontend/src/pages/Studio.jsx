import React, {
  useCallback, useEffect, useRef, useState, useMemo,
} from 'react';
import { useNavigate } from 'react-router-dom';
import MonacoEditor from '@monaco-editor/react';
import { terraformAPI, terraformLspAPI, hclAssistAPI } from '../api/client';
import sanitizeHcl from '../utils/sanitizeHcl';
import { DEFAULT_AWS_REGION } from '../utils/awsRegions';

// ── Default file templates ──────────────────────────────────────────────────
const DEFAULT_FILES = {
  'main.tf': [
    '# main.tf — Core infrastructure resources',
    '',
    'terraform {',
    '  required_version = ">= 1.5.0"',
    '',
    '  required_providers {',
    '    aws = {',
    '      source  = "hashicorp/aws"',
    '      version = "~> 5.0"',
    '    }',
    '  }',
    '}',
    '',
    'provider "aws" {',
    '  region = var.aws_region',
    '',
    '  default_tags {',
    '    tags = {',
    '      Project     = var.project_name',
    '      Environment = var.environment',
    '      ManagedBy   = "terraform"',
    '    }',
    '  }',
    '}',
    '',
    '# Add your resources here',
    '',
  ].join('\n'),

  'variables.tf': [
    '# variables.tf — Input variable declarations',
    '',
    'variable "aws_region" {',
    '  description = "AWS region to deploy resources"',
    '  type        = string',
    '  default     = "' + DEFAULT_AWS_REGION + '"',
    '}',
    '',
    'variable "project_name" {',
    '  description = "Project name used for resource tagging"',
    '  type        = string',
    '  default     = "my-project"',
    '}',
    '',
    'variable "environment" {',
    '  description = "Deployment environment (dev, staging, prod)"',
    '  type        = string',
    '  default     = "dev"',
    '',
    '  validation {',
    '    condition     = contains(["dev", "staging", "prod"], var.environment)',
    '    error_message = "environment must be dev, staging, or prod."',
    '  }',
    '}',
    '',
  ].join('\n'),

  'outputs.tf': [
    '# outputs.tf — Output value declarations',
    '',
    'output "region" {',
    '  description = "AWS region where resources are deployed"',
    '  value       = var.aws_region',
    '}',
    '',
    'output "project" {',
    '  description = "Project name"',
    '  value       = var.project_name',
    '}',
    '',
  ].join('\n'),
};

// ── Inline snippet library (ghost-text completions) ─────────────────────────
const TERRAFORM_INLINE_SNIPPETS = [
  {
    pattern: /^\s*terraform\s*\{\s*$/m,
    label: 'terraform {}',
    insertText: [
      '  required_version = ">= 1.5.0"',
      '',
      '  required_providers {',
      '    aws = {',
      '      source  = "hashicorp/aws"',
      '      version = "~> 5.0"',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*provider\s+"aws"\s*\{\s*$/m,
    label: 'provider "aws" {}',
    insertText: [
      '  region = var.aws_region',
      '',
      '  default_tags {',
      '    tags = {',
      '      Project     = var.project_name',
      '      Environment = var.environment',
      '      ManagedBy   = "terraform"',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*variable\s+"[\w-]+"\s*\{\s*$/m,
    label: 'variable {} block',
    insertText: [
      '  description = ""',
      '  type        = string',
      '  default     = ""',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*output\s+"[\w-]+"\s*\{\s*$/m,
    label: 'output {} block',
    insertText: [
      '  description = ""',
      '  value       = ""',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*locals\s*\{\s*$/m,
    label: 'locals {}',
    insertText: [
      '  common_tags = {',
      '    Project     = var.project_name',
      '    Environment = var.environment',
      '    ManagedBy   = "terraform"',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*module\s+"[\w-]+"\s*\{\s*$/m,
    label: 'module {} block',
    insertText: [
      '  source  = "./"',
      '  version = "~> 1.0"',
      '',
      '  # Pass required variables',
      '  # name = var.name',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*resource\s+"aws_vpc"\s+"[\w-]+"\s*\{\s*$/m,
    label: 'aws_vpc',
    insertText: [
      '  cidr_block           = "10.0.0.0/16"',
      '  enable_dns_hostnames = true',
      '  enable_dns_support   = true',
      '',
      '  tags = merge(local.common_tags, {',
      // eslint-disable-next-line no-template-curly-in-string
      '    Name = "${var.project_name}-vpc"',
      '  })',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*resource\s+"aws_subnet"\s+"[\w-]+"\s*\{\s*$/m,
    label: 'aws_subnet',
    insertText: [
      '  vpc_id                  = aws_vpc.main.id',
      '  cidr_block              = "10.0.1.0/24"',
      '  availability_zone       = data.aws_availability_zones.available.names[0]',
      '  map_public_ip_on_launch = true',
      '',
      '  tags = merge(local.common_tags, {',
      // eslint-disable-next-line no-template-curly-in-string
      '    Name = "${var.project_name}-subnet"',
      '  })',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*resource\s+"aws_security_group"\s+"[\w-]+"\s*\{\s*$/m,
    label: 'aws_security_group',
    insertText: [
      // eslint-disable-next-line no-template-curly-in-string
      '  name        = "${var.project_name}-sg"',
      // Keep Terraform interpolation `${...}` in a JS string
      '  description = "Security group for ${var.project_name}"',

      '  vpc_id      = aws_vpc.main.id',
      '',
      '  ingress {',
      '    from_port   = 443',
      '    to_port     = 443',
      '    protocol    = "tcp"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '',
      '  egress {',
      '    from_port   = 0',
      '    to_port     = 0',
      '    protocol    = "-1"',
      '    cidr_blocks = ["0.0.0.0/0"]',
      '  }',
      '',
      '  tags = local.common_tags',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*resource\s+"aws_instance"\s+"[\w-]+"\s*\{\s*$/m,
    label: 'aws_instance (EC2)',
    insertText: [
      '  ami                    = data.aws_ami.amazon_linux.id',
      '  instance_type          = "t3.micro"',
      '  subnet_id              = aws_subnet.public[0].id',
      '  vpc_security_group_ids = [aws_security_group.main.id]',
      '',
      '  root_block_device {',
      '    volume_size           = 20',
      '    volume_type           = "gp3"',
      '    encrypted             = true',
      '    delete_on_termination = true',
      '  }',
      '',
      // eslint-disable-next-line no-template-curly-in-string
      '  tags = merge(local.common_tags, {',
      '    Name = "${var.project_name}-instance"',
      '  })',
      '}',
    ].join('\n'),
  },
  {
    pattern: /^\s*resource\s+"aws_s3_bucket"\s+"[\w-]+"\s*\{\s*$/m,
    label: 'aws_s3_bucket',
    insertText: [
      // eslint-disable-next-line no-template-curly-in-string
      '  bucket = "${var.project_name}-${var.environment}-${data.aws_caller_identity.current.account_id}"',
      '',
      '  tags = local.common_tags',
      '}',
      '',
      'resource "aws_s3_bucket_versioning" "this" {',
      '  bucket = aws_s3_bucket.this.id',
      '  versioning_configuration {',
      '    status = "Enabled"',
      '  }',
      '}',
      '',
      'resource "aws_s3_bucket_server_side_encryption_configuration" "this" {',
      '  bucket = aws_s3_bucket.this.id',
      '  rule {',
      '    apply_server_side_encryption_by_default {',
      '      sse_algorithm = "aws:kms"',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  },
];

function findInlineSnippet(text) {
  for (const s of TERRAFORM_INLINE_SNIPPETS) {
    if (s.pattern.test(text)) return s;
  }
  return null;
}

// ── LSP completion kind mapping ─────────────────────────────────────────────
function lspCompletionKind(monaco, kind) {
  const m = monaco.languages.CompletionItemKind;
  const map = {
    1: m.Text, 2: m.Method, 3: m.Function, 4: m.Constructor,
    5: m.Field, 6: m.Variable, 7: m.Class, 8: m.Struct, 9: m.Interface,
    10: m.Module, 11: m.Property, 12: m.Event, 13: m.Operator, 14: m.Unit,
    15: m.Value, 16: m.Constant, 17: m.Enum, 18: m.Keyword,
    19: m.Snippet, 20: m.Color, 21: m.File, 22: m.Reference,
    23: m.Folder, 24: m.EnumMember, 25: m.Constant, 26: m.Struct,
    27: m.Event, 28: m.Operator, 29: m.TypeParameter,
  };
  return map[kind] || m.Text;
}

function formatHoverContents(contents) {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents))
    return contents.map(i => (typeof i === 'string' ? i : i.value || '')).join('\n\n');
  return contents.value || '';
}

// ── Parse modules & providers from HCL ─────────────────────────────────────
function parseModulesFromHcl(hcl) {
  const modules = [];
  const providers = [];
  const resources = [];
  const variables = [];
  const outputs = [];

  const modRe = /module\s+"([\w-]+)"\s*\{[^}]*source\s*=\s*"([^"]+)"/gs;
  let m;
  while ((m = modRe.exec(hcl)) !== null)
    modules.push({ name: m[1], source: m[2] });

  const provRe = /provider\s+"([\w-]+)"\s*\{/g;
  while ((m = provRe.exec(hcl)) !== null)
    providers.push({ name: m[1] });

  const resRe = /resource\s+"([\w-]+)"\s+"([\w-]+)"/g;
  while ((m = resRe.exec(hcl)) !== null)
    resources.push({ type: m[1], name: m[2] });

  const varRe = /variable\s+"([\w-]+)"/g;
  while ((m = varRe.exec(hcl)) !== null)
    variables.push({ name: m[1] });

  const outRe = /output\s+"([\w-]+)"/g;
  while ((m = outRe.exec(hcl)) !== null)
    outputs.push({ name: m[1] });

  return { modules, providers, resources, variables, outputs };
}

// ── Symbol kind label & icon ────────────────────────────────────────────────
const SYM_ICON = {
  1: { icon: '⬡', label: 'file' },
  2: { icon: '⊞', label: 'module' },
  5: { icon: '⊟', label: 'field' },
  6: { icon: '≋', label: 'variable' },
  12: { icon: '◈', label: 'event' },
  13: { icon: '⨝', label: 'operator' },
  14: { icon: '⊕', label: 'block' },
  22: { icon: '⊙', label: 'object' },
};
function symIcon(kind) {
  return SYM_ICON[kind] || { icon: '▸', label: 'symbol' };
}

// ════════════════════════════════════════════════════════════════════════════
// Studio component
// ════════════════════════════════════════════════════════════════════════════
export default function Studio() {
  const nav = useNavigate();

  // ── File state ─────────────────────────────────────────────────────────
  const [files, setFiles] = useState(DEFAULT_FILES);
  const filesRef = useRef(DEFAULT_FILES); // always-current mirror used inside async callbacks
  const [activeFile, setActiveFile] = useState('main.tf');

  // ── Editor refs ────────────────────────────────────────────────────────
  const editorRef   = useRef(null);
  const monacoRef   = useRef(null);
  const modelsRef   = useRef({}); // { filename: ITextModel }

  // ── LSP state ─────────────────────────────────────────────────────────
  const lspRef = useRef({
    ws: null,
    open: false,
    requestId: 1,
    pending: new Map(),
    version: {},       // { filename: number }
    openedDocs: new Set(), // URIs sent via textDocument/didOpen (prevents double-open)
    retryCount: 0,
    retryDelay: 2000,
    retryTimer: null,
  });
  const connectLspRef = useRef(null);
  const [lspStatus, setLspStatus] = useState('pending');
  const [runnerMode, setRunnerMode] = useState('auto'); // 'local' | 'docker' | 'auto'

  // ── UI panels ──────────────────────────────────────────────────────────
  const [sidebarPanel, setSidebarPanel] = useState('explorer'); // 'explorer' | 'outline' | 'modules' | 'ai' | null
  const [bottomPanel, setBottomPanel]   = useState('problems');  // 'problems' | 'terminal' | 'output' | null
  const sidebarWidth = sidebarPanel === 'ai' ? 340 : 220; // AI panel needs room for the instruction box + code preview
  const bottomHeight = 180;

  // ── AI code assistant (Studio) ─────────────────────────────────────────
  // Lets the user describe a change in plain English and get back a
  // reviewable replacement for the active file — see routes/hcl-assist.js.
  // Deliberately a *preview* flow (Apply / Discard), never an auto-overwrite,
  // so an AI mistake can't silently clobber code the user hasn't saved yet.
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiLoading, setAiLoading]         = useState(false);
  const [aiError, setAiError]             = useState('');
  const [aiResult, setAiResult]           = useState(null); // { updated_code, summary, forFile }


  // ── Command palette ────────────────────────────────────────────────────
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  // ── Diagnostics / problems ─────────────────────────────────────────────
  const [problems, setProblems] = useState({}); // { filename: [{severity, message, line, col}] }

  // ── Outline (document symbols) ─────────────────────────────────────────
  const [symbols, setSymbols] = useState([]);

  // ── Terminal / output ──────────────────────────────────────────────────
  const [termLines, setTermLines] = useState(['$ Terraform Studio ready. Run a command from the terminal toolbar.']);
  const [lspLogs,   setLspLogs]   = useState([]);
  const termRef = useRef(null);

  // ── Status ─────────────────────────────────────────────────────────────
  const [busy, setBusy]     = useState({ validate: false, fmt: false, cmd: false });
  const [status, setStatus] = useState({ type: 'ready', message: 'Ready' });
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  // Keep filesRef in sync so LSP callbacks always see the latest files
  useEffect(() => { filesRef.current = files; }, [files]);

  // ── Active file content ────────────────────────────────────────────────
  const activeContent = files[activeFile] || '';

  // ── Parsed modules for current active file ─────────────────────────────
  const parsed = useMemo(() => parseModulesFromHcl(activeContent), [activeContent]);

  // ── URI helpers ───────────────────────────────────────────────────────
  const fileUri = useCallback((filename) => `file:///terraform/${filename}`, []);
  const activeUri = useMemo(() => fileUri(activeFile), [fileUri, activeFile]);

  // ── Terminal helpers ───────────────────────────────────────────────────
  const addTermLine = useCallback((line) => {
    setTermLines(prev => [...prev, line]);
    setTimeout(() => {
      if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
    }, 50);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // LSP helpers
  // ════════════════════════════════════════════════════════════════════════
  const sendLspNotification = useCallback((method, params) => {
    const ws = lspRef.current.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })); } catch (_) {}
  }, []);

  const sendLspRequest = useCallback((method, params) => {
    return new Promise((resolve, reject) => {
      const ws = lspRef.current.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('LSP not connected'));
      }
      const id = lspRef.current.requestId++;
      // 15 s — terraform-ls indexes the workspace after `initialized` which can
      // take 10-30 s; 8 s was too short and silently dropped first completions.
      const timer = setTimeout(() => {
        lspRef.current.pending.delete(id);
        reject(new Error('LSP request timed out'));
      }, 15000);
      lspRef.current.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        lspRef.current.pending.delete(id);
        reject(e);
      }
    });
  }, []);

  // updateLspDocument must be declared BEFORE openLspDocument to avoid the
  // temporal dead zone (TDZ) ReferenceError that occurs when a const useCallback
  // references another const that hasn't been initialised yet.
  const updateLspDocument = useCallback((filename, content) => {
    if (!lspRef.current.open) return;
    const uri = fileUri(filename);
    lspRef.current.version[filename] = (lspRef.current.version[filename] || 0) + 1;
    sendLspNotification('textDocument/didChange', {
      textDocument: { uri, version: lspRef.current.version[filename] },
      contentChanges: [{ text: content }],
    });
  }, [fileUri, sendLspNotification]);

  const openLspDocument = useCallback((filename, content) => {
    if (!lspRef.current.open) return;
    const uri = fileUri(filename);
    if (lspRef.current.openedDocs.has(uri)) {
      // Document already open in this LSP session — sending didOpen again is a
      // protocol violation (terraform-ls returns an error).  Use didChange instead.
      updateLspDocument(filename, content);
      return;
    }
    lspRef.current.openedDocs.add(uri);
    const version = (lspRef.current.version[filename] || 0) + 1;
    lspRef.current.version[filename] = version;
    sendLspNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'terraform', version, text: content },
    });
  }, [fileUri, sendLspNotification, updateLspDocument]);

  // ════════════════════════════════════════════════════════════════════════
  // LSP connection
  // ════════════════════════════════════════════════════════════════════════
  const connectLsp = useCallback(() => {
    // BUG-4 fix: check readyState, not just presence of ws.
    // If ws exists but is CLOSING(2) or CLOSED(3), we should NOT skip reconnect.
    // Previously `if (lspRef.current.ws) return` blocked reconnect on stale CLOSED sockets.
    const existingWs = lspRef.current.ws;
    if (existingWs && existingWs.readyState <= 1 /* CONNECTING=0, OPEN=1 */) return;
    // If there's a stale non-open socket, clean it up first
    if (existingWs) {
      try { existingWs.close(); } catch (_) {}
      lspRef.current.ws = null;
    }
    const ws = terraformLspAPI.connect();
    lspRef.current.ws = ws;

    ws.onopen = async () => {
      // NOTE: lspRef.current.open is intentionally NOT set here.
      // We must complete initialize → initialized before allowing any document
      // notifications; setting open=true early lets keystrokes send didChange
      // before the handshake finishes, which violates LSP and corrupts the session.
      lspRef.current.retryCount = 0;
      lspRef.current.retryDelay = 2000;
      setLspStatus('initialising…');
      try {
        await sendLspRequest('initialize', {
          processId: null,
          clientInfo: { name: 'TFGen Studio', version: '1.0.0' },
          capabilities: {
            textDocument: {
              synchronization: {
                dynamicRegistration: false,
                willSave: false,
                willSaveWaitUntil: false,
                didSave: false,
              },
              completion: {
                dynamicRegistration: false,
                completionItem: {
                  snippetSupport: true,
                  commitCharactersSupport: true,
                  documentationFormat: ['markdown', 'plaintext'],
                  deprecatedSupport: true,
                  preselectSupport: true,
                  resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
                },
                contextSupport: true,
              },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              definition: { linkSupport: false },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              rename: { prepareSupport: false },
              signatureHelp: {
                signatureInformation: { documentationFormat: ['markdown', 'plaintext'] },
              },
              codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } },
              formatting: {},
            },
            workspace: {
              workspaceFolders: true,
            },
          },
        });
        sendLspNotification('initialized', {});
        // Only mark open AFTER the full handshake — prevents premature didChange
        lspRef.current.open = true;
        lspRef.current.openedDocs = new Set(); // fresh tracker for this session
        setLspStatus('ready');

        // Open all files on connect — use ref so we always see the latest file
        // content even if connectLsp was memoised before the last edit.
        for (const [fn, content] of Object.entries(filesRef.current)) {
          openLspDocument(fn, content);
        }
      } catch (err) {
        lspRef.current.open = false;
        setLspStatus('offline (init failed)');
      }
    };

    ws.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);

        // Resolve pending requests
        if (payload.id != null && lspRef.current.pending.has(payload.id)) {
          const p = lspRef.current.pending.get(payload.id);
          lspRef.current.pending.delete(payload.id);
          if (payload.error) p.reject(new Error(payload.error.message || 'LSP error'));
          else p.resolve(payload.result);
          return;
        }

        // Diagnostics notification
        if (payload.method === 'textDocument/publishDiagnostics') {
          const { uri, diagnostics } = payload.params || {};
          // Extract filename from URI
          const filename = uri?.replace('file:///terraform/', '') || 'main.tf';
          const monaco = monacoRef.current;
          const model  = modelsRef.current[filename];

          if (monaco && model) {
            const markers = (diagnostics || []).map(d => ({
              severity: d.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              message:  d.message,
              startLineNumber: (d.range?.start?.line ?? 0) + 1,
              startColumn:     (d.range?.start?.character ?? 0) + 1,
              endLineNumber:   (d.range?.end?.line ?? 0) + 1,
              endColumn:       (d.range?.end?.character ?? 0) + 1,
            }));
            monaco.editor.setModelMarkers(model, 'terraform-lsp', markers);
          }

          const probs = (diagnostics || []).map(d => ({
            severity: d.severity === 1 ? 'error' : 'warning',
            message:  d.message,
            line:     (d.range?.start?.line ?? 0) + 1,
            col:      (d.range?.start?.character ?? 0) + 1,
          }));
          setProblems(prev => ({ ...prev, [filename]: probs }));
          return;
        }

        // Log messages
        if (payload.method === 'window/logMessage') {
          setLspLogs(prev => [...prev.slice(-200), `[${payload.params?.type}] ${payload.params?.message}`]);
          return;
        }
        if (payload.method === 'window/showMessage') {
          const msg = payload.params?.message || '';
          if (msg) addTermLine(`[LSP] ${msg}`);
          return;
        }
      } catch (_) {}
    };

    ws.onclose = (ev) => {
      lspRef.current.open = false;
      lspRef.current.ws   = null;
      // BUG FIX: code 4001 means the backend confirmed terraform-ls isn't
      // installed / TF_LSP_PATH is wrong (see terraformLsp.js's
      // _handleSpawnError/_onProcessError) — every retry would fail with
      // the exact same ENOENT, so retrying is pure wasted time. Previously
      // this went through the same 5x exponential-backoff loop as any other
      // disconnect (~60s of "offline (retry N/5...)" before finally landing
      // on the real message), which could easily look like the status was
      // stuck/not updating if you weren't watching it the whole time.
      if (ev.code === 4001) {
        lspRef.current.retryCount = 0;
        if (lspRef.current.retryTimer) clearTimeout(lspRef.current.retryTimer);
        setLspStatus('offline — terraform-ls not installed (see Output panel for install steps)');
        return;
      }
      if (lspRef.current.retryCount < 5) {
        const delay = lspRef.current.retryDelay;
        lspRef.current.retryDelay   = Math.min(delay * 2, 30000);
        lspRef.current.retryCount  += 1;
        setLspStatus(`offline (retry ${lspRef.current.retryCount}/5 in ${(delay / 1000).toFixed(0)}s…)`);
        lspRef.current.retryTimer = setTimeout(() => {
          connectLspRef.current?.();
        }, delay);
      } else {
        setLspStatus('offline — install terraform-ls and set TF_LSP_PATH');
      }
    };

    ws.onerror = (event) => {
      // Handle WebSocket errors gracefully
      if (lspRef.current.open) {
        lspRef.current.open = false;
        setLspStatus('offline (connection error)');
      }
    };
  }, [sendLspRequest, sendLspNotification, openLspDocument, addTermLine]);

  // ════════════════════════════════════════════════════════════════════════
  // Monaco: language & providers setup
  // ════════════════════════════════════════════════════════════════════════
  const beforeMonacoMount = useCallback((monaco) => {
    const LANG = 'terraform';
    if (monaco.languages.getLanguages().some(l => l.id === LANG)) return;

    monaco.languages.register({ id: LANG });
    monaco.languages.register({ id: 'hcl' });

    const langConfig = {
      comments: { lineComment: '#', blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' },
        { open: '(', close: ')' }, { open: '"', close: '"' },
      ],
      surroundingPairs: [
        { open: '{', close: '}' }, { open: '[', close: ']' },
        { open: '(', close: ')' }, { open: '"', close: '"' },
      ],
      indentationRules: {
        increaseIndentPattern: /^.*\{[^}"']*$/,
        decreaseIndentPattern: /^\s*\}/,
      },
    };
    monaco.languages.setLanguageConfiguration(LANG, langConfig);
    monaco.languages.setLanguageConfiguration('hcl', langConfig);

    const tokenizer = {
      tokenizer: {
        root: [
          [/(^\s*#.*$)/, 'comment'],
          [/\/\*.*?\*\//, 'comment'],
          [/\/\/.*$/, 'comment'],
          [/\b(terraform|provider|resource|variable|output|module|data|locals|dynamic|for_each|count|lifecycle|depends_on|moved|import|check)\b/, 'keyword'],
          [/\b(contains|length|keys|values|merge|format|formatdate|substr|replace|regexall|upper|lower|trim|tostring|tolist|tomap|toset|tonumber|tobool|cidrsubnet|cidrhost|jsonencode|jsondecode|templatefile|file|lookup|element|concat|flatten|distinct|compact|range|zipmap|try|can)\b/, 'type.identifier'],
          [/\b(true|false|null)\b/, 'constant.language'],
          [/[0-9]+(\.[0-9]+)?/, 'number'],
          [/"([^\\"]|\\.)*"/, 'string'],
          [/\${/, { token: 'delimiter.bracket', next: '@expr' }],
          [/\b(\w+)(\s*)(=)(?!=)/, ['variable.other', '', 'delimiter']],
          [/[{}[\]()]/, '@brackets'],
          [/[;,.]/, 'delimiter'],
        ],
        expr: [
          [/}/, { token: 'delimiter.bracket', next: '@pop' }],
          [/[^}]+/, 'variable'],
        ],
      },
    };
    monaco.languages.setMonarchTokensProvider(LANG, tokenizer);
    monaco.languages.setMonarchTokensProvider('hcl', tokenizer);

    // VS Dark theme tweaks for Terraform
    monaco.editor.defineTheme('terraform-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword',            foreground: '569cd6', fontStyle: 'bold' },
        { token: 'type.identifier',    foreground: '4ec9b0' },
        { token: 'constant.language',  foreground: '569cd6' },
        { token: 'string',             foreground: 'ce9178' },
        { token: 'comment',            foreground: '6a9955', fontStyle: 'italic' },
        { token: 'number',             foreground: 'b5cea8' },
        { token: 'variable.other',     foreground: '9cdcfe' },
        { token: 'delimiter.bracket',  foreground: 'ffd700' },
      ],
      colors: {
        'editor.background':            '#1e1e1e',
        'editor.lineHighlightBackground': '#2a2a2a',
        'editorLineNumber.foreground':  '#858585',
        'editorGutter.background':      '#1e1e1e',
      },
    });
  }, []);

  const onEditorMount = useCallback((editor, monaco) => {
    editorRef.current   = editor;
    monacoRef.current   = monaco;

    // Create models for all files
    for (const [fn, content] of Object.entries(files)) {
      const uri = monaco.Uri.parse(fileUri(fn));
      let model = monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(content, 'terraform', uri);
      } else if (model.getLanguageId() !== 'terraform') {
        // Stale model from a previous render cycle with the wrong language —
        // the 'terraform' completion provider won't fire for it without this fix.
        monaco.editor.setModelLanguage(model, 'terraform');
      }
      modelsRef.current[fn] = model;
    }
    // Set active model
    editor.setModel(modelsRef.current[activeFile]);

    // Track cursor position for status bar
    editor.onDidChangeCursorPosition(e => {
      setCursorPos({ line: e.position.lineNumber, col: e.position.column });
    });

    // Track content changes → sync to React state + LSP
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (!model) return;
      const uri  = model.uri.toString();
      const fn   = uri.replace('file:///terraform/', '');
      const val  = model.getValue();
      setFiles(prev => ({ ...prev, [fn]: val }));
      if (lspRef.current.open) updateLspDocument(fn, val);
    });

    // ── Register all language providers ──────────────────────────────────
    const LANG = 'terraform';

    // 1. Completion
    monaco.languages.registerCompletionItemProvider(LANG, {
      // Include letters/digits so the provider fires while typing a word,
      // not just after a punctuation trigger character.
      triggerCharacters: ['.', '"', '_', '{', ' ', '=', ':', '\n', 'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z'],
      provideCompletionItems: async (model, position) => {
        if (lspRef.current.open) {
          // LSP connected — always return its answer, even if empty.
          // Never fall through to the keyword fallback when LSP is live;
          // mixing both lists produces confusing duplicate / irrelevant items.
          try {
            // model.uri.toString() is already "file:///terraform/<filename>"
            // — use it directly; do NOT pass through fileUri() which would
            // double-wrap it into "file:///terraform/file:///terraform/main.tf"
            const docUri = model.uri.toString();
            const raw = await sendLspRequest('textDocument/completion', {
              textDocument: { uri: docUri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            const items = Array.isArray(raw) ? raw : (raw?.items || []);
            return {
              suggestions: items.slice(0, 50).map(item => {
                  const ins = item.textEdit ? item.textEdit.newText : (item.insertText || item.label || '');
                  const rng = item.textEdit
                    ? new monaco.Range(
                        item.textEdit.range.start.line + 1,
                        item.textEdit.range.start.character + 1,
                        item.textEdit.range.end.line + 1,
                        item.textEdit.range.end.character + 1,
                      )
                    : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
                  return {
                    label:     item.label || '',
                    kind:      lspCompletionKind(monaco, item.kind),
                    insertText: ins,
                    insertTextRules: item.insertTextFormat === 2
                      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                      : undefined,
                    documentation: item.documentation?.value || item.documentation,
                    detail: item.detail,
                    range: rng,
                    sortText: String(item.sortText || item.label || ''),
                  };
                }),
            };
          } catch (err) {
            // Log to the LSP output panel so the user can see what failed,
            // then return empty so Monaco doesn't crash.
            console.warn('[LSP completion error]', err?.message || err);
            return { suggestions: [] };
          }
        }
        // ── Offline fallback ─────────────────────────────────────────────
        // Only reached when terraform-ls is NOT connected.
        const word = model.getWordUntilPosition(position);
        const fallbackRange = new monaco.Range(
          position.lineNumber, word.startColumn,
          position.lineNumber, word.endColumn,
        );
        return {
          suggestions: [
            { label: 'resource',  detail: 'resource block',  kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'resource "${1:type}" "${2:name}" {\n  $0\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'variable',  detail: 'variable block',  kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'variable "${1:name}" {\n  description = "${2}"\n  type        = ${3:string}\n  default     = ${4:null}\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'output',    detail: 'output block',    kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'output "${1:name}" {\n  description = "${2}"\n  value       = ${3}\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'module',    detail: 'module block',    kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'module "${1:name}" {\n  source = "${2}"\n  $0\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'locals',    detail: 'locals block',    kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'locals {\n  $0\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'provider',  detail: 'provider block',  kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'provider "${1:name}" {\n  $0\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'data',      detail: 'data source',     kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'data "${1:type}" "${2:name}" {\n  $0\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            { label: 'terraform', detail: 'terraform block', kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'terraform {\n  required_version = ">= ${1:1.5.0}"\n\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> ${2:5.0}"\n    }\n  }\n}',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range: fallbackRange },
            ...['for_each', 'count', 'depends_on', 'lifecycle', 'tags', 'dynamic', 'true', 'false', 'null'].map(kw => ({
              label: kw, detail: 'Terraform keyword', kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw, range: fallbackRange,
            })),
          ],
        };
      },
    });

    // 2. Hover
    monaco.languages.registerHoverProvider(LANG, {
      provideHover: async (model, position) => {
        if (!lspRef.current.open) return null;
        try {
          const docUri = model.uri.toString();
          const result = await sendLspRequest('textDocument/hover', {
            textDocument: { uri: docUri },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result?.contents) return null;
          const rng = result.range ? new monaco.Range(
            result.range.start.line + 1, result.range.start.character + 1,
            result.range.end.line + 1,   result.range.end.character + 1,
          ) : undefined;
          return { range: rng, contents: [{ value: formatHoverContents(result.contents) }] };
        } catch { return null; }
      },
    });

    // 3. Inline completions (ghost text) — disabled to prevent suggestions
    //    appearing on every keystroke. Ctrl+I triggers suggestions on demand.

    // 4. Go to Definition (F12)
    monaco.languages.registerDefinitionProvider(LANG, {
      provideDefinition: async (model, position) => {
        if (!lspRef.current.open) return null;
        try {
          const docUri = model.uri.toString();
          const currentFn = docUri.replace('file:///terraform/', '');
          const result = await sendLspRequest('textDocument/definition', {
            textDocument: { uri: docUri },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result) return null;
          const locs = Array.isArray(result) ? result : [result];
          return locs.map(loc => {
            const locFn = loc.uri?.replace('file:///terraform/', '') || currentFn;
            const targetModel = modelsRef.current[locFn] || model;
            return {
              uri: targetModel.uri,
              range: new monaco.Range(
                loc.range.start.line + 1, loc.range.start.character + 1,
                loc.range.end.line + 1,   loc.range.end.character + 1,
              ),
            };
          });
        } catch { return null; }
      },
    });

    // 5. Find References (Shift+F12)
    monaco.languages.registerReferenceProvider(LANG, {
      provideReferences: async (model, position) => {
        if (!lspRef.current.open) return null;
        try {
          const docUri = model.uri.toString();
          const currentFn = docUri.replace('file:///terraform/', '');
          const result = await sendLspRequest('textDocument/references', {
            textDocument: { uri: docUri },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: true },
          });
          if (!Array.isArray(result)) return null;
          return result.map(loc => {
            const locFn = loc.uri?.replace('file:///terraform/', '') || currentFn;
            const m2 = modelsRef.current[locFn] || model;
            return {
              uri: m2.uri,
              range: new monaco.Range(
                loc.range.start.line + 1, loc.range.start.character + 1,
                loc.range.end.line + 1,   loc.range.end.character + 1,
              ),
            };
          });
        } catch { return null; }
      },
    });

    // 6. Document Symbols (Outline — Ctrl+Shift+O)
    monaco.languages.registerDocumentSymbolProvider(LANG, {
      provideDocumentSymbols: async (model) => {
        if (!lspRef.current.open) return null;
        try {
          const docUri = model.uri.toString();
          const result = await sendLspRequest('textDocument/documentSymbol', {
            textDocument: { uri: docUri },
          });
          if (!Array.isArray(result)) return null;
          setSymbols(result);
          function mapSym(sym) {
            return {
              name: sym.name,
              detail: sym.detail || '',
              kind: sym.kind,
              range: new monaco.Range(
                sym.range.start.line + 1, sym.range.start.character + 1,
                sym.range.end.line + 1,   sym.range.end.character + 1,
              ),
              selectionRange: new monaco.Range(
                sym.selectionRange.start.line + 1, sym.selectionRange.start.character + 1,
                sym.selectionRange.end.line + 1,   sym.selectionRange.end.character + 1,
              ),
              children: (sym.children || []).map(mapSym),
            };
          }
          return result.map(mapSym);
        } catch { return null; }
      },
    });

    // 7. Signature Help (Ctrl+Shift+Space)
    monaco.languages.registerSignatureHelpProvider(LANG, {
      signatureHelpTriggerCharacters: ['(', ','],
      provideSignatureHelp: async (model, position) => {
        if (!lspRef.current.open) return null;
        try {
          const fn = model.uri.toString().replace('file:///terraform/', '');
          const result = await sendLspRequest('textDocument/signatureHelp', {
            textDocument: { uri: fileUri(fn) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
          if (!result?.signatures?.length) return null;
          return {
            value: {
              signatures: result.signatures.map(sig => ({
                label: sig.label,
                documentation: { value: sig.documentation?.value || sig.documentation || '' },
                parameters: (sig.parameters || []).map(p => ({
                  label: p.label,
                  documentation: { value: p.documentation?.value || p.documentation || '' },
                })),
              })),
              activeSignature: result.activeSignature || 0,
              activeParameter: result.activeParameter || 0,
            },
            dispose: () => {},
          };
        } catch { return null; }
      },
    });

    // 8. Code Actions (Ctrl+. / light-bulb)
    monaco.languages.registerCodeActionProvider(LANG, {
      provideCodeActions: async (model, range, context) => {
        if (!lspRef.current.open) return { actions: [], dispose: () => {} };
        try {
          const fn = model.uri.toString().replace('file:///terraform/', '');
          const result = await sendLspRequest('textDocument/codeAction', {
            textDocument: { uri: fileUri(fn) },
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end:   { line: range.endLineNumber - 1,   character: range.endColumn - 1 },
            },
            context: {
              diagnostics: (context.markers || []).map(mk => ({
                range: {
                  start: { line: mk.startLineNumber - 1, character: mk.startColumn - 1 },
                  end:   { line: mk.endLineNumber - 1,   character: mk.endColumn - 1 },
                },
                message: mk.message,
                severity: mk.severity === 8 ? 1 : 2,
              })),
            },
          });
          if (!Array.isArray(result)) return { actions: [], dispose: () => {} };
          return {
            actions: result.map(a => ({
              title: a.title,
              kind:  a.kind,
              diagnostics: [],
              edit: a.edit ? {
                edits: (a.edit.documentChanges || []).flatMap(chg =>
                  (chg.edits || []).map(e => ({
                    resource: model.uri,
                    textEdit: {
                      range: new monaco.Range(
                        e.range.start.line + 1, e.range.start.character + 1,
                        e.range.end.line + 1,   e.range.end.character + 1,
                      ),
                      text: e.newText,
                    },
                  }))
                ),
              } : undefined,
            })),
            dispose: () => {},
          };
        } catch { return { actions: [], dispose: () => {} }; }
      },
    });

    // 9. Rename Symbol (F2)
    monaco.languages.registerRenameProvider(LANG, {
      provideRenameEdits: async (model, position, newName) => {
        if (!lspRef.current.open) return null;
        try {
          const fn = model.uri.toString().replace('file:///terraform/', '');
          const result = await sendLspRequest('textDocument/rename', {
            textDocument: { uri: fileUri(fn) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            newName,
          });
          if (!result) return null;
          const edits = [];
          for (const [, changes] of Object.entries(result.changes || {})) {
            for (const chg of changes) {
              edits.push({
                resource: model.uri,
                textEdit: {
                  range: new monaco.Range(
                    chg.range.start.line + 1, chg.range.start.character + 1,
                    chg.range.end.line + 1,   chg.range.end.character + 1,
                  ),
                  text: chg.newText,
                },
              });
            }
          }
          return { edits };
        } catch { return null; }
      },
    });

    // Keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handleFmt());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handleValidate());
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      () => setShowPalette(true),
    );
    // Ctrl+I → trigger IntelliSense suggestion dropdown immediately
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI,
      () => editor.trigger('keyboard', 'editor.action.triggerSuggest', {}),
    );

    // Connect LSP after editor is ready
    connectLspRef.current = connectLsp;
    connectLsp();

    // Cleanup on unmount
    return () => {
      if (lspRef.current.retryTimer) {
        clearTimeout(lspRef.current.retryTimer);
      }
      if (lspRef.current.ws) {
        lspRef.current.ws.close();
        lspRef.current.ws = null;
      }
      lspRef.current.open = false;
      lspRef.current.pending.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  // Keep connectLspRef current
  connectLspRef.current = connectLsp;

  // ════════════════════════════════════════════════════════════════════════
  // File switching
  // ════════════════════════════════════════════════════════════════════════
  const switchFile = useCallback((filename) => {
    if (!editorRef.current || !monacoRef.current) {
      setActiveFile(filename);
      return;
    }
    const monaco = monacoRef.current;
    const editor = editorRef.current;

    // Ensure model exists
    if (!modelsRef.current[filename]) {
      const uri = monaco.Uri.parse(fileUri(filename));
      // getModel first — createModel throws "Another model is already set at that URI"
      // if Monaco has a cached model we don't know about yet.
      const existing = monaco.editor.getModel(uri);
      const model = existing || monaco.editor.createModel(files[filename] || '', 'terraform', uri);
      if (existing && existing.getLanguageId() !== 'terraform') {
        monaco.editor.setModelLanguage(existing, 'terraform');
      }
      modelsRef.current[filename] = model;
    }
    editor.setModel(modelsRef.current[filename]);
    setActiveFile(filename);

    // Notify LSP about the switch
    if (lspRef.current.open) {
      openLspDocument(filename, files[filename] || '');
    }
    setSymbols([]);
  }, [files, fileUri, openLspDocument]);

  // ── New file dialog state (replaces prompt() — BUG-9 fix) ─────────────────
  const [newFileDialog, setNewFileDialog] = useState(false);
  const [newFileName, setNewFileName]     = useState('');
  const newFileInputRef = useRef(null);

  const openNewFileDialog = useCallback(() => {
    setNewFileName('');
    setNewFileDialog(true);
    setTimeout(() => newFileInputRef.current?.focus(), 50);
  }, []);

  const commitNewFile = useCallback(() => {
    const name = newFileName.trim();
    setNewFileDialog(false);
    setNewFileName('');
    if (!name) return;
    const finalName = name.endsWith('.tf') ? name : `${name}.tf`;
    if (files[finalName]) { switchFile(finalName); return; }
    setFiles(prev => ({ ...prev, [finalName]: `# ${finalName}\n` }));
    setTimeout(() => switchFile(finalName), 50);
  }, [newFileName, files, switchFile]);

  // Legacy addNewFile kept for command palette compat — delegates to dialog
  const addNewFile = useCallback(() => openNewFileDialog(), [openNewFileDialog]);

  // ════════════════════════════════════════════════════════════════════════
  // Handlers
  // ════════════════════════════════════════════════════════════════════════
  const handleValidate = useCallback(async () => {
    setBusy(s => ({ ...s, validate: true }));
    setStatus({ type: 'working', message: 'Validating…' });
    addTermLine('$ terraform validate');
    try {
      const clean = sanitizeHcl(activeContent || '');
      const res   = await terraformAPI.validate(clean, runnerMode);
      const data  = res?.data || {};

      // Monaco markers from validate response
      const monaco = monacoRef.current;
      const model  = modelsRef.current[activeFile];
      if (monaco && model) {
        const diags = data.diagnostics || [];
        monaco.editor.setModelMarkers(model, 'terraform', diags.map(d => ({
          severity: (d.severity || '').toLowerCase() === 'error'
            ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: `${(d.severity || '').toUpperCase()}: ${d.summary || d.detail || ''}`,
          // BUG-3 fix: use ?? instead of || so line/column 0 is not treated as falsy.
          // terraform validate uses 1-based lines/cols, Monaco also 1-based — no +1 needed.
          // ?? 1 is the safe "no range" fallback.
          startLineNumber: d.range?.start?.line   ?? 1,
          startColumn:     d.range?.start?.column ?? 1,
          endLineNumber:   d.range?.end?.line     ?? 1,
          endColumn:       d.range?.end?.column   ?? 1,
        })));
      }

      const ok = data?.valid;
      setStatus({ type: ok ? 'ok' : 'err', message: ok ? '✓ Valid' : '✗ Validation failed' });
      addTermLine(ok ? '✓ Configuration is valid' : `✗ ${data.message || 'Validation failed'}`);
      if (data.networkWarnings?.length) {
        data.networkWarnings.forEach(w => addTermLine(`⚠ ${w}`));
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e.message;
      setStatus({ type: 'err', message: `Validate error: ${msg}` });
      addTermLine(`✗ Error: ${msg}`);
    } finally {
      setBusy(s => ({ ...s, validate: false }));
    }
  }, [activeContent, activeFile, addTermLine, runnerMode]);

  const handleFmt = useCallback(async () => {
    setBusy(s => ({ ...s, fmt: true }));
    setStatus({ type: 'working', message: 'Formatting…' });
    addTermLine('$ terraform fmt');
    try {
      const clean = sanitizeHcl(activeContent || '');
      const res   = await terraformAPI.fmt(clean, runnerMode);
      if (res?.data?.success && res?.data?.formatted) {
        const formatted = sanitizeHcl(res.data.formatted);
        setFiles(prev => ({ ...prev, [activeFile]: formatted }));
        // Update Monaco model
        const model = modelsRef.current[activeFile];
        if (model) {
          model.pushEditOperations(
            [], [{ range: model.getFullModelRange(), text: formatted }], () => null,
          );
        }
        setStatus({ type: 'ok', message: '✓ Formatted' });
        addTermLine('✓ Code formatted successfully');
      } else {
        setStatus({ type: 'warn', message: res?.data?.offline ? 'Terraform CLI not available' : 'Format had no changes' });
        addTermLine(res?.data?.message || 'Format: no changes');
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e.message;
      setStatus({ type: 'err', message: `Format error: ${msg}` });
      addTermLine(`✗ Error: ${msg}`);
    } finally {
      setBusy(s => ({ ...s, fmt: false }));
    }
  }, [activeContent, activeFile, addTermLine, runnerMode]);

  // Ask the AI to write/update code for the active file based on a plain-
  // English instruction. Result is held as a preview (aiResult) — nothing
  // touches the editor until the user clicks "Apply".
  const handleAiAssist = useCallback(async () => {
    if (!aiInstruction.trim() || aiLoading) return;
    setAiLoading(true);
    setAiError('');
    setAiResult(null);
    try {
      const res = await hclAssistAPI.assist({
        instruction: aiInstruction.trim(),
        filename: activeFile,
        currentCode: activeContent,
        allFiles: files,
      });
      setAiResult({
        updated_code: res.data.updated_code,
        summary: res.data.summary,
        forFile: activeFile,
      });
      addTermLine(`✨ AI proposed changes to ${activeFile}`);
    } catch (e) {
      setAiError(e.response?.data?.error || e.message || 'AI request failed.');
    } finally {
      setAiLoading(false);
    }
  }, [aiInstruction, aiLoading, activeFile, activeContent, files, addTermLine]);

  // Apply the previewed AI code to the file it was generated for — same
  // dual-update (React state + live Monaco model) as handleFmt above, so
  // undo history and the editor view both stay correct.
  const handleApplyAi = useCallback(() => {
    if (!aiResult) return;
    const { updated_code, forFile } = aiResult;
    setFiles(prev => ({ ...prev, [forFile]: updated_code }));
    const model = modelsRef.current[forFile];
    if (model) {
      model.pushEditOperations(
        [], [{ range: model.getFullModelRange(), text: updated_code }], () => null,
      );
    }
    setStatus({ type: 'ok', message: `✓ Applied AI changes to ${forFile}` });
    addTermLine(`✓ Applied AI changes to ${forFile}`);
    setAiResult(null);
    setAiInstruction('');
  }, [aiResult, addTermLine]);

  const handleDiscardAi = useCallback(() => {
    setAiResult(null);
    setAiError('');
  }, []);

  const handleRunCommand = useCallback(async (cmd) => {
    setBusy(s => ({ ...s, cmd: true }));
    setBottomPanel('terminal');
    addTermLine(`$ terraform ${cmd}`);
    try {
      let res;
      // BUG-6 fix: await the inner handlers fully before clearing busy.cmd.
      // Previously `setBusy(s => ({ ...s, cmd: false })); return` ran synchronously,
      // clearing busy.cmd before handleValidate/handleFmt resolved, briefly re-enabling buttons.
      if (cmd === 'validate') { await handleValidate(); return; }
      if (cmd === 'fmt')      { await handleFmt();      return; }
      // NOTE: early returns above skip the finally block, which is intentional —
      // handleValidate/handleFmt manage busy.validate / busy.fmt independently.
      // busy.cmd is still cleared by finally for plan/init/other commands below.
      if (cmd === 'plan') {
        res = await terraformAPI.plan(sanitizeHcl(activeContent), runnerMode);
        const data = res?.data || {};
        addTermLine(data.message || (data.success ? '✓ Plan complete' : '✗ Plan failed'));
        if (data.resource_changes?.length) {
          const adds = data.resource_changes.filter(r => r.change?.actions?.includes('create')).length;
          const dels = data.resource_changes.filter(r => r.change?.actions?.includes('delete')).length;
          const mods = data.resource_changes.filter(r => r.change?.actions?.includes('update')).length;
          addTermLine(`  Plan: ${adds} to add, ${mods} to change, ${dels} to destroy.`);
        }
      } else if (cmd === 'init') {
        res = await terraformAPI.init(sanitizeHcl(activeContent), runnerMode);
        const data = res?.data || {};
        addTermLine(data.success ? '✓ Terraform initialized' : `✗ ${data.message || 'Init failed'}`);
        if (data.output) data.output.split('\n').slice(0, 20).forEach(l => l && addTermLine(`  ${l}`));
      } else {
        addTermLine(`ℹ Command '${cmd}' not supported in Studio (use CLI for apply/destroy).`);
      }
    } catch (e) {
      const msg = e?.response?.data?.error || e.message;
      addTermLine(`✗ Error: ${msg}`);
    } finally {
      setBusy(s => ({ ...s, cmd: false }));
    }
  }, [activeContent, addTermLine, handleValidate, handleFmt, runnerMode]);

  // ── Fetch symbols for outline panel ──────────────────────────────────
  const fetchSymbols = useCallback(async () => {
    if (!lspRef.current.open) {
      // Fallback: parse locally — positions are unknown, mark as _local so the
      // outline click handler can skip navigation (BUG-7 fix: all _local symbols
      // had range.start.line = 0, causing every click to jump to line 1 regardless
      // of where the resource actually is).
      setSymbols(parsed.resources.map((r) => ({
        name: `${r.type}.${r.name}`, detail: 'resource', kind: 22, _local: true,
        range: { start: { line: null }, end: { line: null } },
      })));
      return;
    }
    try {
      const result = await sendLspRequest('textDocument/documentSymbol', {
        textDocument: { uri: activeUri },
      });
      if (Array.isArray(result)) setSymbols(result);
    } catch (_) {}
  }, [activeUri, parsed.resources, sendLspRequest]);

  useEffect(() => {
    if (sidebarPanel === 'outline') fetchSymbols();
  }, [sidebarPanel, activeFile, fetchSymbols]);

  // ── Command palette commands ───────────────────────────────────────────
  const PALETTE_COMMANDS = useMemo(() => [
    { label: 'Terraform: Validate',           icon: '✓', action: () => handleValidate() },
    { label: 'Terraform: Format Document',    icon: '⌨', action: () => handleFmt() },
    { label: 'Terraform: Init',               icon: '⚙', action: () => handleRunCommand('init') },
    { label: 'Terraform: Plan',               icon: '📋', action: () => handleRunCommand('plan') },
    { label: 'View: Toggle Explorer',         icon: '📁', action: () => setSidebarPanel(p => p === 'explorer' ? null : 'explorer') },
    { label: 'View: Toggle Outline',          icon: '⊞', action: () => setSidebarPanel(p => p === 'outline' ? null : 'outline') },
    { label: 'View: Toggle Module Explorer',  icon: '⧉', action: () => setSidebarPanel(p => p === 'modules' ? null : 'modules') },
    { label: '✨ AI: Write / Update Code',     icon: '✨', action: () => setSidebarPanel(p => p === 'ai' ? null : 'ai') },
    { label: 'View: Toggle Problems Panel',   icon: '⚠', action: () => setBottomPanel(p => p === 'problems' ? null : 'problems') },
    { label: 'View: Toggle Terminal',         icon: '⬛', action: () => setBottomPanel(p => p === 'terminal' ? null : 'terminal') },
    { label: 'View: Toggle Output',           icon: '📜', action: () => setBottomPanel(p => p === 'output' ? null : 'output') },
    { label: 'File: New .tf File',            icon: '＋', action: () => addNewFile() },
    { label: 'Go to Dashboard',              icon: '←',  action: () => nav('/dashboard') },
    { label: 'LSP: Reconnect',               icon: '↺',  action: () => {
      if (lspRef.current.retryTimer) clearTimeout(lspRef.current.retryTimer);
      lspRef.current.retryCount = 0; lspRef.current.retryDelay = 2000;
      setLspStatus('pending'); connectLsp();
    }},
  ], [handleValidate, handleFmt, handleRunCommand, addNewFile, nav, connectLsp]);

  const filteredCommands = useMemo(() =>
    PALETTE_COMMANDS.filter(c =>
      !paletteQuery || c.label.toLowerCase().includes(paletteQuery.toLowerCase())
    ),
  [PALETTE_COMMANDS, paletteQuery]);

  // ── Global keyboard shortcuts ─────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { setShowPalette(false); return; }
      if (meta && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault(); setShowPalette(true); setPaletteQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Problem counts ────────────────────────────────────────────────────
  const totalErrors   = Object.values(problems).flat().filter(p => p.severity === 'error').length;
  const totalWarnings = Object.values(problems).flat().filter(p => p.severity === 'warning').length;

  // ── Colors ────────────────────────────────────────────────────────────
  const C = {
    bg:      '#1e1e1e',
    sidebar: '#252526',
    tab:     '#2d2d2d',
    tabAct:  '#1e1e1e',
    bar:     '#333333',
    actBar:  '#333333',
    border:  '#3c3c3c',
    text:    '#cccccc',
    textDim: '#858585',
    accent:  '#0098ff',
    accentG: '#4ec9b0',
    green:   '#4ade80',
    red:     '#f87171',
    yellow:  '#facc15',
    orange:  '#fb923c',
    statusBg:'#007acc',
  };

  // ── Shared icon-button style ──────────────────────────────────────────
  const iconBtn = (active) => ({
    width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', color: active ? '#ffffff' : '#858585', fontSize: 20,
    background: 'transparent', border: 'none',
    borderLeft: active ? `2px solid ${C.accent}` : '2px solid transparent',
    transition: 'all 0.15s',
  });

  // ════════════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ height: 'calc(100vh - 52px)', display: 'flex', flexDirection: 'column', background: C.bg, color: C.text, fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── Command Palette ── */}
      {showPalette && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80 }}
          onMouseDown={() => setShowPalette(false)}
        >
          <div
            style={{ width: 620, maxHeight: 420, background: '#252526', border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 24px 64px rgba(0,0,0,0.6)', overflow: 'hidden' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.textDim, marginRight: 8, fontSize: 14 }}>⌘</span>
              <input
                autoFocus
                value={paletteQuery}
                onChange={e => setPaletteQuery(e.target.value)}
                placeholder="Type a command…"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.text, fontSize: 14 }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && filteredCommands.length) {
                    filteredCommands[0].action();
                    setShowPalette(false);
                  }
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', maxHeight: 360 }}>
              {filteredCommands.map((cmd, i) => (
                <div
                  key={i}
                  style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', color: C.text, fontSize: 13 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#2a2d2e'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => { cmd.action(); setShowPalette(false); setPaletteQuery(''); }}
                >
                  <span style={{ width: 20, textAlign: 'center', color: C.textDim }}>{cmd.icon}</span>
                  {cmd.label}
                </div>
              ))}
              {!filteredCommands.length && (
                <div style={{ padding: '20px 16px', color: C.textDim, fontSize: 13 }}>No commands match "{paletteQuery}"</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── New File Dialog (BUG-9 fix: replaces prompt()) ── */}
      {newFileDialog && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 140 }}
          onMouseDown={() => { setNewFileDialog(false); setNewFileName(''); }}
        >
          <div
            style={{ background: '#252526', border: `1px solid ${C.border}`, borderRadius: 6, padding: '16px 20px', width: 380, boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div style={{ fontSize: 13, color: C.textDim, marginBottom: 10 }}>New Terraform File</div>
            <input
              ref={newFileInputRef}
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter')  commitNewFile();
                if (e.key === 'Escape') { setNewFileDialog(false); setNewFileName(''); }
              }}
              placeholder="e.g. networking.tf"
              style={{ width: '100%', boxSizing: 'border-box', background: '#1e1e1e', border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, padding: '7px 10px', fontSize: 13, outline: 'none' }}
            />
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>Extension .tf will be added automatically.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={() => { setNewFileDialog(false); setNewFileName(''); }} style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.textDim, cursor: 'pointer', padding: '5px 14px', borderRadius: 4, fontSize: 12 }}>Cancel</button>
              <button onClick={commitNewFile} style={{ background: C.accent, border: 'none', color: '#fff', cursor: 'pointer', padding: '5px 14px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top Bar ── */}
      <div style={{ height: 35, background: C.statusBg, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 10, flexShrink: 0, zIndex: 10 }}>
        <button onClick={() => nav('/dashboard')} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', cursor: 'pointer', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>← Dashboard</button>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.3)' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', opacity: 0.9 }}>Terraform Studio</span>
        <div style={{ flex: 1 }} />
        {/* Toolbar actions */}
        {[
          { label: 'Init',      icon: '⚙', cmd: 'init',     title: 'terraform init' },
          { label: 'Validate',  icon: '✓', cmd: 'validate', title: 'terraform validate (Ctrl+Enter)' },
          { label: 'Plan',      icon: '📋', cmd: 'plan',    title: 'terraform plan' },
          { label: 'Format',    icon: '⌨', cmd: 'fmt',      title: 'Format code (Ctrl+S)' },
        ].map(({ label, icon, cmd, title }) => (
          <button
            key={cmd}
            onClick={() => handleRunCommand(cmd)}
            disabled={busy.cmd || busy.validate || busy.fmt}
            title={title}
            style={{
              background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff', cursor: 'pointer', padding: '3px 10px', borderRadius: 4,
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 4,
              opacity: (busy.cmd || busy.validate || busy.fmt) ? 0.5 : 1,
            }}
          >
            <span>{icon}</span> {label}
          </button>
        ))}
        <button
          onClick={() => { setShowPalette(true); setPaletteQuery(''); }}
          title="Command Palette (Ctrl+Shift+P)"
          style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', cursor: 'pointer', padding: '3px 10px', borderRadius: 4, fontSize: 12 }}
        >
          ⌘ Ctrl+Shift+P
        </button>
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.3)' }} />
        {/* Runner mode toggle */}
        <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.25)', borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.2)' }}>
          {[
            { mode: 'local',  icon: '🖥️',  label: 'Local'  },
            { mode: 'auto',   icon: '⚡',  label: 'Auto'   },
            { mode: 'docker', icon: '🐳',  label: 'Docker' },
          ].map(({ mode, icon, label }) => (
            <button
              key={mode}
              onClick={() => setRunnerMode(mode)}
              title={`Runner: ${label} — ${mode === 'local' ? 'host terraform only' : mode === 'docker' ? 'Docker sandbox only' : 'local first, Docker fallback'}`}
              style={{
                background: runnerMode === mode ? 'rgba(255,255,255,0.25)' : 'transparent',
                border: 'none',
                color: runnerMode === mode ? '#fff' : 'rgba(255,255,255,0.55)',
                cursor: 'pointer',
                padding: '3px 8px',
                fontSize: 11,
                fontWeight: runnerMode === mode ? 700 : 400,
                display: 'flex', alignItems: 'center', gap: 3,
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 12 }}>{icon}</span> {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main Area ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Activity Bar */}
        <div style={{ width: 48, background: C.actBar, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, borderRight: `1px solid ${C.border}` }}>
          {[
            { id: 'explorer', icon: '📁', title: 'Explorer' },
            { id: 'outline',  icon: '⊞',  title: 'Outline' },
            { id: 'modules',  icon: '⧉',  title: 'Module Explorer' },
            { id: 'ai',       icon: '✨', title: 'AI Assistant — write or update code from a plain-English instruction' },
          ].map(({ id, icon, title }) => (
            <button
              key={id}
              onClick={() => setSidebarPanel(p => p === id ? null : id)}
              title={title}
              style={iconBtn(sidebarPanel === id)}
            >
              {icon}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => { setShowPalette(true); setPaletteQuery(''); }}
            title="Command Palette"
            style={iconBtn(false)}
          >⌘</button>
        </div>

        {/* Sidebar */}
        {sidebarPanel && (
          <div style={{ width: sidebarWidth, background: C.sidebar, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>

            {/* Sidebar header */}
            <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 1, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              {sidebarPanel === 'explorer' ? 'Explorer' : sidebarPanel === 'outline' ? 'Outline' : sidebarPanel === 'ai' ? '✨ AI Assistant' : 'Module Explorer'}
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>

              {/* EXPLORER */}
              {sidebarPanel === 'explorer' && (
                <>
                  <div style={{ padding: '4px 8px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>TERRAFORM FILES</div>
                  {Object.keys(files).map(fn => (
                    <div
                      key={fn}
                      onClick={() => switchFile(fn)}
                      style={{
                        padding: '5px 12px 5px 20px', fontSize: 13, cursor: 'pointer',
                        background: activeFile === fn ? '#37373d' : 'transparent',
                        color: activeFile === fn ? '#ffffff' : C.text,
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      <span style={{ color: '#e2c08d', fontSize: 11 }}>𝑓</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fn}</span>
                      {(problems[fn]?.filter(p => p.severity === 'error').length || 0) > 0 && (
                        <span style={{ color: C.red, fontSize: 11, fontWeight: 700 }}>
                          {problems[fn].filter(p => p.severity === 'error').length}
                        </span>
                      )}
                    </div>
                  ))}
                  <div
                    onClick={openNewFileDialog}
                    style={{ padding: '5px 12px 5px 20px', fontSize: 13, cursor: 'pointer', color: C.textDim, display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <span>＋</span> New File…
                  </div>
                </>
              )}

              {/* OUTLINE */}
              {sidebarPanel === 'outline' && (
                <>
                  {symbols.length === 0 ? (
                    <div style={{ padding: '16px 12px', fontSize: 12, color: C.textDim }}>
                      {lspRef.current.open ? 'No symbols found. Write some Terraform to see the outline.' : 'Outline requires terraform-ls to be installed and connected.'}
                    </div>
                  ) : (
                    symbols.map((sym, i) => (
                      <div
                        key={i}
                        onClick={() => {
                          // BUG-7 fix: _local symbols have no real line position;
                          // skip navigation to avoid jumping to line 1 for every resource.
                          if (!editorRef.current || sym._local || sym.range?.start?.line == null) return;
                          editorRef.current.revealLineInCenter(sym.range.start.line + 1);
                          editorRef.current.setPosition({ lineNumber: sym.range.start.line + 1, column: 1 });
                          editorRef.current.focus();
                        }}
                        style={{ padding: '4px 12px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: C.text }}
                      >
                        <span style={{ color: C.accentG, width: 14 }}>{symIcon(sym.kind).icon}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sym.name}</span>
                        {sym.detail && <span style={{ color: C.textDim, fontSize: 11 }}>{sym.detail}</span>}
                      </div>
                    ))
                  )}
                  {/* Fallback: parsed symbols */}
                  {symbols.length === 0 && (parsed.resources.length > 0 || parsed.variables.length > 0) && (
                    <>
                      <div style={{ padding: '4px 12px', fontSize: 11, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Resources</div>
                      {parsed.resources.map((r, i) => (
                        <div key={i} style={{ padding: '4px 12px 4px 24px', fontSize: 12, color: C.text, display: 'flex', gap: 6 }}>
                          <span style={{ color: C.accentG }}>▸</span>
                          <span style={{ fontSize: 11, color: C.textDim }}>{r.type}</span>
                          <span>.{r.name}</span>
                        </div>
                      ))}
                      <div style={{ padding: '4px 12px', fontSize: 11, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Variables</div>
                      {parsed.variables.map((v, i) => (
                        <div key={i} style={{ padding: '4px 12px 4px 24px', fontSize: 12, color: C.text, display: 'flex', gap: 6 }}>
                          <span style={{ color: '#9cdcfe' }}>≋</span> {v.name}
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}

              {/* MODULE EXPLORER */}
              {sidebarPanel === 'modules' && (
                <>
                  {/* Providers */}
                  <div style={{ padding: '6px 12px 2px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Providers</div>
                  {parsed.providers.length === 0 ? (
                    <div style={{ padding: '4px 12px', fontSize: 12, color: C.textDim }}>No providers found</div>
                  ) : parsed.providers.map((p, i) => (
                    <div key={i} style={{ padding: '5px 12px 5px 20px', fontSize: 12, color: C.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: '#4ec9b0' }}>⬡</span>
                      <span>{p.name}</span>
                      <a href={`https://registry.terraform.io/providers/hashicorp/${p.name}`} target="_blank" rel="noreferrer" style={{ color: C.textDim, fontSize: 10, marginLeft: 'auto' }}>↗</a>
                    </div>
                  ))}

                  {/* Modules */}
                  <div style={{ padding: '8px 12px 2px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Modules</div>
                  {parsed.modules.length === 0 ? (
                    <div style={{ padding: '4px 12px', fontSize: 12, color: C.textDim }}>No modules found</div>
                  ) : parsed.modules.map((m, i) => (
                    <div key={i} style={{ padding: '5px 12px 5px 20px', fontSize: 12, color: C.text }}>
                      <div style={{ fontWeight: 600 }}>{m.name}</div>
                      <div style={{ color: C.textDim, fontSize: 11 }}>{m.source}</div>
                    </div>
                  ))}

                  {/* Resources */}
                  <div style={{ padding: '8px 12px 2px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Resources ({parsed.resources.length})</div>
                  {parsed.resources.map((r, i) => (
                    <div key={i} style={{ padding: '4px 12px 4px 20px', fontSize: 12, color: C.text, display: 'flex', gap: 6 }}>
                      <span style={{ color: C.textDim, minWidth: 80, fontSize: 11 }}>{r.type}</span>
                      <span style={{ color: '#9cdcfe' }}>"{r.name}"</span>
                    </div>
                  ))}

                  {/* Outputs */}
                  <div style={{ padding: '8px 12px 2px', fontSize: 11, fontWeight: 700, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5 }}>Outputs ({parsed.outputs.length})</div>
                  {parsed.outputs.map((o, i) => (
                    <div key={i} style={{ padding: '4px 12px 4px 20px', fontSize: 12, color: '#ce9178' }}>"{o.name}"</div>
                  ))}
                </>
              )}

              {/* AI ASSISTANT */}
              {sidebarPanel === 'ai' && (
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.5 }}>
                    Describe a change and Claude will write it for <strong style={{ color: C.text }}>{activeFile}</strong>.
                    You'll get to review the result before anything is applied to your code.
                  </div>

                  <textarea
                    value={aiInstruction}
                    onChange={e => setAiInstruction(e.target.value)}
                    placeholder={`e.g. "Add an S3 bucket with versioning and encryption enabled" or "Add a variable for environment and reference it in the provider block"`}
                    rows={5}
                    disabled={aiLoading}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAiAssist(); }}
                    style={{
                      width: '100%', boxSizing: 'border-box', resize: 'vertical',
                      background: '#1e1e1e', color: C.text, border: `1px solid ${C.border}`,
                      borderRadius: 6, padding: 8, fontSize: 12, fontFamily: 'inherit', lineHeight: 1.5,
                    }}
                  />

                  <button
                    onClick={handleAiAssist}
                    disabled={aiLoading || !aiInstruction.trim()}
                    style={{
                      padding: '7px 12px', borderRadius: 6, border: 'none',
                      background: aiLoading || !aiInstruction.trim() ? '#3a3d41' : 'linear-gradient(135deg,#7C3AED,#2563EB)',
                      color: '#fff', fontSize: 12, fontWeight: 700,
                      cursor: aiLoading || !aiInstruction.trim() ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                  >
                    {aiLoading ? '⏳ Writing…' : '✨ Write / Update Code'}
                  </button>
                  <div style={{ fontSize: 10, color: C.textDim, marginTop: -4 }}>⌘/Ctrl + Enter to submit</div>

                  {aiError && (
                    <div style={{ fontSize: 11, color: '#f48771', background: '#5a1d1d', border: '1px solid #ac4142', borderRadius: 6, padding: '8px 10px' }}>
                      {aiError}
                    </div>
                  )}

                  {aiResult && (
                    <div style={{ border: `1px solid ${C.accent}`, borderRadius: 8, overflow: 'hidden', marginTop: 4 }}>
                      <div style={{ background: 'rgba(124,58,237,0.15)', padding: '8px 10px', fontSize: 11, color: C.text, lineHeight: 1.5 }}>
                        <strong>Proposed changes to {aiResult.forFile}:</strong>
                        <div style={{ color: C.textDim, marginTop: 4 }}>{aiResult.summary}</div>
                      </div>
                      <pre style={{
                        margin: 0, maxHeight: 260, overflow: 'auto', padding: '10px 12px',
                        fontSize: 11, lineHeight: 1.5, color: '#d4d4d4', background: '#1e1e1e',
                        fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>{aiResult.updated_code}</pre>
                      <div style={{ display: 'flex', gap: 8, padding: '8px 10px', background: C.sidebar, borderTop: `1px solid ${C.border}` }}>
                        <button onClick={handleApplyAi} style={{
                          flex: 1, padding: '6px 10px', borderRadius: 6, border: 'none',
                          background: '#0e7a3f', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}>✓ Apply to Editor</button>
                        <button onClick={handleDiscardAi} style={{
                          flex: 1, padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.border}`,
                          background: 'transparent', color: C.textDim, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>Discard</button>
                      </div>
                    </div>
                  )}

                  {!aiResult && !aiError && (
                    <div style={{ fontSize: 10, color: C.textDim, lineHeight: 1.5, marginTop: 4 }}>
                      💡 Requires <code>ANTHROPIC_API_KEY</code> to be set on the server. If it's not, you'll see an error here explaining that.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Editor + Bottom Panel column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Tab Bar */}
          <div style={{ height: 35, background: C.tab, display: 'flex', alignItems: 'flex-end', flexShrink: 0, borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
            {Object.keys(files).map(fn => {
              const isActive = fn === activeFile;
              const errCount = (problems[fn] || []).filter(p => p.severity === 'error').length;
              return (
                <div
                  key={fn}
                  onClick={() => switchFile(fn)}
                  style={{
                    height: '100%', padding: '0 16px', display: 'flex', alignItems: 'center', gap: 6,
                    background: isActive ? C.tabAct : 'transparent',
                    color: isActive ? '#ffffff' : C.textDim,
                    borderRight: `1px solid ${C.border}`,
                    borderTop: isActive ? `2px solid ${C.accent}` : '2px solid transparent',
                    cursor: 'pointer', fontSize: 13, flexShrink: 0, whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ color: '#e2c08d', fontSize: 11 }}>𝑓</span>
                  {fn}
                  {errCount > 0 && <span style={{ color: C.red, fontSize: 11, fontWeight: 700 }}>{errCount}</span>}
                </div>
              );
            })}
          </div>

          {/* Status line below tab bar */}
          <div style={{ height: 22, background: '#2d2d2d', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 16, flexShrink: 0, fontSize: 11, color: C.textDim, borderBottom: `1px solid ${C.border}` }}>
            <span>{activeFile}</span>
            <span style={{ color: status.type === 'ok' ? C.green : status.type === 'err' ? C.red : status.type === 'warn' ? C.yellow : C.textDim }}>
              {status.message}
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ color: lspStatus === 'ready' ? C.green : lspStatus.includes('offline') ? C.red : C.yellow }}>
              ⬡ LSP: {lspStatus}
            </span>
            {lspStatus.includes('offline') && (
              <button
                onClick={() => {
                  if (lspRef.current.retryTimer) clearTimeout(lspRef.current.retryTimer);
                  lspRef.current.retryCount = 0; lspRef.current.retryDelay = 2000;
                  setLspStatus('pending'); connectLsp();
                }}
                style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.accentG, cursor: 'pointer', padding: '1px 6px', borderRadius: 3, fontSize: 10 }}
              >↺ Reconnect</button>
            )}
          </div>

          {/* Monaco Editor */}
          <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            <MonacoEditor
              height="100%"
              language="terraform"
              theme="terraform-dark"
              value={activeContent}
              options={{
                automaticLayout: true,
                minimap: { enabled: true, scale: 1 },
                wordWrap: 'off',
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
                fontLigatures: true,
                fontSize: 13,
                lineNumbers: 'on',
                lineNumbersMinChars: 4,
                scrollBeyondLastLine: false,
                renderLineHighlight: 'all',
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: true, indentation: true },
                formatOnType: false,
                formatOnPaste: false,
                inlineSuggest: { enabled: false },
                // BUG-2 fix: quickSuggestions: false silently disabled trigger-character
                // completions (.  {  "  =  etc) so LSP suggestions never appeared on keystrokes.
                // Use per-context control instead: on for code, off in comments/strings.
                quickSuggestions: { other: 'on', comments: 'off', strings: 'on' },
                tabCompletion: 'on',
                suggest: {
                  showStatusBar: true,
                  preview: true,
                  filterGraceful: true,
                  showSnippets: true,
                  showKeywords: true,
                },
                parameterHints: { enabled: true },
                hover: { enabled: true, delay: 300 },
                codeLens: false,
                renderValidationDecorations: 'on',
                folding: true,
                foldingStrategy: 'indentation',
                showFoldingControls: 'mouseover',
                occurrencesHighlight: 'multiFile',
                selectionHighlight: true,
                find: { addExtraSpaceOnTop: false },
              }}
              beforeMount={beforeMonacoMount}
              onMount={onEditorMount}
              onChange={(value) => {
                const val = value || '';
                setFiles(prev => ({ ...prev, [activeFile]: val }));
                // LSP sync is handled exclusively by onDidChangeModelContent
                // (registered in onEditorMount). Calling updateLspDocument here
                // too would send two textDocument/didChange per keystroke and
                // double-increment the version counter, desynchronising terraform-ls.
              }}
            />
          </div>

          {/* Bottom Panel */}
          {bottomPanel && (
            <div style={{ height: bottomHeight, background: '#1e1e1e', borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              {/* Panel tab bar */}
              <div style={{ height: 30, background: C.tab, display: 'flex', alignItems: 'center', gap: 0, flexShrink: 0, borderBottom: `1px solid ${C.border}` }}>
                {[
                  { id: 'problems', label: `Problems${totalErrors + totalWarnings ? ` (${totalErrors + totalWarnings})` : ''}` },
                  { id: 'terminal', label: 'Terminal' },
                  { id: 'output',   label: 'Output (LSP)' },
                ].map(({ id, label }) => (
                  <div
                    key={id}
                    onClick={() => setBottomPanel(id)}
                    style={{
                      height: '100%', padding: '0 14px', display: 'flex', alignItems: 'center',
                      fontSize: 12, cursor: 'pointer',
                      color: bottomPanel === id ? '#ffffff' : C.textDim,
                      borderBottom: bottomPanel === id ? `2px solid ${C.accent}` : '2px solid transparent',
                    }}
                  >
                    {label}
                  </div>
                ))}
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => setBottomPanel(null)}
                  style={{ background: 'transparent', border: 'none', color: C.textDim, cursor: 'pointer', padding: '0 10px', fontSize: 16, height: '100%' }}
                >×</button>
              </div>

              {/* Panel content */}
              <div ref={termRef} style={{ flex: 1, overflowY: 'auto', padding: '6px 12px', fontSize: 12, fontFamily: '"JetBrains Mono", monospace', lineHeight: 1.6 }}>
                {bottomPanel === 'problems' && (
                  Object.entries(problems).length === 0 ||
                  Object.values(problems).flat().length === 0 ? (
                    <div style={{ color: C.textDim, padding: '8px 0' }}>No problems detected. ✓</div>
                  ) : (
                    Object.entries(problems).flatMap(([fn, probs]) =>
                      probs.map((p, i) => (
                        <div
                          key={`${fn}-${i}`}
                          onClick={() => {
                            switchFile(fn);
                            setTimeout(() => {
                              if (editorRef.current) {
                                editorRef.current.revealLineInCenter(p.line);
                                editorRef.current.setPosition({ lineNumber: p.line, column: p.col });
                                editorRef.current.focus();
                              }
                            }, 100);
                          }}
                          style={{ padding: '3px 0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                        >
                          <span style={{ color: p.severity === 'error' ? C.red : C.yellow, fontSize: 13 }}>
                            {p.severity === 'error' ? '✗' : '⚠'}
                          </span>
                          <span style={{ color: C.text }}>{p.message}</span>
                          <span style={{ color: C.textDim, marginLeft: 'auto' }}>{fn}:{p.line}:{p.col}</span>
                        </div>
                      ))
                    )
                  )
                )}

                {bottomPanel === 'terminal' && (
                  <>
                    {termLines.map((line, i) => (
                      <div key={i} style={{ color: line.startsWith('✗') ? C.red : line.startsWith('✓') ? C.green : line.startsWith('⚠') ? C.yellow : line.startsWith('$') ? C.accentG : C.text }}>
                        {line}
                      </div>
                    ))}
                    {busy.cmd && <div style={{ color: C.yellow }}>⏳ Running…</div>}
                  </>
                )}

                {bottomPanel === 'output' && (
                  lspLogs.length === 0 ? (
                    <div style={{ color: C.textDim }}>No LSP output yet.</div>
                  ) : (
                    lspLogs.map((l, i) => (
                      <div key={i} style={{ color: C.textDim }}>{l}</div>
                    ))
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div style={{ height: 22, background: C.statusBg, display: 'flex', alignItems: 'center', padding: '0 10px', gap: 16, flexShrink: 0, fontSize: 11, color: '#fff' }}>
        {/* Left */}
        <span
          title="LSP Status"
          style={{ cursor: 'pointer', opacity: 0.9 }}
          onClick={() => setBottomPanel('output')}
        >
          ⬡ {lspStatus}
        </span>
        <span style={{ opacity: 0.5 }}>|</span>
        <span
          onClick={() => setBottomPanel('problems')}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
        >
          {totalErrors > 0 && <span style={{ color: '#ffaaaa' }}>✗ {totalErrors}</span>}
          {totalWarnings > 0 && <span style={{ color: '#ffe88a' }}>⚠ {totalWarnings}</span>}
          {totalErrors === 0 && totalWarnings === 0 && <span style={{ opacity: 0.8 }}>✓ No problems</span>}
        </span>
        <div style={{ flex: 1 }} />
        {/* Right */}
        <span title="Active file">𝑓 {activeFile}</span>
        <span style={{ opacity: 0.5 }}>|</span>
        <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
        <span style={{ opacity: 0.5 }}>|</span>
        <span>HCL / Terraform</span>
        <span style={{ opacity: 0.5 }}>|</span>
        <span>UTF-8</span>
        <span style={{ opacity: 0.5 }}>|</span>
        {/* Toggle bottom panel */}
        <span
          onClick={() => setBottomPanel(p => p ? null : 'terminal')}
          style={{ cursor: 'pointer', opacity: 0.8 }}
          title="Toggle Panel"
        >⬛</span>
      </div>
    </div>
  );
}
