/**
 * useJobStream — subscribe to a terraform execution job's lifecycle.
 *
 * Opens a WebSocket to /ws/jobs?id=<jobId> for real-time log streaming and
 * the final `done` event. If the WS is not available (e.g. the user
 * navigated away and came back to a job that's already finished) it falls
 * back to a single GET /api/terraform/jobs/:jobId poll.
 *
 * Usage:
 *   const { status, logs, result, error } = useJobStream(jobId);
 *
 * Returns:
 *   status  — 'idle' | 'connecting' | 'running' | 'succeeded' | 'failed'
 *   logs    — string[]   (each element is one log line)
 *   result  — the JSON result from the `done` event (or the jobs/:id row)
 *   error   — string | null
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { jobsAPI } from '../api/client';

const POLL_INTERVAL_MS = 3000;  // fallback poll frequency while job is running
const MAX_LOG_LINES    = 2000;  // keep memory bounded

export function useJobStream(jobId) {
  const [status, setStatus]   = useState('idle');
  const [logs,   setLogs]     = useState([]);
  const [result, setResult]   = useState(null);
  const [error,  setError]    = useState(null);

  const wsRef      = useRef(null);
  const pollTimerRef = useRef(null);

  const appendLog = useCallback((line) => {
    setLogs(prev => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
    });
  }, []);

  const stopPolling = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;
  };

  const startPolling = useCallback((id) => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      try {
        const { data } = await jobsAPI.get(id);
        setStatus(data.status === 'succeeded' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'running');
        if (data.error) setError(data.error);
        if (data.status === 'succeeded' || data.status === 'failed') {
          setResult(data);
          stopPolling();
        }
      } catch (_) { /* network glitch — try again next tick */ }
    }, POLL_INTERVAL_MS);
  }, []);

  useEffect(() => {
    if (!jobId) return;

    setStatus('connecting');
    setLogs([]);
    setResult(null);
    setError(null);

    let ws;
    let settled = false;
    // SECURITY/CORRECTNESS FIX (L-03): `ws.onclose` used to check the
    // `status` state variable directly, but that closure is created once
    // when this effect runs (deps: [jobId]) and never sees later
    // setStatus(...) calls from onmessage — so the check inside onclose was
    // effectively always comparing against status's pre-connection value,
    // silently reducing the guard to just `ev.code !== 1000`. A ref is
    // mutable and read fresh on every access, so onclose always sees
    // whether onmessage's `done` branch already ran, no closure staleness
    // possible.
    const finishedRef = { current: false };

    try {
      ws = jobsAPI.connectWs(jobId);
      wsRef.current = ws;
    } catch (wsErr) {
      // WebSocket constructor can throw in some environments
      setStatus('running');
      startPolling(jobId);
      return;
    }

    const connectTimeout = setTimeout(() => {
      // If ws hasn't opened within 3 s, fall back to polling
      if (!settled && ws.readyState !== WebSocket.OPEN) {
        ws.close();
        setStatus('running');
        startPolling(jobId);
      }
    }, 3000);

    ws.onopen = () => {
      settled = true;
      clearTimeout(connectTimeout);
      setStatus('running');
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'log') {
          appendLog(msg.line ?? JSON.stringify(msg));
        } else if (msg.type === 'done') {
          const r = msg.result || {};
          const succeeded = r.success !== false && r.valid !== false && !r.blocked;
          finishedRef.current = true;
          setStatus(succeeded ? 'succeeded' : 'failed');
          if (r.error || r.message) setError(r.error || r.message);
          setResult(r);
        } else if (msg.type === 'connected') {
          // handshake — nothing to display
        }
      } catch (_) {
        // Non-JSON text log line (legacy format)
        appendLog(ev.data);
      }
    };

    ws.onerror = () => {
      if (!settled) {
        // WS failed before opening — fall through to polling
        clearTimeout(connectTimeout);
        setStatus('running');
        startPolling(jobId);
      }
    };

    ws.onclose = (ev) => {
      clearTimeout(connectTimeout);
      // Code 1000 = normal close from server after `done`; anything else
      // that isn't already settled means WS dropped mid-stream. Checking
      // finishedRef (always current) instead of `status` (stale closure)
      // means a clean close after a `done` event correctly skips the
      // needless fallback poll.
      if (ev.code !== 1000 && !finishedRef.current) {
        startPolling(jobId);
      }
    };

    return () => {
      clearTimeout(connectTimeout);
      stopPolling();
      try { ws.close(); } catch (_) {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const reset = useCallback(() => {
    stopPolling();
    try { wsRef.current?.close(); } catch (_) {}
    setStatus('idle');
    setLogs([]);
    setResult(null);
    setError(null);
  }, []);

  return { status, logs, result, error, reset };
}
