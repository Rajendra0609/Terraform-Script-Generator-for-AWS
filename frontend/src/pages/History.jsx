import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectsAPI } from '../api/client';

export default function History() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const [versions, setVersions] = useState([]);
  const [project, setProject] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      projectsAPI.get(projectId),
      projectsAPI.getVersions(projectId)
    ]).then(([p, v]) => {
      setProject(p.data);
      setVersions(v.data);
      if (v.data.length) setSelected(v.data[0]);
    }).finally(() => setLoading(false));
  }, [projectId]);

  const handleDownload = (v) => {
    const blob = new Blob([v.full_hcl], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `v${v.version_number}.tf`;
    a.click();
  };

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
        <button onClick={() => nav(`/builder/${projectId}`)} style={{ background: '#21262D', border: '1px solid #30363D', borderRadius: 7, color: '#E6EDF3', padding: '8px 14px', cursor: 'pointer', fontSize: 13 }}>
          ← Back to Builder
        </button>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Version History</h1>
          <div style={{ fontSize: 13, color: '#8B949E' }}>{project?.name}</div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: '#8B949E' }}>Loading...</div>
      ) : versions.length === 0 ? (
        <div style={{ color: '#8B949E', fontSize: 14 }}>No saved versions yet. Use "Save" in the Builder to create versions.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, height: 'calc(100vh - 200px)' }}>
          {/* Version list */}
          <div style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 10, overflow: 'auto' }}>
            {versions.map(v => (
              <div key={v.id} onClick={() => setSelected(v)}
                style={{ padding: '14px 16px', borderBottom: '1px solid #30363D', cursor: 'pointer',
                  background: selected?.id === v.id ? '#21262D' : 'transparent',
                  borderLeft: `3px solid ${selected?.id === v.id ? '#7B42BC' : 'transparent'}`
                }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#E6EDF3', marginBottom: 4 }}>
                  Version {v.version_number}
                </div>
                <div style={{ fontSize: 11, color: '#8B949E' }}>
                  {new Date(v.saved_at).toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: '#8B949E', marginTop: 2 }}>
                  {v.resource_count} resources
                </div>
              </div>
            ))}
          </div>

          {/* HCL preview */}
          <div style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {selected && (
              <>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #30363D', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#E6EDF3' }}>Version {selected.version_number} — main.tf</span>
                  <button onClick={() => handleDownload(selected)} style={{ background: '#7B42BC', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    Download
                  </button>
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                  <pre style={{ margin: 0, color: '#E6EDF3', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                    {selected.full_hcl}
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
