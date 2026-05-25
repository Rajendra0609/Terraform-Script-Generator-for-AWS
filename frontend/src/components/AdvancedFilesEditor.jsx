import React, { useState, useEffect } from 'react';
import { useTheme } from '../contexts/ThemeContext';

export default function AdvancedFilesEditor({ files = {}, onFileChange }) {
  const { c } = useTheme();
  const names = Object.keys(files);
  const [active, setActive] = useState(names[0] || 'main.tf');
  const [content, setContent] = useState(files[active] || '');

  useEffect(() => {
    const n = Object.keys(files);
    if (n.length && !n.includes(active)) setActive(n[0]);
    setContent(files[active] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  useEffect(() => { setContent(files[active] || ''); }, [active, files]);

  function handleSaveLocal(newContent) {
    setContent(newContent);
    if (onFileChange) onFileChange(active, newContent);
  }

  if (!names.length) return (
    <div style={{ padding: 20, color: c.fg2 }}>No files to display</div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${c.bd}`, background: c.bg }}>
        {names.map(n => (
          <div key={n} onClick={() => setActive(n)}
            style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', background: n === active ? c.bg2 : 'transparent', border: `1px solid ${n === active ? c.accent : c.bd}`, color: n === active ? c.fg : c.fg2, fontSize: 13 }}>
            {n}
          </div>
        ))}
      </div>

      <textarea value={content} onChange={e => handleSaveLocal(e.target.value)}
        style={{ flex: 1, width: '100%', height: '100%', padding: 12, fontFamily: 'JetBrains Mono, monospace', background: 'transparent', color: c.fg, border: 'none', outline: 'none', resize: 'none' }} />
    </div>
  );
}
