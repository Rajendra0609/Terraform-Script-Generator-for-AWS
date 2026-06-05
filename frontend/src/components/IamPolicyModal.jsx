import React, { useState, useEffect } from 'react';
import { iamAPI } from '../api/client';

export default function IamPolicyModal({ resources = [], onClose, c }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState('merged'); // 'merged' | 'breakdown'

  const serviceTypes = [...new Set(resources.map(r => r.service_type || r.serviceType).filter(Boolean))];

  useEffect(() => {
    if (!serviceTypes.length) return;
    setLoading(true);
    iamAPI.generateBatch(serviceTypes)
      .then(r => setResult(r.data))
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const copyPolicy = async () => {
    const text = mode === 'merged' ? result?.merged_policy_json : JSON.stringify(result?.breakdown, null, 2);
    await navigator.clipboard.writeText(text || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modal: { background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 16, width: 760, maxWidth: '95vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' },
    header: { padding: '16px 20px', borderBottom: `1px solid ${c.bd}`, display: 'flex', alignItems: 'center', gap: 12 },
    body: { flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 },
    code: { background: c.bg2, border: `1px solid ${c.bd}`, borderRadius: 10, padding: 14, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: c.fg, overflow: 'auto', whiteSpace: 'pre', flex: 1, lineHeight: 1.6 },
    tabBtn: (active) => ({ padding: '5px 14px', borderRadius: 6, border: `1px solid ${active ? c.accent : c.bd}`, background: active ? c.accent + '20' : 'transparent', color: active ? c.accent : c.fg3, cursor: 'pointer', fontSize: 12, fontWeight: 600 }),
    noteCard: { background: c.bg3, border: `1px solid ${c.bd}`, borderRadius: 8, padding: '10px 14px', fontSize: 11, color: c.fg2, lineHeight: 1.5 },
    btn: (variant) => ({ padding: '7px 16px', borderRadius: 8, border: 'none', background: variant === 'accent' ? c.accent : c.bg3, color: variant === 'accent' ? '#001A0F' : c.fg2, fontWeight: 700, fontSize: 12, cursor: 'pointer' }),
  };

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: c.fg }}>🛡️ IAM Policy Generator</div>
            <div style={{ fontSize: 11, color: c.fg3, marginTop: 2 }}>
              Minimum permissions for: {serviceTypes.join(', ') || 'no services selected'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={s.tabBtn(mode === 'merged')} onClick={() => setMode('merged')}>Merged Policy</button>
            <button style={s.tabBtn(mode === 'breakdown')} onClick={() => setMode('breakdown')}>By Service</button>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 20, padding: 4 }}>×</button>
        </div>

        <div style={s.body}>
          {loading && <div style={{ textAlign: 'center', color: c.fg3, padding: 40 }}>⏳ Generating policy…</div>}

          {!loading && !serviceTypes.length && (
            <div style={{ textAlign: 'center', color: c.fg3, padding: 40 }}>
              Add services to your project first, then come back here to generate the IAM policy.
            </div>
          )}

          {!loading && result && mode === 'merged' && (
            <>
              <div style={s.noteCard}>
                <strong style={{ color: c.fg }}>⚠️ Before using this policy:</strong><br />
                {result.notes?.join(' ')}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: c.fg3 }}>aws_iam_policy document (JSON)</span>
                <button style={s.btn('accent')} onClick={copyPolicy}>
                  {copied ? '✓ Copied!' : '📋 Copy JSON'}
                </button>
              </div>
              <pre style={s.code}>{result.merged_policy_json}</pre>
            </>
          )}

          {!loading && result && mode === 'breakdown' && (
            <>
              {result.breakdown?.map((svc, i) => (
                <div key={i} style={{ background: c.bg2, border: `1px solid ${c.bd}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', background: c.bg3, borderBottom: `1px solid ${c.bd}`, display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: c.fg }}>{svc.name}</span>
                      <span style={{ fontSize: 11, color: c.fg3, marginLeft: 8 }}>({svc.service_type})</span>
                    </div>
                    <span style={{ fontSize: 11, color: c.accent }}>{svc.statements?.reduce((a, s) => a + s.actions.length, 0)} actions</span>
                  </div>
                  {svc.statements?.map((stmt, j) => (
                    <div key={j} style={{ padding: '10px 14px', borderBottom: j < svc.statements.length - 1 ? `1px solid ${c.bd}` : 'none' }}>
                      {stmt.note && <div style={{ fontSize: 11, color: c.fg3, fontStyle: 'italic', marginBottom: 6 }}>📌 {stmt.note}</div>}
                      <div style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: c.fg2, lineHeight: 1.6 }}>
                        {stmt.actions.join(' · ')}
                      </div>
                      <div style={{ fontSize: 10, color: c.fg3, marginTop: 4 }}>Resource: {stmt.resources.join(', ')}</div>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
