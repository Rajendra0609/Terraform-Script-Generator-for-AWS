import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

export default function ValidationPanel({ result, type, loading }) {
  const { c } = useTheme();

  if (loading) return (
    <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, color: c.fg2, fontSize: 13 }}>
      <div style={{ width: 16, height: 16, border: `2px solid ${c.accent}`, borderTopColor: 'transparent', borderRadius: 8, animation: 'spin 0.8s linear infinite' }}/>
      Running terraform {type}...
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!result) return null;

  if (type === 'fmt') {
    return (
      <div style={{ padding: 16 }} className="fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: result.success ? c.ok : (result.offline ? c.warn : c.err) }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: result.success ? c.ok : (result.offline ? c.warn : c.err) }}>
            {result.offline ? 'Terraform CLI not available' : (result.success ? 'Code formatted successfully' : 'Format failed')}
          </span>
        </div>
        {result.message && <div style={{ fontSize: 12, color: c.fg2, fontFamily: 'JetBrains Mono, monospace' }}>{result.message}</div>}
      </div>
    );
  }

  if (type === 'validate') {
    const isValid = result.valid;
    const isOffline = result.offline;
    return (
      <div style={{ padding: 16 }} className="fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: isOffline ? c.warn : (isValid ? c.ok : c.err) }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: isOffline ? c.warn : (isValid ? c.ok : c.err) }}>
            {isOffline ? 'Terraform CLI not available' : (isValid ? 'Configuration is valid' : 'Validation failed')}
          </span>
        </div>
        {result.message && <div style={{ fontSize: 12, color: c.fg2, marginBottom: 10 }}>{result.message}</div>}
        {(result.diagnostics || []).map((d, i) => (
          <div key={i} style={{
            padding: '10px 12px', borderRadius: 6, marginBottom: 8,
            background: d.severity === 'error' ? c.errBg : c.warnBg,
            border: `1px solid ${d.severity === 'error' ? c.err + '44' : c.warn + '44'}`
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: d.severity === 'error' ? c.err : c.warn, marginBottom: 4 }}>
              {d.severity?.toUpperCase()}: {d.summary}
            </div>
            {d.detail && <div style={{ fontSize: 12, color: c.fg2, fontFamily: 'JetBrains Mono, monospace' }}>{d.detail}</div>}
            {d.range && (
              <div style={{ fontSize: 11, color: c.fg3, marginTop: 4 }}>
                Line {d.range.start?.line}, Col {d.range.start?.column}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (type === 'plan') {
    const summary = result.summary || {};
    return (
      <div style={{ padding: 16 }} className="fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: c.info }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: c.info }}>Plan Preview</span>
        </div>
        {result.message && <div style={{ fontSize: 12, color: c.fg2, marginBottom: 10 }}>{result.message}</div>}
        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: c.fg2 }}>Creates: <strong style={{ color: c.ok }}>{summary.create_count ?? 0}</strong></div>
          <div style={{ fontSize: 12, color: c.fg2 }}>Updates: <strong style={{ color: c.warn }}>{summary.update_count ?? 0}</strong></div>
          <div style={{ fontSize: 12, color: c.fg2 }}>Destroys: <strong style={{ color: c.err }}>{summary.delete_count ?? 0}</strong></div>
        </div>
        <div>
          {(result.resource_changes || []).slice(0, 200).map((ch, i) => (
            <div key={i} style={{ padding: '8px 10px', borderRadius: 6, marginBottom: 8, background: c.bg, border: `1px solid ${c.bd}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: c.fg }}>{ch.address || `${ch.type}.${ch.name}`}</div>
                  <div style={{ fontSize: 12, color: c.fg2 }}>Actions: {(ch.change?.actions || []).join(', ')}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
}
