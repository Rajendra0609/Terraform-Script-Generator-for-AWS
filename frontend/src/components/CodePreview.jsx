import React, { useState } from 'react';

function colorizeHCL(code) {
  const lines = code.split('\n');
  return lines.map((line, i) => {
    let html = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/(#.*$)/gm, '<span style="color:#8B949E;font-style:italic">$1</span>')
      .replace(/\b(resource|module|provider|variable|output|locals|data|terraform)\b/g, '<span style="color:#F0883E;font-weight:600">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span style="color:#79C0FF">$1</span>')
      .replace(/"([^"]*?)"/g, '<span style="color:#A5D6FF">"$1"</span>')
      .replace(/\b(\d+)\b/g, '<span style="color:#79C0FF">$1</span>')
      .replace(/\b(source|version|region|tags|Name)\b/g, '<span style="color:#C9D1D9">$1</span>');
    return `<div class="line" style="display:flex"><span style="display:inline-block;width:40px;text-align:right;color:#484F58;user-select:none;padding-right:16px;flex-shrink:0">${i + 1}</span><span style="flex:1">${html}</span></div>`;
  }).join('');
}

export default function CodePreview({ hcl, onHclChange }) {
  const [editMode, setEditMode] = useState(false);

  if (!hcl) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#8B949E', fontSize: 13 }}>
      Configure a service to see generated HCL
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #30363D', background: '#161B22' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#F85149' }}/>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#D29922' }}/>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#3FB950' }}/>
        </div>
        <span style={{ fontSize: 12, color: '#8B949E', fontFamily: 'JetBrains Mono, monospace' }}>main.tf</span>
        <button onClick={() => setEditMode(m => !m)} style={{
          background: editMode ? '#21262D' : 'transparent',
          border: '1px solid #30363D', borderRadius: 5,
          color: '#8B949E', fontSize: 11, padding: '3px 8px', cursor: 'pointer'
        }}>
          {editMode ? 'Preview' : 'Edit'}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
        {editMode ? (
          <textarea
            value={hcl}
            onChange={e => onHclChange && onHclChange(e.target.value)}
            style={{
              width: '100%', height: '100%', background: 'transparent',
              border: 'none', outline: 'none', resize: 'none',
              color: '#E6EDF3', fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13, lineHeight: 1.6, padding: '0 16px'
            }}
          />
        ) : (
          <div
            style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.7, padding: '0 8px' }}
            dangerouslySetInnerHTML={{ __html: colorizeHCL(hcl) }}
          />
        )}
      </div>
    </div>
  );
}
