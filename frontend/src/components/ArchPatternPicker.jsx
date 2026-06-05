import React, { useState, useEffect } from 'react';
import { learnAPI } from '../api/client';

const DIFF_COLORS = { Foundational: '#34D399', Beginner: '#34D399', Intermediate: '#FCD34D', Advanced: '#FB7185' };

export default function ArchPatternPicker({ onApply, onClose, c }) {
  const [patterns, setPatterns] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    learnAPI.getPatterns().then(r => {
      setPatterns(r.data.patterns || []);
      setCategories(r.data.categories || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = filter === 'all' ? patterns : patterns.filter(p => p.category === filter);

  const s = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modal: { background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 16, width: 860, maxWidth: '95vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)' },
    toolbar: { padding: '16px 20px 12px', borderBottom: `1px solid ${c.bd}`, display: 'flex', alignItems: 'center', gap: 12 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, padding: 16, overflow: 'auto', flex: 1 },
    card: (sel) => ({ background: sel ? c.accent + '12' : c.bg2, border: `1.5px solid ${sel ? c.accent : c.bd}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 8 }),
    detail: { width: 280, borderLeft: `1px solid ${c.bd}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto', flexShrink: 0 },
    chip: (active) => ({ padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? c.accent : c.bd}`, background: active ? c.accent + '20' : 'transparent', color: active ? c.accent : c.fg3 }),
  };

  return (
    <div style={s.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.toolbar}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: c.fg }}>🏗️ Architecture Patterns</div>
            <div style={{ fontSize: 11, color: c.fg3, marginTop: 2 }}>Select a real-world pattern to load into the builder</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={s.chip(filter === 'all')} onClick={() => setFilter('all')}>All</span>
            {categories.map(cat => (
              <span key={cat} style={s.chip(filter === cat)} onClick={() => setFilter(cat)}>{cat}</span>
            ))}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4, borderRadius: 6 }}>×</button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Pattern Grid */}
          <div style={s.grid}>
            {loading && <div style={{ gridColumn: '1/-1', textAlign: 'center', color: c.fg3, fontSize: 12, padding: 30 }}>Loading patterns…</div>}
            {filtered.map(p => (
              <div key={p.id} style={s.card(selected?.id === p.id)}
                onClick={() => setSelected(p)}
                onMouseEnter={e => { if (selected?.id !== p.id) e.currentTarget.style.borderColor = c.accent + '50'; }}
                onMouseLeave={e => { if (selected?.id !== p.id) e.currentTarget.style.borderColor = c.bd; }}>
                <div style={{ fontSize: 28, lineHeight: 1 }}>{p.icon}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: c.fg }}>{p.name}</div>
                <div style={{ fontSize: 10, color: DIFF_COLORS[p.difficulty] || c.fg3, fontWeight: 600 }}>{p.difficulty} · {p.category}</div>
                <div style={{ fontSize: 11, color: c.fg2, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.description}</div>
              </div>
            ))}
          </div>

          {/* Pattern Detail */}
          {selected && (
            <div style={s.detail}>
              <div>
                <div style={{ fontSize: 28, marginBottom: 8 }}>{selected.icon}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: c.fg, marginBottom: 4 }}>{selected.name}</div>
                <span style={{ fontSize: 11, color: DIFF_COLORS[selected.difficulty], fontWeight: 600 }}>{selected.difficulty}</span>
              </div>

              <p style={{ fontSize: 12, color: c.fg2, margin: 0, lineHeight: 1.6 }}>{selected.description}</p>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: c.fg3, letterSpacing: '0.08em', marginBottom: 8 }}>Why it works</div>
                <p style={{ fontSize: 12, color: c.fg2, margin: 0, lineHeight: 1.6 }}>{selected.whyItWorks}</p>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: c.fg3, letterSpacing: '0.08em', marginBottom: 8 }}>Services ({selected.services?.length})</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {selected.services?.map(svc => (
                    <span key={svc} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, background: c.accent + '18', color: c.accent, fontWeight: 600 }}>{svc}</span>
                  ))}
                </div>
              </div>

              {selected.connections?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: c.fg3, letterSpacing: '0.08em', marginBottom: 8 }}>Connections</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {selected.connections.map((conn, i) => (
                      <div key={i} style={{ fontSize: 11, color: c.fg2, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <code style={{ color: c.accent, background: c.bg3, padding: '2px 5px', borderRadius: 4 }}>{conn.from}</code>
                        <span style={{ color: c.fg3 }}>→ {conn.label} →</span>
                        <code style={{ color: c.accent, background: c.bg3, padding: '2px 5px', borderRadius: 4 }}>{conn.to}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={() => { onApply(selected); onClose(); }}
                style={{ padding: '10px 20px', borderRadius: 9, border: 'none', background: c.accent, color: '#001A0F', fontWeight: 700, fontSize: 13, cursor: 'pointer', marginTop: 'auto' }}>
                ⚡ Load Pattern
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
