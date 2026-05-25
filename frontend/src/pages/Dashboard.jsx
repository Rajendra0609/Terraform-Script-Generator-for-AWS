import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { projectsAPI } from '../api/client';
import { AWS_REGIONS } from '../utils/awsRegions';

export default function Dashboard() {
  const { user } = useAuth();
  const { c } = useTheme();
  const nav = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRegion, setNewRegion] = useState('ap-south-1');
  const [newEnv, setNewEnv] = useState('dev');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    projectsAPI.list().then(r => setProjects(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const createProject = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const r = await projectsAPI.create({ name: newName.trim(), aws_region: newRegion, environment: newEnv });
      const newId = r.data?.id;
      if (!newId) {
        console.error('[Dashboard] Project created but response contained no id:', r.data);
        setCreating(false);
        return;
      }
      nav(`/builder/${newId}`);
    } catch { setCreating(false); }
  };

  const deleteProject = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    setDeleting(id);
    try {
      await projectsAPI.delete(id);
      setProjects(prev => prev.filter(p => p.id !== id));
    } catch { } finally { setDeleting(null); }
  };

  const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));

  const ENV_COLORS = { prod: '#DC2626', staging: '#D97706', dev: '#059669', test: '#2563EB' };
  const ENV_BG     = { prod: '#FEF2F2', staging: '#FFFBEB', dev: '#F0FDF4', test: '#EFF6FF' };
  const ENV_BD     = { prod: '#FECACA', staging: '#FDE68A', dev: '#BBF7D0', test: '#BFDBFE' };

  const REGIONS = Object.entries(AWS_REGIONS).sort(([a], [b]) => {
    if (a === 'ap-south-1') return -1;
    if (b === 'ap-south-1') return 1;
    return a.localeCompare(b);
  });

  const STAT_BG = ['#F0FDF4', '#EFF6FF', '#F5F3FF', '#FFFBEB'];
  const STAT_BD = ['#BBF7D0', '#BFDBFE', '#DDD6FE', '#FDE68A'];
  const stats = [
    { label: 'Projects', value: projects.length, icon: '*', color: '#059669', bg: STAT_BG[0], bd: STAT_BD[0] },
    { label: 'Resources', value: projects.reduce((a, p) => a + (parseInt(p.resource_count) || 0), 0), icon: '📦', color: '#2563EB', bg: STAT_BG[1], bd: STAT_BD[1] },
    { label: 'Regions', value: new Set(projects.map(p => p.aws_region)).size, icon: '🌐', color: '#7C3AED', bg: STAT_BG[2], bd: STAT_BD[2] },
    { label: 'Team', value: user?.role || 'editor', icon: '👤', color: '#D97706', bg: STAT_BG[3], bd: STAT_BD[3], isText: true },
  ];

  /* -- Shared form-input style -- */
  const formInput = {
    width: '100%', background: '#FFFFFF', border: '1px solid #D1D5DB',
    borderRadius: 8, padding: '9px 12px', color: '#111827', fontSize: 13,
    outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  return (
    <div style={{ height: 'calc(100vh - 52px)', background: '#F7F9FC', overflow: 'auto', color: '#111827' }}>

      {/* --- Hero section --- */}
      <div style={{
        background: 'linear-gradient(135deg, #FFFFFF 0%, #F0F4FB 70%)',
        borderBottom: '1px solid #E5E7EB', padding: '36px 48px 28px',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Subtle decorative gradient */}
        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '40%', background: 'radial-gradient(ellipse at 80% 50%, rgba(0,168,124,0.06) 0%, transparent 60%)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 960 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: '#059669', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 6 }}>
                Welcome back, {user?.email?.split('@')[0]}
              </div>
              <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827', letterSpacing: '-0.04em', marginBottom: 6 }}>
                Terraform Projects
              </h1>
              <p style={{ fontSize: 14, color: '#6B7280', lineHeight: 1.6, margin: 0 }}>
                Build, validate and export production-ready AWS infrastructure as code.
              </p>
            </div>

            <button onClick={() => setShowForm(true)}
              aria-label="Create new project"
              style={{
                padding: '11px 24px', borderRadius: 10, border: 'none',
                background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
                color: '#FFFFFF', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
                boxShadow: '0 4px 14px rgba(0,168,124,0.20)', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(0,168,124,0.30)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,168,124,0.20)'; }}>
              + New Project
            </button>
          </div>

          {/* Stats row */}
          <div style={{ display: 'flex', gap: 14, marginTop: 28, flexWrap: 'wrap' }}>
            {stats.map((s, i) => (
              <div key={i} style={{
                background: '#FFFFFF', border: `1px solid ${s.bd}`,
                borderRadius: 12, padding: '16px 20px',
                display: 'flex', alignItems: 'center', gap: 14, flex: '1 1 180px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.04)', transition: 'box-shadow 0.15s, transform 0.15s',
              }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.08)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)'; e.currentTarget.style.transform = 'none'; }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: s.bg, border: `1px solid ${s.bd}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, flexShrink: 0,
                }}>{s.icon}</div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: s.color, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
                    {s.isText ? s.value : s.value || 0}
                  </div>
                  <div style={{ fontSize: 11, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* --- Content area --- */}
      <div style={{ padding: '28px 48px', maxWidth: 1200, margin: '0 auto' }}>

        {/* Search bar */}
        <div style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9CA3AF', fontSize: 15 }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search projects by name…"
              aria-label="Search projects"
              style={{
                width: '100%', background: '#FFFFFF', border: '1px solid #D1D5DB',
                borderRadius: 10, padding: '10px 12px 10px 38px', color: '#111827',
                fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
              }}
              onFocus={e => { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; }}
              onBlur={e => { e.target.style.borderColor = '#D1D5DB'; e.target.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)'; }}
            />
          </div>
          <div style={{ fontSize: 13, color: '#6B7280', fontWeight: 500, flexShrink: 0 }}>
            {filtered.length} of {projects.length} projects
          </div>
        </div>

        {/* Create project form */}
        {showForm && (
          <div style={{
            background: '#FFFFFF', border: '1px solid #BBF7D0',
            borderRadius: 14, padding: 24, marginBottom: 24,
            boxShadow: '0 4px 16px rgba(0,168,124,0.08)',
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#059669', fontSize: 18 }}>+</span> New Project
            </div>
            <form onSubmit={createProject} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto', gap: 12, alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Project Name *</label>
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="my-aws-infra" required
                  style={formInput}
                  onFocus={e => { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; }}
                  onBlur={e => { e.target.style.borderColor = '#D1D5DB'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>AWS Region</label>
                <select value={newRegion} onChange={e => setNewRegion(e.target.value)}
                  style={{ ...formInput, appearance: 'auto' }}>
                  {REGIONS.map(([value, label]) => <option key={value} value={value}>{label} ({value})</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Environment</label>
                <select value={newEnv} onChange={e => setNewEnv(e.target.value)}
                  style={{ ...formInput, appearance: 'auto' }}>
                  {['dev','staging','prod','test'].map(e => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
              <button type="submit" disabled={creating || !newName.trim()}
                style={{
                  padding: '9px 20px', borderRadius: 8, border: 'none',
                  background: 'linear-gradient(135deg, #00A87C, #2563EB)',
                  color: '#FFFFFF', fontWeight: 700, fontSize: 13,
                  cursor: creating ? 'wait' : 'pointer',
                  opacity: !newName.trim() ? 0.5 : 1,
                  transition: 'opacity 0.15s',
                }}>
                {creating ? '⏳' : '→ Create'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #D1D5DB', background: '#FFFFFF', color: '#6B7280', fontSize: 13, cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#F3F4F6'}
                onMouseLeave={e => e.currentTarget.style.background = '#FFFFFF'}>
                ✕
              </button>
            </form>
          </div>
        )}

        {/* Projects grid */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {[1,2,3].map(i => (
              <div key={i} style={{
                height: 170, borderRadius: 14,
                background: 'linear-gradient(90deg, #F0F4FB 25%, #E4EAF6 50%, #F0F4FB 75%)',
                backgroundSize: '200% 100%', animation: 'shimmer 1.6s infinite',
              }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 20px' }}>
            <div style={{ fontSize: 52, marginBottom: 16, opacity: 0.25 }}>*</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 8 }}>
              {search ? 'No projects match your search' : 'No projects yet'}
            </div>
            <div style={{ fontSize: 14, color: '#6B7280', marginBottom: 24, lineHeight: 1.5 }}>
              {search ? 'Try a different search term.' : 'Create your first project to start building AWS infrastructure.'}
            </div>
            {!search && (
              <button onClick={() => setShowForm(true)}
                style={{
                  padding: '11px 28px', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(135deg, #00A87C, #2563EB)',
                  color: '#FFFFFF', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  boxShadow: '0 4px 14px rgba(0,168,124,0.18)',
                }}>
                + Create First Project
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {filtered.map(p => {
              const envColor = ENV_COLORS[p.environment] || '#6B7280';
              const envBg = ENV_BG[p.environment] || '#F3F4F6';
              const envBd = ENV_BD[p.environment] || '#D1D5DB';
              return (
                <div key={p.id}
                  onClick={() => nav(`/builder/${p.id}`)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open project ${p.name}`}
                  onKeyDown={e => { if (e.key === 'Enter') nav(`/builder/${p.id}`); }}
                  style={{
                    background: '#FFFFFF', border: '1px solid #E5E7EB',
                    borderRadius: 14, padding: '22px', cursor: 'pointer',
                    transition: 'all 0.18s', display: 'flex', flexDirection: 'column',
                    gap: 14, position: 'relative', overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#00A87C';
                    e.currentTarget.style.transform = 'translateY(-3px)';
                    e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,168,124,0.15)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = '#E5E7EB';
                    e.currentTarget.style.transform = 'none';
                    e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)';
                  }}>

                  {/* Top accent line */}
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg, #00A87C, #2563EB)', borderRadius: '14px 14px 0 0' }} />

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 99,
                          background: '#F3F4F6', border: '1px solid #E5E7EB',
                          color: '#4B5563', fontWeight: 600,
                        }}>🌐 {p.aws_region}</span>
                        <span style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 99,
                          background: envBg, border: `1px solid ${envBd}`,
                          color: envColor, fontWeight: 700, textTransform: 'capitalize',
                        }}>{p.environment}</span>
                      </div>
                    </div>

                    <button onClick={e => deleteProject(p.id, e)} disabled={deleting === p.id}
                      aria-label={`Delete project ${p.name}`}
                      style={{
                        width: 30, height: 30, borderRadius: 7,
                        border: '1px solid transparent', background: 'transparent',
                        cursor: 'pointer', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', color: '#9CA3AF', fontSize: 14,
                        flexShrink: 0, transition: 'all 0.12s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.borderColor = '#FECACA'; e.currentTarget.style.color = '#DC2626'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = '#9CA3AF'; }}>
                      {deleting === p.id ? '⏳' : '🗑'}
                    </button>
                  </div>

                  {/* Resource count bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, height: 4, background: '#F3F4F6', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min((parseInt(p.resource_count)||0) / 20 * 100, 100)}%`,
                        height: '100%', background: 'linear-gradient(90deg, #00A87C, #2563EB)',
                        borderRadius: 99, transition: 'width 0.4s ease',
                      }} />
                    </div>
                    <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {p.resource_count || 0} resources
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: '#9CA3AF', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>🕐</span>
                    <span>Updated {new Date(p.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                </div>
              );
            })}

            {/* New project card */}
            <div onClick={() => setShowForm(true)}
              tabIndex={0}
              role="button"
              aria-label="Create new project"
              onKeyDown={e => { if (e.key === 'Enter') setShowForm(true); }}
              style={{
                background: '#FAFBFC', border: '2px dashed #D1D5DB',
                borderRadius: 14, padding: 20, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: 12, minHeight: 140,
                transition: 'all 0.18s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#00A87C'; e.currentTarget.style.background = '#F0FDF4'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#D1D5DB'; e.currentTarget.style.background = '#FAFBFC'; }}>
              <div style={{
                width: 46, height: 46, borderRadius: 12,
                border: '2px dashed #D1D5DB', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 24, color: '#9CA3AF', transition: 'all 0.15s',
              }}>+</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7280' }}>New Project</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
