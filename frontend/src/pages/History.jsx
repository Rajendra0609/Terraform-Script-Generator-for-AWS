import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectsAPI } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { getLastProjectId } from '../utils/lastProjectStorage';

// ─── Lightweight Myers diff (line-level) ──────────────────────────────────────
function computeDiff(aText, bText) {
  const a = (aText || '').split('\n');
  const b = (bText || '').split('\n');
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);

  const result = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      result.push({ type: 'same', text: a[i], lineA: i + 1, lineB: j + 1 });
      i++; j++;
    } else if (j < n && (i >= m || dp[i+1]?.[j] <= dp[i]?.[j+1])) {
      result.push({ type: 'add', text: b[j], lineB: j + 1 });
      j++;
    } else {
      result.push({ type: 'remove', text: a[i], lineA: i + 1 });
      i++;
    }
  }
  return result;
}

// ─── Token-level syntax highlight (minimal HCL) ──────────────────────────────
function hclHighlight(line, baseColor) {
  // keyword, string, number, comment
  const tokens = [];
  let rest = line;
  while (rest.length) {
    // comment
    const cm = rest.match(/^(#.*|\/\/.*)/);
    if (cm) { tokens.push(<span key={tokens.length} style={{ color: '#6b7280', fontStyle: 'italic' }}>{cm[0]}</span>); break; }
    // string
    const sm = rest.match(/^("(?:[^"\\]|\\.)*")/);
    if (sm) { tokens.push(<span key={tokens.length} style={{ color: '#86efac' }}>{sm[0]}</span>); rest = rest.slice(sm[0].length); continue; }
    // keyword
    const km = rest.match(/^(resource|variable|output|locals|module|provider|terraform|data|source|backend)\b/);
    if (km) { tokens.push(<span key={tokens.length} style={{ color: '#93c5fd' }}>{km[0]}</span>); rest = rest.slice(km[0].length); continue; }
    // number / bool
    const nm = rest.match(/^(\d[\d.]*|true|false|null)\b/);
    if (nm) { tokens.push(<span key={tokens.length} style={{ color: '#fbbf24' }}>{nm[0]}</span>); rest = rest.slice(nm[0].length); continue; }
    // identifier
    const im = rest.match(/^([a-zA-Z_][\w.-]*)/);
    if (im) { tokens.push(<span key={tokens.length} style={{ color: baseColor }}>{im[0]}</span>); rest = rest.slice(im[0].length); continue; }
    // punctuation / other
    tokens.push(<span key={tokens.length} style={{ color: '#9ca3af' }}>{rest[0]}</span>);
    rest = rest.slice(1);
  }
  return tokens;
}

// ─── Diff Viewer ──────────────────────────────────────────────────────────────
function DiffViewer({ oldHcl, newHcl, c, collapsed }) {
  const diff = useMemo(() => computeDiff(oldHcl || '', newHcl || ''), [oldHcl, newHcl]);
  const added   = diff.filter(d => d.type === 'add').length;
  const removed = diff.filter(d => d.type === 'remove').length;

  // Collapse unchanged hunks > 3 lines
  const CONTEXT = 3;
  const visibleRows = useMemo(() => {
    if (!collapsed) return diff.map((r, i) => ({ ...r, _idx: i }));
    const changed = new Set();
    diff.forEach((r, i) => { if (r.type !== 'same') { for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++) changed.add(k); } });
    const rows = [];
    let skip = 0;
    diff.forEach((r, i) => {
      if (changed.has(i)) {
        if (skip) { rows.push({ type: 'ellipsis', count: skip, _idx: i }); skip = 0; }
        rows.push({ ...r, _idx: i });
      } else { skip++; }
    });
    if (skip) rows.push({ type: 'ellipsis', count: skip, _idx: diff.length });
    return rows;
  }, [diff, collapsed]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Stats bar */}
      <div style={{
        padding: '6px 16px', background: c.bg3, borderBottom: `1px solid ${c.bd}`,
        display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: c.fg2, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, color: c.fg }}>Diff</span>
        {(added > 0 || removed > 0) ? (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700, background: 'rgba(34,197,94,0.10)', padding: '1px 7px', borderRadius: 10 }}>+{added}</span>
            <span style={{ color: '#ef4444', fontWeight: 700, background: 'rgba(239,68,68,0.10)', padding: '1px 7px', borderRadius: 10 }}>−{removed}</span>
          </>
        ) : (
          <span style={{ color: c.fg3, fontStyle: 'italic' }}>Identical to previous version</span>
        )}
        <span style={{ marginLeft: 'auto', color: c.fg3, fontSize: 11 }}>{diff.length} lines total</span>
      </div>

      {/* Line rows */}
      <div style={{ flex: 1, overflowY: 'auto', fontFamily: '"JetBrains Mono", "Fira Mono", monospace', fontSize: 11.5, lineHeight: 1.7 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 40 }} />
            <col style={{ width: 40 }} />
            <col style={{ width: 22 }} />
            <col />
          </colgroup>
          <tbody>
            {visibleRows.map((row, idx) => {
              if (row.type === 'ellipsis') return (
                <tr key={`e${idx}`} style={{ background: c.bg }}>
                  <td colSpan={4} style={{ padding: '3px 16px', color: c.fg3, fontSize: 10.5, fontStyle: 'italic', borderTop: `1px dashed ${c.bd}`, borderBottom: `1px dashed ${c.bd}` }}>
                    ···  {row.count} unchanged line{row.count > 1 ? 's' : ''} hidden
                  </td>
                </tr>
              );
              const bg =
                row.type === 'add'    ? 'rgba(34,197,94,0.09)'  :
                row.type === 'remove' ? 'rgba(239,68,68,0.09)'  :
                'transparent';
              const badge =
                row.type === 'add'    ? { ch: '+', col: '#22c55e' } :
                row.type === 'remove' ? { ch: '−', col: '#ef4444' } :
                { ch: ' ', col: c.fg3 };
              const textColor =
                row.type === 'add'    ? '#bbf7d0' :
                row.type === 'remove' ? '#fecaca' :
                c.fg;

              return (
                <tr key={row._idx} style={{ background: bg }}>
                  <td style={{ textAlign: 'right', padding: '0 8px', color: c.fg3, fontSize: 10, userSelect: 'none', borderRight: `1px solid ${c.bd}`, opacity: 0.55 }}>
                    {row.lineA || ''}
                  </td>
                  <td style={{ textAlign: 'right', padding: '0 8px', color: c.fg3, fontSize: 10, userSelect: 'none', borderRight: `1px solid ${c.bd}`, opacity: 0.55 }}>
                    {row.lineB || ''}
                  </td>
                  <td style={{ textAlign: 'center', padding: '0 3px', color: badge.col, fontWeight: 700, userSelect: 'none', borderRight: `1px solid ${c.bd}` }}>
                    {badge.ch}
                  </td>
                  <td style={{ padding: '1px 14px 1px 10px', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', color: textColor }}>
                    {row.type !== 'same' ? row.text : hclHighlight(row.text, c.fg)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {diff.length === 0 && (
          <div style={{ padding: 32, color: c.fg3, textAlign: 'center', fontSize: 13 }}>Empty file</div>
        )}
      </div>
    </div>
  );
}

// ─── Raw HCL viewer with line numbers ────────────────────────────────────────
function RawViewer({ hcl, c }) {
  const lines = (hcl || '').split('\n');
  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', fontFamily: '"JetBrains Mono", "Fira Mono", monospace', fontSize: 11.5, lineHeight: 1.7 }}>
      {/* Gutter */}
      <div style={{ padding: '8px 0', background: c.bg3, borderRight: `1px solid ${c.bd}`, userSelect: 'none', flexShrink: 0, minWidth: 44, textAlign: 'right' }}>
        {lines.map((_, i) => (
          <div key={i} style={{ padding: '0 10px', color: c.fg3, fontSize: 10.5, opacity: 0.6 }}>{i + 1}</div>
        ))}
      </div>
      {/* Code */}
      <div style={{ padding: '8px 16px', overflowX: 'auto', flex: 1 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ whiteSpace: 'pre', color: c.fg }}>{hclHighlight(line, c.fg)}</div>
        ))}
      </div>
    </div>
  );
}

// ─── Version list item ────────────────────────────────────────────────────────
function VersionItem({ v, isSelected, onClick, c }) {
  const date = new Date(v.saved_at);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const hasCheckov = v.checkov_passed != null || v.checkov_failed != null;
  const checkFailed = (v.checkov_failed || 0) > 0;

  return (
    <div
      onClick={onClick}
      style={{
        padding: '12px 14px',
        borderBottom: `1px solid ${c.bd}`,
        cursor: 'pointer',
        background: isSelected ? c.bg3 : 'transparent',
        borderLeft: `3px solid ${isSelected ? c.accent : 'transparent'}`,
        transition: 'background 0.12s',
      }}
    >
      {/* Version number + date */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: isSelected ? c.accent : c.fg }}>
          v{v.version_number}
        </span>
        <span style={{ fontSize: 10, color: c.fg3 }}>{dateStr} {timeStr}</span>
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {/* Resource count pill */}
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 8,
          background: c.bg4, color: c.fg2, fontWeight: 600,
        }}>
          {v.resource_count ?? 0} resource{v.resource_count !== 1 ? 's' : ''}
        </span>

        {/* Checkov badge */}
        {hasCheckov && (
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600,
            background: checkFailed ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
            color: checkFailed ? '#ef4444' : '#22c55e',
          }}>
            {checkFailed ? `⚠ ${v.checkov_failed} fail` : `✓ clean`}
          </span>
        )}

        {/* Cost */}
        {v.cost_estimate_usd != null && (
          <span style={{ fontSize: 10, color: c.fg3 }}>~${Number(v.cost_estimate_usd).toFixed(2)}/mo</span>
        )}
      </div>

      {/* Change summary */}
      {v.change_summary && (
        <div style={{ marginTop: 4, fontSize: 10.5, color: c.fg2, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {v.change_summary}
        </div>
      )}
    </div>
  );
}

// ─── Main History Page ────────────────────────────────────────────────────────
export default function History() {
  const { projectId: _urlProjectId } = useParams();
  const nav = useNavigate();
  const { c } = useTheme();
  const { user } = useAuth();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // If no projectId in the URL (e.g. navigated from the Navbar before a project
  // was opened), fall back to the last active project stored by the Builder.
  // Namespaced per-user (L-04 fix) so this doesn't fall back to another
  // account's last-project id on a shared browser.
  const projectId = (() => {
    if (_urlProjectId && UUID_RE.test(_urlProjectId)) return _urlProjectId;
    return getLastProjectId(user?.id);
  })();

  const [versions, setVersions]     = useState([]);
  const [project,  setProject]      = useState(null);
  const [selected, setSelected]     = useState(null);
  const [loading,  setLoading]      = useState(true);
  const [error,    setError]        = useState(null);
  const [noProject, setNoProject]   = useState(false);   // true when no projectId can be resolved
  const [viewMode, setViewMode]     = useState('diff');   // 'diff' | 'raw'
  const [collapsed, setCollapsed]   = useState(true);     // collapse unchanged diff hunks
  const [compareIdx, setCompareIdx] = useState(null);     // manual comparison index

  useEffect(() => {
    if (!projectId) {
      // No project ID available at all — prompt the user to open one first.
      setNoProject(true);
      setLoading(false);
      return;
    }
    // Redirect the browser to the canonical URL so bookmarks / refreshes work.
    if (!_urlProjectId && projectId) {
      nav(`/history/${projectId}`, { replace: true });
      return;
    }
    setNoProject(false);
    Promise.all([
      projectsAPI.get(projectId),
      projectsAPI.getVersions(projectId),
    ]).then(([p, v]) => {
      setProject(p.data);
      setVersions(v.data);
      if (v.data.length) setSelected(v.data[0]);
    }).catch(e => setError(e.response?.data?.error || 'Failed to load project history'))
      .finally(() => setLoading(false));
  }, [projectId, _urlProjectId, nav]);

  const selectedIdx = versions.findIndex(v => v.id === selected?.id);

  // Comparison target: manually chosen or auto (next older)
  const compareVersion = useMemo(() => {
    if (compareIdx !== null && compareIdx >= 0 && compareIdx < versions.length) return versions[compareIdx];
    return selectedIdx < versions.length - 1 ? versions[selectedIdx + 1] : null;
  }, [compareIdx, selectedIdx, versions]);

  const handleSelect = useCallback((v) => {
    setSelected(v);
    setCompareIdx(null); // reset manual compare on selection change
  }, []);

  const handleDownload = (v) => {
    if (!v.full_hcl) return;
    const blob = new Blob([v.full_hcl], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `v${v.version_number}.tf`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleRestoreInBuilder = (v) => {
    if (!v.full_hcl) return;
    // Store in sessionStorage for Builder to pick up
    sessionStorage.setItem(`tfgen.restore.${projectId}`, JSON.stringify({ hcl: v.full_hcl, version: v.version_number }));
    nav(`/builder/${projectId}`);
  };

  // ─── Toolbar button style helper
  const tbBtn = (active, danger = false) => ({
    fontSize: 12, padding: '5px 12px', borderRadius: 5, cursor: 'pointer', fontWeight: active ? 600 : 400,
    border: `1px solid ${active ? (danger ? '#ef4444' : c.accent) : c.bd}`,
    background: active ? (danger ? 'rgba(239,68,68,0.12)' : c.accent + '20') : 'transparent',
    color: active ? (danger ? '#ef4444' : c.accent) : c.fg2,
    transition: 'all 0.12s',
  });

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: c.bg, color: c.fg }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px',
        borderBottom: `1px solid ${c.bd}`, background: c.bg2, flexShrink: 0,
      }}>
        <button
          onClick={() => nav(`/builder/${projectId}`)}
          style={{ ...tbBtn(false), padding: '6px 14px', color: c.fg }}
        >
          ← Builder
        </button>

        <div style={{ borderLeft: `1px solid ${c.bd}`, paddingLeft: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: c.fg, lineHeight: 1.2 }}>
            📜 Version History
          </div>
          {project && (
            <div style={{ fontSize: 12, color: c.fg2, marginTop: 1 }}>{project.name}</div>
          )}
        </div>

        {/* Version count badge */}
        {versions.length > 0 && (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: c.accentSoft, color: c.accent, fontWeight: 700, marginLeft: 4,
          }}>
            {versions.length} version{versions.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.fg2, gap: 10 }}>
          <div style={{ width: 18, height: 18, border: `2px solid ${c.bd}`, borderTopColor: c.accent, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          Loading history…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : error ? (
        <div style={{ margin: 32, padding: '14px 18px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', color: '#ef4444', fontSize: 14 }}>
          ⚠ {error}
        </div>
      ) : noProject ? (
        <div style={{ margin: 48, textAlign: 'center', color: c.fg2 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No project selected</div>
          <div style={{ fontSize: 13 }}>Open a project in the Builder first, then come back here to see its version history.</div>
          <button
            onClick={() => nav('/dashboard')}
            style={{ marginTop: 20, padding: '9px 20px', borderRadius: 7, background: c.accent, color: '#fff', border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
          >
            → Go to Dashboard
          </button>
        </div>
      ) : versions.length === 0 ? (
        <div style={{ margin: 48, textAlign: 'center', color: c.fg2 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No versions saved yet</div>
          <div style={{ fontSize: 13 }}>Use <strong>Save Version</strong> in the Builder to capture snapshots.</div>
          <button
            onClick={() => nav(`/builder/${projectId}`)}
            style={{ marginTop: 20, padding: '9px 20px', borderRadius: 7, background: c.accent, color: '#fff', border: 'none', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
          >
            → Open Builder
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '270px 1fr', minHeight: 0 }}>

          {/* ── Version sidebar ─────────────────────────────────────────────── */}
          <div style={{
            background: c.bg2, borderRight: `1px solid ${c.bd}`,
            display: 'flex', flexDirection: 'column', minHeight: 0,
          }}>
            {/* Sidebar header */}
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${c.bd}`, fontSize: 11, fontWeight: 700, color: c.fg2, textTransform: 'uppercase', letterSpacing: '0.07em', flexShrink: 0 }}>
              Versions
            </div>
            {/* List */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {versions.map(v => (
                <VersionItem
                  key={v.id}
                  v={v}
                  isSelected={selected?.id === v.id}
                  onClick={() => handleSelect(v)}
                  c={c}
                />
              ))}
            </div>
          </div>

          {/* ── Right panel ─────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, background: c.bg }}>
            {selected && (
              <>
                {/* ── Content toolbar ─────────────────────────────────────── */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
                  borderBottom: `1px solid ${c.bd}`, background: c.bg2, flexShrink: 0, flexWrap: 'wrap',
                }}>
                  {/* Version badge + compare target */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>
                      v{selected.version_number}
                    </span>
                    {viewMode === 'diff' && (
                      <>
                        <span style={{ color: c.fg3, fontSize: 12 }}>vs</span>
                        <select
                          value={compareIdx !== null ? compareIdx : (selectedIdx < versions.length - 1 ? selectedIdx + 1 : '')}
                          onChange={e => setCompareIdx(e.target.value === '' ? null : Number(e.target.value))}
                          style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: `1px solid ${c.bd}`, background: c.bg3, color: c.fg, cursor: 'pointer' }}
                        >
                          {versions.length < 2 && <option value="">—</option>}
                          {versions.map((v, i) => i !== selectedIdx && (
                            <option key={v.id} value={i}>v{v.version_number}</option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>

                  {/* View mode buttons */}
                  <div style={{ display: 'flex', gap: 4 }}>
                    {compareVersion && (
                      <button style={tbBtn(viewMode === 'diff')} onClick={() => setViewMode('diff')}>⟷ Diff</button>
                    )}
                    <button style={tbBtn(viewMode === 'raw')} onClick={() => setViewMode('raw')}>≡ Raw</button>
                  </div>

                  {/* Collapse toggle (diff only) */}
                  {viewMode === 'diff' && compareVersion && (
                    <button
                      style={tbBtn(collapsed)}
                      onClick={() => setCollapsed(p => !p)}
                      title="Collapse unchanged lines"
                    >
                      {collapsed ? '⊟ Collapsed' : '⊞ Expanded'}
                    </button>
                  )}

                  {/* Action buttons (right-aligned) */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => handleRestoreInBuilder(selected)}
                      disabled={!selected.full_hcl}
                      style={{
                        fontSize: 12, padding: '5px 12px', borderRadius: 5, cursor: selected.full_hcl ? 'pointer' : 'not-allowed',
                        border: `1px solid ${c.bd}`, background: c.bg3, color: selected.full_hcl ? c.fg : c.fg3,
                      }}
                      title="Load this version into the Builder"
                    >
                      ↩ Restore
                    </button>
                    <button
                      onClick={() => handleDownload(selected)}
                      disabled={!selected.full_hcl}
                      style={{
                        fontSize: 12, padding: '5px 12px', borderRadius: 5, fontWeight: 600,
                        cursor: selected.full_hcl ? 'pointer' : 'not-allowed',
                        background: selected.full_hcl ? c.accent : c.bg3,
                        color: selected.full_hcl ? '#fff' : c.fg3,
                        border: 'none',
                      }}
                    >
                      ↓ Download
                    </button>
                  </div>
                </div>

                {/* ── Content area ─────────────────────────────────────────── */}
                {!selected.full_hcl ? (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.fg3, fontSize: 13, flexDirection: 'column', gap: 8 }}>
                    <div style={{ fontSize: 28 }}>📄</div>
                    <div>No HCL content stored for this version.</div>
                    <div style={{ fontSize: 11, color: c.fg3, opacity: 0.7 }}>Older versions saved before v11 may be missing content.</div>
                  </div>
                ) : viewMode === 'diff' && compareVersion ? (
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <DiffViewer
                      oldHcl={compareVersion.full_hcl}
                      newHcl={selected.full_hcl}
                      c={c}
                      collapsed={collapsed}
                    />
                  </div>
                ) : (
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <RawViewer hcl={selected.full_hcl} c={c} />
                  </div>
                )}
              </>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
