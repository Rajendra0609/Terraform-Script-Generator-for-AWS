/**
 * ApplyStatusPanel
 *
 * Renders the "Apply" action area in the Builder toolbar. Before an apply
 * job is started it shows an Apply button. Once clicked it:
 *  1. Calls POST /api/terraform/apply → gets { jobId }
 *  2. Opens a WebSocket via useJobStream(jobId) for real-time log streaming
 *  3. Renders a scrollable live-log terminal and a final outcome banner
 *
 * Props:
 *   hcl        — string  — current HCL content from the editor
 *   projectId  — string  — UUID of the active project (required to apply)
 *   runner     — 'auto'|'local'|'docker'
 *   hasCredentials — bool — whether the user has saved AWS credentials
 *   onComplete — (result) => void  — called when apply finishes (success or fail)
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { terraformAPI } from '../api/client';
import { useJobStream } from '../hooks/useJobStream';

const STATUS_COLORS = {
  idle:       'text-gray-500 dark:text-gray-400',
  connecting: 'text-blue-500',
  running:    'text-blue-500',
  succeeded:  'text-green-600 dark:text-green-400',
  failed:     'text-red-600 dark:text-red-400',
};

const STATUS_ICONS = {
  idle:       '▶',
  connecting: '⏳',
  running:    '⚙️',
  succeeded:  '✅',
  failed:     '❌',
};

export function ApplyStatusPanel({ hcl, projectId, runner = 'auto', hasCredentials = true, onComplete }) {
  const [jobId,      setJobId]      = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState(null);
  const [confirmed,  setConfirmed]  = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const logEndRef = useRef(null);

  const { status, logs, result, error, reset } = useJobStream(jobId);

  // Auto-scroll log terminal
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Notify parent when complete
  useEffect(() => {
    if ((status === 'succeeded' || status === 'failed') && result) {
      onComplete?.(result);
    }
  }, [status, result, onComplete]);

  const handleApplyClick = () => {
    if (!projectId) return;
    if (!hasCredentials) return;
    setShowConfirm(true);
    setConfirmed(false);
  };

  const handleConfirm = useCallback(async () => {
    if (!confirmed) return;
    setShowConfirm(false);
    setSubmitting(true);
    setSubmitErr(null);
    reset();
    setJobId(null);

    try {
      const { data } = await terraformAPI.apply(hcl, projectId, runner);
      setJobId(data.jobId);
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Failed to start apply';
      setSubmitErr(msg);
    } finally {
      setSubmitting(false);
    }
  }, [confirmed, hcl, projectId, runner, reset]);

  const handleReset = () => {
    reset();
    setJobId(null);
    setSubmitErr(null);
    setShowConfirm(false);
    setConfirmed(false);
  };

  const isRunning = status === 'connecting' || status === 'running';

  // ── No credentials warning ─────────────────────────────────────────────────
  if (!hasCredentials) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-500 text-xl mt-0.5">⚠️</span>
          <div>
            <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm">AWS credentials required</p>
            <p className="text-amber-700 dark:text-amber-400 text-xs mt-1">
              Go to <strong>Settings → AWS Credentials</strong> and connect your AWS account before running Apply.
              Terraform needs real credentials to provision infrastructure.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── No project warning ─────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 text-sm text-gray-500 dark:text-gray-400">
        Save your HCL as a project first, then you can apply it.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">

      {/* ── Confirm dialog ────────────────────────────────────────────────── */}
      {showConfirm && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4">
          <p className="font-semibold text-red-800 dark:text-red-300 text-sm mb-2">
            ⚠️ You are about to provision real AWS infrastructure
          </p>
          <p className="text-red-700 dark:text-red-400 text-xs mb-3">
            This will run <code>terraform apply -auto-approve</code> against your AWS account.
            Resources will be created, updated, or destroyed. Costs may be incurred. This cannot be undone automatically.
          </p>
          <label className="flex items-center gap-2 text-sm text-red-800 dark:text-red-300 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="rounded"
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
            />
            I understand this will modify real AWS resources
          </label>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={!confirmed}
              className="px-4 py-1.5 rounded bg-red-600 text-white text-sm font-medium
                         hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Apply now
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-4 py-1.5 rounded border border-gray-300 dark:border-gray-600
                         text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Submit error ───────────────────────────────────────────────────── */}
      {submitErr && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
          {submitErr}
        </div>
      )}

      {/* ── Trigger button row ─────────────────────────────────────────────── */}
      {!showConfirm && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleApplyClick}
            disabled={submitting || isRunning || !hcl?.trim()}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-red-600 text-white
                       text-sm font-semibold hover:bg-red-700 active:bg-red-800
                       disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
          >
            {isRunning
              ? <><span className="animate-spin">⚙️</span> Applying…</>
              : <>{STATUS_ICONS[status]} {status === 'succeeded' ? 'Applied ✓' : status === 'failed' ? 'Failed — Retry?' : 'Apply'}</>
            }
          </button>

          {(status !== 'idle') && (
            <button
              onClick={handleReset}
              disabled={isRunning}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200
                         disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Reset
            </button>
          )}

          <span className={`text-xs font-medium ${STATUS_COLORS[status]}`}>
            {status === 'idle'       ? 'Ready'
            : status === 'connecting' ? 'Connecting…'
            : status === 'running'    ? 'Running apply…'
            : status === 'succeeded'  ? 'Apply succeeded'
            : 'Apply failed'}
          </span>
        </div>
      )}

      {/* ── Live log terminal ─────────────────────────────────────────────── */}
      {(logs.length > 0 || isRunning) && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900 border-b border-gray-700">
            <span className="text-xs text-gray-400 font-mono">terraform apply</span>
            {isRunning && (
              <span className="ml-auto flex items-center gap-1 text-xs text-blue-400">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                live
              </span>
            )}
          </div>
          <pre
            className="bg-gray-950 text-green-300 text-xs font-mono p-3 max-h-72 overflow-y-auto leading-5 whitespace-pre-wrap break-all"
            aria-label="terraform apply live output"
          >
            {logs.join('')}
            <span ref={logEndRef} />
          </pre>
        </div>
      )}

      {/* ── Outcome banner ─────────────────────────────────────────────────── */}
      {status === 'succeeded' && result && (
        <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-3">
          <p className="font-semibold text-green-800 dark:text-green-300 text-sm mb-1">✅ Apply succeeded</p>
          {result.summary && (
            <p className="text-green-700 dark:text-green-400 text-xs">
              {result.summary.create_count ?? 0} added ·{' '}
              {result.summary.update_count ?? 0} changed ·{' '}
              {result.summary.delete_count ?? 0} destroyed
            </p>
          )}
        </div>
      )}

      {status === 'failed' && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3">
          <p className="font-semibold text-red-800 dark:text-red-300 text-sm mb-1">❌ Apply failed</p>
          {(error || result?.message) && (
            <p className="text-red-700 dark:text-red-400 text-xs font-mono whitespace-pre-wrap break-all">
              {error || result?.message}
            </p>
          )}
        </div>
      )}

    </div>
  );
}
