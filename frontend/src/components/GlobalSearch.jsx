import React, { useState, useEffect, useRef, useCallback } from 'react';
import API from '../api/client';

const TYPE_ICON = {
  project:  '📁',
  resource: '📦',
  template: '🧩',
  policy:   '🛡',
  audit:    '📋',
};

const TYPE_COLOR = {
  project:  { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
  resource: { bg: '#F0FDF4', border: '#A7F3D0', text: '#065F46' },
  template: { bg: '#F5F3FF', border: '#DDD6FE', text: '#5B21B6' },
  policy:   { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
  audit:    { bg: '#F9FAFB', border: '#E5E7EB', text: '#374151' },
};

/**
 * GlobalSearch — Command-palette style search modal + keyboard shortcut (Ctrl/Cmd+K)
 *
 * Props:
 *   onNavigate(href) — called when user selects a result
 */
export default function GlobalSearch({ onNavigate }) {
  const [open,    setOpen]    = useState(false);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef  = useRef(null);
  const listRef   = useRef(null);
  const debounceRef = useRef(null);

  // Keyboard shortcut: Ctrl+K or Cmd+K
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setResults([]);
      setSelected(0);
    }
  }, [open]);

  const search = useCallback(async (q) => {
    if (!q || q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const r = await API.get(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
      setResults(r.data?.results || []);
      setSelected(0);
    } catch (_) {
      setResults([]);
    } finally { setLoading(false); }
  }, []);

  const onInput = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 280);
  };

  const navigate = (result) => {
    if (result.link && onNavigate) {
      onNavigate(result.link);
    }
    setOpen(false);
  };

  // Keyboard navigation in results
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' && results[selected]) {
      navigate(results[selected]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.querySelectorAll('[data-result]')[selected];
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 12px', borderRadius: 8, border: '1px solid #E5E7EB',
          background: '#F9FAFB', color: '#9CA3AF', fontSize: 12,
          cursor: 'pointer', minWidth: 160,
        }}
        title="Global search (Ctrl+K)"
      >
        <span>🔍</span>
        <span style={{ flex: 1, textAlign: 'left' }}>Search…</span>
        <span style={{
          fontSize: 10, background: '#F3F4F6', border: '1px solid #E5E7EB',
          borderRadius: 4, padding: '1px 5px', color: '#6B7280',
        }}>⌘K</span>
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            zIndex: 10000, paddingTop: '12vh', paddingLeft: 20, paddingRight: 20,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div style={{
            background: '#FFFFFF', borderRadius: 14, width: '100%', maxWidth: 620,
            boxShadow: '0 25px 60px rgba(0,0,0,0.2)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            maxHeight: '70vh',
          }}>
            {/* Search input */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '14px 16px', borderBottom: `1px solid ${results.length ? '#E5E7EB' : 'transparent'}`,
            }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>
                {loading ? '⏳' : '🔍'}
              </span>
              <input
                ref={inputRef}
                value={query}
                onChange={onInput}
                onKeyDown={onKeyDown}
                placeholder="Search projects, resources, templates…"
                style={{
                  flex: 1, border: 'none', outline: 'none', fontSize: 16,
                  color: '#111827', background: 'transparent', fontFamily: 'inherit',
                }}
              />
              {query && (
                <button
                  onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
                  style={{ border: 'none', background: '#F3F4F6', borderRadius: 6, width: 22, height: 22, cursor: 'pointer', fontSize: 11, color: '#9CA3AF' }}
                >✕</button>
              )}
              <button
                onClick={() => setOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 12, color: '#9CA3AF', cursor: 'pointer', padding: '2px 6px', borderRadius: 5, border: '1px solid #E5E7EB' }}
              >Esc</button>
            </div>

            {/* Results */}
            <div ref={listRef} style={{ overflowY: 'auto', flex: 1 }}>
              {!query && (
                <div style={{ padding: '24px 20px', textAlign: 'center', color: '#9CA3AF' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🔍</div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: '#374151' }}>Search everything</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Projects, resources, templates, policies</div>
                  <div style={{ fontSize: 11, marginTop: 12, color: '#D1D5DB' }}>
                    Use ↑↓ to navigate · Enter to open · Esc to close
                  </div>
                </div>
              )}

              {query && !loading && results.length === 0 && query.length >= 2 && (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9CA3AF' }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>😕</div>
                  <div style={{ fontSize: 14, color: '#374151' }}>No results for "{query}"</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Try a different search term</div>
                </div>
              )}

              {results.length > 0 && (
                <>
                  {/* Group by type */}
                  {groupByType(results).map(([type, items]) => (
                    <div key={type}>
                      <div style={{
                        padding: '8px 16px 4px',
                        fontSize: 10, fontWeight: 700, color: '#9CA3AF',
                        letterSpacing: '0.08em', textTransform: 'uppercase',
                      }}>
                        {TYPE_ICON[type]} {type}s
                      </div>
                      {items.map((r) => {
                        const idx = results.indexOf(r);
                        const isSelected = idx === selected;
                        const tc = TYPE_COLOR[r.type] || TYPE_COLOR.project;
                        return (
                          <div
                            key={r.id}
                            data-result
                            onClick={() => navigate(r)}
                            onMouseEnter={() => setSelected(idx)}
                            style={{
                              padding: '10px 16px',
                              background: isSelected ? '#EFF6FF' : '#FFFFFF',
                              cursor: r.link ? 'pointer' : 'default',
                              display: 'flex', alignItems: 'center', gap: 12,
                              borderBottom: '1px solid #F9FAFB',
                            }}
                          >
                            <div style={{ fontSize: 18, flexShrink: 0 }}>{TYPE_ICON[r.type]}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 13, fontWeight: isSelected ? 600 : 500,
                                color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {highlight(r.title, query)}
                              </div>
                              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 1 }}>
                                {r.subtitle}
                              </div>
                            </div>
                            <span style={{
                              fontSize: 10, padding: '2px 7px', borderRadius: 5,
                              background: tc.bg, border: `1px solid ${tc.border}`, color: tc.text,
                              flexShrink: 0, fontWeight: 600,
                            }}>
                              {r.type}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <div style={{ height: 6 }} />
                </>
              )}
            </div>

            {/* Footer */}
            {results.length > 0 && (
              <div style={{
                padding: '8px 16px', borderTop: '1px solid #E5E7EB',
                display: 'flex', gap: 12, fontSize: 11, color: '#9CA3AF',
              }}>
                <span>↑↓ navigate</span>
                <span>↩ open</span>
                <span>Esc close</span>
                <span style={{ marginLeft: 'auto' }}>{results.length} result{results.length !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function groupByType(results) {
  const order = ['project', 'resource', 'template', 'policy', 'audit'];
  const map = {};
  for (const r of results) {
    if (!map[r.type]) map[r.type] = [];
    map[r.type].push(r);
  }
  return order.filter(t => map[t]).map(t => [t, map[t]]);
}

function highlight(text, query) {
  if (!query || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#FEF9C3', color: 'inherit', borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
