import React, { useEffect } from 'react';
import sanitizeHcl from '../utils/sanitizeHcl';

/**
 * Code editor component - Edit mode only
 */

export default function CodePreview({ hcl, onHclChange }) {
  // FE-09 fix: dependency array must include hcl and onHclChange so the
  // sanitization effect re-runs when the value or callback changes.
  useEffect(() => {
    if (!hcl) return;
    const clean = sanitizeHcl(hcl);
    if (clean !== hcl && onHclChange) {
      onHclChange(clean);
    }
  }, [hcl, onHclChange]); // was [] — caused sanitization to be skipped on async prop updates

  if (!hcl) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#6B7280', fontSize: 13 }}>
      Configure a service to see generated HCL
    </div>
  );

  const cleanHcl = sanitizeHcl(hcl);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: `1px solid #E5E7EB`, background: '#F9FAFB' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#EF4444' }}/>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#F59E0B' }}/>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: '#10B981' }}/>
        </div>
        <span style={{ fontSize: 12, color: '#6B7280', fontFamily: 'JetBrains Mono, monospace' }}>main.tf</span>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', color: '#374151' }}>✎ Edit</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0', background: '#FFFFFF' }}>
        <textarea
          value={cleanHcl}
          onChange={e => {
            const val = e.target.value;
            // Textarea only emits plain text, but guard against paste of styled content
            if (onHclChange) onHclChange(val);
          }}
          style={{
            width: '100%', height: '100%', background: 'transparent',
            border: 'none', outline: 'none', resize: 'none',
            color: '#111827', fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13, lineHeight: 1.7, padding: '0 16px',
          }}
        />
      </div>
    </div>
  );
}
