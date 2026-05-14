import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsAPI } from '../api/client';
import { AWS_REGIONS, getAwsRegionLabel } from '../utils/awsRegions';


export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', aws_region: 'ap-south-1', environment: 'dev' });
  const [error, setError] = useState('');
  const nav = useNavigate();

  const load = async () => {
    try {
      setLoading(true);
      const res = await projectsAPI.list();
      setProjects(res.data);
      setError('');
    } catch (e) {
      if (e.code === 'ERR_NETWORK' || e.code === 'ECONNREFUSED' || !e.response) {
        setError(
          `Cannot reach backend at ${process.env.REACT_APP_API_URL || 'http://localhost:4000'}. ` +
          `Make sure the backend is running (cd backend && npm start).`
        );
      } else {
        setError(`Backend error ${e.response?.status}: ${e.response?.data?.error || e.message}`);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    try {
      const res = await projectsAPI.create(form);
      nav(`/builder/${res.data.id}`);
    } catch (e) { setError('Failed to create project'); }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this project and all its resources?')) return;
    await projectsAPI.delete(id);
    load();
  };

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: '#E6EDF3' }}>Projects</h1>
          <div style={{ fontSize: 14, color: '#8B949E', marginTop: 4 }}>
            Manage your Terraform AWS configurations
          </div>
        </div>
        <button onClick={() => setCreating(true)} style={{
          background: '#7B42BC', color: '#fff', border: 'none', borderRadius: 8,
          padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8
        }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> New Project
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: '#2A1212', border: '1px solid #F8514944', borderRadius: 8, color: '#F85149', fontSize: 13, marginBottom: 24 }}>
          {error}
        </div>
      )}

      {/* Create Modal */}
      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="fade-in" style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, padding: 32, width: 480 }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 700 }}>Create New Project</h3>
            {[
              { label: 'Project Name *', key: 'name', type: 'text', placeholder: 'e.g. prod-vpc-setup' },
              { label: 'Description', key: 'description', type: 'text', placeholder: 'Optional description' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#8B949E', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</label>
                <input type="text" value={form[f.key]} placeholder={f.placeholder}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  style={{ width: '100%', background: '#0D1117', border: '1px solid #30363D', borderRadius: 6, color: '#E6EDF3', padding: '8px 12px', fontSize: 13, outline: 'none', fontFamily: 'Outfit, sans-serif' }}
                />
              </div>
            ))}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8B949E', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Environment</label>
              <select value={form.environment} onChange={e => setForm(p => ({ ...p, environment: e.target.value }))}
                style={{ width: '100%', background: '#0D1117', border: '1px solid #30363D', borderRadius: 6, color: '#E6EDF3', padding: '8px 12px', fontSize: 13, outline: 'none' }}>
                <option value="dev">Development</option>
                <option value="test">Testing</option>
                <option value="prod">Production</option>
              </select>
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8B949E', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>AWS Region</label>
              <select value={form.aws_region} onChange={e => setForm(p => ({ ...p, aws_region: e.target.value }))}
                style={{ width: '100%', background: '#0D1117', border: '1px solid #30363D', borderRadius: 6, color: '#E6EDF3', padding: '8px 12px', fontSize: 13, outline: 'none' }}>
                {Object.entries(AWS_REGIONS).map(([val, lbl]) => (
                  <option key={val} value={val}>{lbl} ({val})</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleCreate} style={{ flex: 1, background: '#7B42BC', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Create & Open
              </button>
              <button onClick={() => setCreating(false)} style={{ flex: 1, background: '#21262D', color: '#E6EDF3', border: '1px solid #30363D', borderRadius: 8, padding: '10px 0', fontSize: 14, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Grid */}
      {loading ? (
        <div style={{ color: '#8B949E', fontSize: 14 }}>Loading projects...</div>
      ) : projects.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#8B949E' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#E6EDF3', marginBottom: 8 }}>No projects yet</div>
          <div style={{ fontSize: 13 }}>Create your first Terraform project to get started</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {projects.map(p => (
            <div key={p.id} onClick={() => nav(`/builder/${p.id}`)}
              style={{ background: '#161B22', border: '1px solid #30363D', borderRadius: 12, padding: 20, cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#7B42BC'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#30363D'; e.currentTarget.style.transform = 'none'; }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ width: 40, height: 40, background: 'linear-gradient(135deg, #7B42BC22, #5325A022)', border: '1px solid #7B42BC44', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>
                  📁
                </div>
                <button onClick={e => handleDelete(p.id, e)} style={{
                  background: 'transparent', border: '1px solid #30363D', borderRadius: 6,
                  color: '#8B949E', padding: '4px 8px', fontSize: 12, cursor: 'pointer'
                }}>Delete</button>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#E6EDF3', marginBottom: 4 }}>{p.name}</div>
              {p.description && <div style={{ fontSize: 13, color: '#8B949E', marginBottom: 12 }}>{p.description}</div>}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: '#38BDF8', background: '#0c1f30', padding: '3px 8px', borderRadius: 4 }}>
                  {getAwsRegionLabel(p.aws_region)}
                </span>
                <span style={{ fontSize: 11, color: '#8B949E', background: '#21262D', padding: '3px 8px', borderRadius: 4 }}>
                  {p.resource_count || 0} resources
                </span>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: '#484F58' }}>
                Updated {new Date(p.updated_at).toLocaleDateString()}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={e => { e.stopPropagation(); nav(`/builder/${p.id}`); }} style={{ flex: 1, background: '#7B42BC', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Open Builder
                </button>
                <button onClick={e => { e.stopPropagation(); nav(`/history/${p.id}`); }} style={{ background: '#21262D', color: '#8B949E', border: '1px solid #30363D', borderRadius: 6, padding: '8px 12px', fontSize: 13, cursor: 'pointer' }}>
                  History
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
