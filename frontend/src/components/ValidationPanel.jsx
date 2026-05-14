import React from 'react';

export default function ValidationPanel({ result, type, loading }) {
  if (loading) return (
    <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, color: '#8B949E', fontSize: 13 }}>
      <div style={{ width: 16, height: 16, border: '2px solid #7B42BC', borderTopColor: 'transparent', borderRadius: 8, animation: 'spin 0.8s linear infinite' }}/>
      Running terraform {type}...
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!result) return null;

  if (type === 'fmt') {
    return (
      <div style={{ padding: 16 }} className="fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: result.success ? '#3FB950' : (result.offline ? '#D29922' : '#F85149') }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: result.success ? '#3FB950' : (result.offline ? '#D29922' : '#F85149') }}>
            {result.offline ? 'Terraform CLI not available' : (result.success ? 'Code formatted successfully' : 'Format failed')}
          </span>
        </div>
        {result.message && <div style={{ fontSize: 12, color: '#8B949E', fontFamily: 'JetBrains Mono, monospace' }}>{result.message}</div>}
      </div>
    );
  }

  if (type === 'validate') {
    const isValid = result.valid;
    const isOffline = result.offline;
    return (
      <div style={{ padding: 16 }} className="fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: isOffline ? '#D29922' : (isValid ? '#3FB950' : '#F85149') }}/>
          <span style={{ fontSize: 13, fontWeight: 600, color: isOffline ? '#D29922' : (isValid ? '#3FB950' : '#F85149') }}>
            {isOffline ? 'Terraform CLI not available' : (isValid ? 'Configuration is valid' : 'Validation failed')}
          </span>
        </div>
        {result.message && <div style={{ fontSize: 12, color: '#8B949E', marginBottom: 10 }}>{result.message}</div>}
        {(result.diagnostics || []).map((d, i) => (
          <div key={i} style={{
            padding: '10px 12px', borderRadius: 6, marginBottom: 8,
            background: d.severity === 'error' ? '#2A1212' : '#2A2412',
            border: `1px solid ${d.severity === 'error' ? '#F8514944' : '#D2992244'}`
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: d.severity === 'error' ? '#F85149' : '#D29922', marginBottom: 4 }}>
              {d.severity?.toUpperCase()}: {d.summary}
            </div>
            {d.detail && <div style={{ fontSize: 12, color: '#8B949E', fontFamily: 'JetBrains Mono, monospace' }}>{d.detail}</div>}
            {d.range && (
              <div style={{ fontSize: 11, color: '#484F58', marginTop: 4 }}>
                Line {d.range.start?.line}, Col {d.range.start?.column}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return null;
}
