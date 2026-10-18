import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { useNavigate } from 'react-router-dom';
import API from '../api/client';

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
function Badge({ color, children }) {
  const colors = {
    green:  { bg: '#F0FDF4', border: '#A7F3D0', text: '#065F46' },
    red:    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
    yellow: { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E' },
    blue:   { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
    purple: { bg: '#F5F3FF', border: '#DDD6FE', text: '#5B21B6' },
    gray:   { bg: '#F9FAFB', border: '#E5E7EB', text: '#374151' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{
      background: c.bg, border: `1px solid ${c.border}`, color: c.text,
      padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
    }}>{children}</span>
  );
}

function Stat({ label, value, color = '#2563EB', sub }) {
  return (
    <div style={{ padding: '16px 20px', background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 10, minWidth: 130 }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Btn({ onClick, children, variant = 'default', disabled, loading }) {
  const vs = {
    default: { bg: '#F3F4F6', border: '#D1D5DB', color: '#374151' },
    primary: { bg: '#2563EB', border: '#2563EB', color: '#FFFFFF' },
    danger:  { bg: '#EF4444', border: '#EF4444', color: '#FFFFFF' },
    success: { bg: '#10B981', border: '#10B981', color: '#FFFFFF' },
  };
  const v = vs[variant] || vs.default;
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: '7px 14px', borderRadius: 7, border: `1px solid ${v.border}`,
        background: disabled || loading ? '#E5E7EB' : v.bg,
        color: disabled || loading ? '#9CA3AF' : v.color,
        fontSize: 12, fontWeight: 600, cursor: disabled || loading ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}
    >{loading ? '…' : children}</button>
  );
}

const ROLE_COLORS = { admin: 'red', deployer: 'purple', editor: 'blue', user: 'green', viewer: 'gray' };

// ─── Main AdminPanel ──────────────────────────────────────────────────────────
export default function AdminPanel() {
  const { user } = useAuth();
  useTheme();
  const nav      = useNavigate();
  const [tab, setTab] = useState('metrics');

  // Guard: must be admin
  useEffect(() => {
    if (user && user.role !== 'admin') nav('/dashboard');
  }, [user, nav]);

  const tabs = [
    { id: 'metrics',  label: '📊 Metrics' },
    { id: 'users',    label: '👥 Users' },
    { id: 'projects', label: '📁 Projects' },
    { id: 'policies', label: '🛡 Policies' },
    { id: 'audit',    label: '📜 Audit Log' },
    { id: 'system',   label: '⚙️ System' },
  ];

  return (
    <div style={{ minHeight: 'calc(100vh - 52px)', background: '#F7F9FC', color: '#111827' }}>
      {/* Header */}
      <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E5E7EB', padding: '20px 32px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>🛠 Admin Panel</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6B7280' }}>
          Platform management — users, policies, system health
        </p>
      </div>

      {/* Tab bar */}
      <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E5E7EB', padding: '0 32px', display: 'flex', gap: 4 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '10px 16px', border: 'none', borderBottom: tab === t.id ? '2px solid #2563EB' : '2px solid transparent',
            background: 'transparent', color: tab === t.id ? '#2563EB' : '#6B7280',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400, cursor: 'pointer',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
        {tab === 'metrics'  && <MetricsTab />}
        {tab === 'users'    && <UsersTab />}
        {tab === 'projects' && <ProjectsTab />}
        {tab === 'policies' && <PoliciesTab />}
        {tab === 'audit'    && <AuditTab />}
        {tab === 'system'   && <SystemTab />}
      </div>
    </div>
  );
}

// ─── Metrics Tab ──────────────────────────────────────────────────────────────
function MetricsTab() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.get('/api/admin/metrics')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading metrics…</p>;
  if (!data)   return <p style={{ color: '#EF4444', fontSize: 13 }}>Failed to load metrics</p>;

  const { users, projects, resources, execution, audit_24h, policies, change_requests, top_services } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Row 1: user + project stats */}
      <Section title="Platform Overview">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Stat label="Total Users"   value={users?.total}      color="#2563EB" sub={`${users?.new_this_week} new this week`} />
          <Stat label="Admins"        value={users?.admins}     color="#DC2626" />
          <Stat label="Deployers"     value={users?.deployers}  color="#7C3AED" />
          <Stat label="Total Projects" value={projects?.total}  color="#059669" sub={`${projects?.active_this_week} active this week`} />
          <Stat label="AWS Regions"   value={projects?.regions} color="#0284C7" />
          <Stat label="Total Resources" value={resources?.total} color="#D97706" sub={`${resources?.unique_types} service types`} />
        </div>
      </Section>

      {/* Row 2: execution stats */}
      <Section title="Execution Jobs">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Stat label="Total Jobs"   value={execution?.total}     />
          <Stat label="Plans"        value={execution?.plans}     color="#0284C7" />
          <Stat label="Applies"      value={execution?.applies}   color="#7C3AED" />
          <Stat label="Succeeded"    value={execution?.succeeded} color="#059669" />
          <Stat label="Failed"       value={execution?.failed}    color="#DC2626" />
          <Stat label="Running"      value={execution?.running}   color="#D97706" />
          <Stat label="Last 24h"     value={execution?.last_24h}  color="#6B7280" />
          <Stat label="Audit (24h)"  value={audit_24h}            color="#64748B" />
        </div>
      </Section>

      {/* Row 3: governance */}
      <Section title="Governance & Collaboration">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Stat label="Total Policies"  value={policies?.total}   color="#2563EB" sub={`${policies?.enabled} enabled`} />
          <Stat label="Open CRs"        value={change_requests?.open}     color="#D97706" />
          <Stat label="Approved CRs"    value={change_requests?.approved} color="#059669" />
          <Stat label="Total CRs"       value={change_requests?.total}    color="#374151" />
        </div>
      </Section>

      {/* Top services chart */}
      {top_services?.length > 0 && (
        <Section title="Top AWS Services">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
            {top_services.map((s, i) => {
              const max = top_services[0]?.count || 1;
              const pct = Math.round((s.count / max) * 100);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 140, fontSize: 12, color: '#374151', fontFamily: 'monospace' }}>
                    {s.service_type}
                  </div>
                  <div style={{ flex: 1, background: '#E5E7EB', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: '#2563EB', borderRadius: 4 }} />
                  </div>
                  <div style={{ width: 30, fontSize: 12, color: '#6B7280', textAlign: 'right' }}>{s.count}</div>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [actionUser, setActionUser] = useState(null);
  const [newRole, setNewRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: 50, offset: 0 });
    if (search) params.set('search', search);
    if (roleFilter) params.set('role', roleFilter);
    API.get(`/api/admin/users?${params}`)
      .then(r => { setUsers(r.data.users || []); setTotal(r.data.total || 0); })
      .catch(() => setError('Failed to load users'))
      .finally(() => setLoading(false));
  }, [search, roleFilter]);

  useEffect(() => { load(); }, [load]);

  const changeRole = async () => {
    if (!actionUser || !newRole) return;
    setSaving(true);
    try {
      await API.put(`/api/admin/users/${actionUser.id}/role`, { role: newRole });
      setActionUser(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to change role');
    } finally { setSaving(false); }
  };

  const deleteUser = async (u) => {
    if (!window.confirm(`Delete user "${u.email}"? This removes all their projects and data.`)) return;
    try {
      await API.delete(`/api/admin/users/${u.id}`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete user');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          placeholder="Search by email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 12px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, width: 240 }}
        />
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13 }}>
          <option value="">All roles</option>
          {['admin','deployer','editor','user','viewer'].map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#6B7280' }}>{total} users</span>
      </div>

      {error && <div style={{ color: '#DC2626', fontSize: 13 }}>{error}</div>}

      {/* Role change modal */}
      {actionUser && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: '#FFFFFF', borderRadius: 12, padding: 24, width: 360 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Change Role</h3>
            <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 16px' }}>{actionUser.email}</p>
            <select value={newRole} onChange={e => setNewRole(e.target.value)}
              style={{ width: '100%', padding: '8px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, marginBottom: 16 }}>
              <option value="">Select role…</option>
              {['admin','deployer','editor','user','viewer'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setActionUser(null)}>Cancel</Btn>
              <Btn variant="primary" onClick={changeRole} loading={saving} disabled={!newRole}>Save</Btn>
            </div>
          </div>
        </div>
      )}

      {loading ? <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading…</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #E5E7EB' }}>
              {['Email','Role','Projects','Last Active','Actions'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ fontWeight: 500 }}>{u.email}</div>
                  <div style={{ fontSize: 11, color: '#9CA3AF' }}>
                    Joined {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <Badge color={ROLE_COLORS[u.role] || 'gray'}>{u.role}</Badge>
                </td>
                <td style={{ padding: '10px 12px', color: '#374151' }}>{u.project_count}</td>
                <td style={{ padding: '10px 12px', color: '#9CA3AF', fontSize: 12 }}>
                  {u.last_active ? new Date(u.last_active).toLocaleDateString() : 'Never'}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn onClick={() => { setActionUser(u); setNewRole(u.role); }}>Role</Btn>
                    <Btn variant="danger" onClick={() => deleteUser(u)}>Delete</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Projects Tab ──────────────────────────────────────────────────────────────
function ProjectsTab() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: 100 });
    if (search) params.set('search', search);
    API.get(`/api/admin/projects?${params}`)
      .then(r => setProjects(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [search]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <input
        placeholder="Search projects…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ padding: '7px 12px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, width: 280 }}
      />
      {loading ? <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading…</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #E5E7EB' }}>
              {['Name','Owner','Region','Env','Resources','Updated'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
                <td style={{ padding: '10px 12px', fontWeight: 500 }}>{p.name}</td>
                <td style={{ padding: '10px 12px', color: '#6B7280', fontSize: 12 }}>{p.owner_email}</td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12 }}>{p.aws_region}</td>
                <td style={{ padding: '10px 12px' }}>
                  <Badge color={{ prod: 'red', staging: 'yellow', dev: 'green' }[p.environment] || 'gray'}>
                    {p.environment}
                  </Badge>
                </td>
                <td style={{ padding: '10px 12px', color: '#374151' }}>{p.resource_count}</td>
                <td style={{ padding: '10px 12px', color: '#9CA3AF', fontSize: 12 }}>
                  {new Date(p.updated_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Policies Tab ─────────────────────────────────────────────────────────────
function PoliciesTab() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editPolicy, setEditPolicy] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    API.get('/api/policies')
      .then(r => setPolicies(r.data || []))
      .catch(() => setError('Failed to load policies'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggle = async (p) => {
    try {
      await API.post(`/api/policies/${p.id}/toggle`);
      load();
    } catch (e) { setError(e.response?.data?.error || 'Toggle failed'); }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete policy "${p.name}"?`)) return;
    try {
      await API.delete(`/api/policies/${p.id}`);
      load();
    } catch (e) { setError(e.response?.data?.error || 'Delete failed'); }
  };

  const seedTemplates = async () => {
    setSeeding(true);
    try {
      const r = await API.post('/api/policies/seed-templates');
      alert(`Seeded ${r.data.created} built-in policies (${r.data.skipped} already existed)`);
      load();
    } catch (e) { setError(e.response?.data?.error || 'Seed failed'); }
    finally { setSeeding(false); }
  };

  const SEV_COLORS = { CRITICAL: 'red', HIGH: 'yellow', MEDIUM: 'blue', LOW: 'gray' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn variant="primary" onClick={() => { setEditPolicy(null); setShowForm(true); }}>+ New Policy</Btn>
        <Btn onClick={seedTemplates} loading={seeding}>🌱 Seed Built-in Templates</Btn>
      </div>

      {error && <div style={{ color: '#DC2626', fontSize: 13 }}>{error}</div>}

      {showForm && (
        <PolicyForm
          policy={editPolicy}
          onSave={() => { setShowForm(false); setEditPolicy(null); load(); }}
          onCancel={() => { setShowForm(false); setEditPolicy(null); }}
        />
      )}

      {loading ? <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading…</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {policies.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
              No policies yet. Click "Seed Built-in Templates" to get started.
            </div>
          )}
          {policies.map(p => (
            <div key={p.id} style={{
              background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 10,
              padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 14,
              opacity: p.enabled ? 1 : 0.6,
            }}>
              {/* Toggle */}
              <div
                onClick={() => toggle(p)}
                style={{
                  width: 36, height: 20, borderRadius: 10, background: p.enabled ? '#10B981' : '#D1D5DB',
                  cursor: 'pointer', position: 'relative', flexShrink: 0, marginTop: 2,
                }}
              >
                <div style={{
                  position: 'absolute', top: 2, left: p.enabled ? 18 : 2,
                  width: 16, height: 16, borderRadius: '50%', background: '#FFFFFF',
                  transition: 'left 0.15s',
                }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                  <Badge color={SEV_COLORS[p.severity] || 'gray'}>{p.severity}</Badge>
                  {p.blocks_plan && <Badge color="red">🚫 BLOCKS PLAN</Badge>}
                  {!p.enabled && <Badge color="gray">Disabled</Badge>}
                </div>
                {p.description && (
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{p.description}</div>
                )}
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
                  By {p.created_by_email || 'system'} · {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <Btn onClick={() => { setEditPolicy(p); setShowForm(true); }}>Edit</Btn>
                <Btn variant="danger" onClick={() => remove(p)}>Delete</Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PolicyForm({ policy, onSave, onCancel }) {
  const [name,        setName]       = useState(policy?.name        || '');
  const [description, setDesc]       = useState(policy?.description || '');
  const [rego,        setRego]       = useState(policy?.rego_source  || DEFAULT_REGO);
  const [severity,    setSeverity]   = useState(policy?.severity     || 'HIGH');
  const [blocksP,     setBlocksP]    = useState(policy?.blocks_plan  || false);
  const [saving,      setSaving]     = useState(false);
  const [error,       setError]      = useState('');

  const save = async () => {
    if (!name.trim() || !rego.trim()) { setError('Name and Rego source are required'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { name, description, rego_source: rego, severity, blocks_plan: blocksP };
      if (policy?.id) {
        await API.put(`/api/policies/${policy.id}`, body);
      } else {
        await API.post('/api/policies', body);
      }
      onSave();
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const inp = { width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' };

  return (
    <div style={{ background: '#F0F4FF', border: '1px solid #C7D7FE', borderRadius: 10, padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>{policy?.id ? 'Edit Policy' : 'New Policy'}</h3>
      {error && <div style={{ color: '#DC2626', fontSize: 12, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
            Policy Name *
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="No public S3 buckets" style={inp} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
            Severity
          </label>
          <select value={severity} onChange={e => setSeverity(e.target.value)} style={inp}>
            {['CRITICAL','HIGH','MEDIUM','LOW'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
          Description
        </label>
        <input value={description} onChange={e => setDesc(e.target.value)} placeholder="What does this policy enforce?" style={inp} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
          Rego Policy Source *
        </label>
        <textarea
          value={rego}
          onChange={e => setRego(e.target.value)}
          rows={10}
          style={{ ...inp, fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: 12, resize: 'vertical' }}
        />
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16, cursor: 'pointer' }}>
        <input type="checkbox" checked={blocksP} onChange={e => setBlocksP(e.target.checked)} />
        <span>🚫 Block plan execution when this policy is violated</span>
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn variant="primary" onClick={save} loading={saving}>
          {policy?.id ? 'Update Policy' : 'Create Policy'}
        </Btn>
      </div>
    </div>
  );
}

const DEFAULT_REGO = `package tfgen

# deny[msg] fires for each violation.
# The plan is blocked (if blocks_plan=true) when any deny fires.

deny[msg] {
  rc := input.plan.resource_changes[_]
  rc.type == "aws_s3_bucket"
  rc.change.after.acl == "public-read"
  msg := "S3 bucket must not use public-read ACL"
}
`;

// ─── System Tab ───────────────────────────────────────────────────────────────
// ─── Audit Log Tab ────────────────────────────────────────────────────────────
// The backend /api/audit endpoint has supported action/user/date filters and
// limit/offset pagination for a while — this tab is the first thing that
// actually calls it. Previously audit_logs was written to on every
// project/policy/apply mutation but was completely invisible in the UI.
function AuditTab() {
  const PAGE_SIZE = 50;
  const [logs, setLogs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [offset, setOffset]   = useState(0);
  const [action, setAction]   = useState('');
  const [from, setFrom]       = useState('');
  const [to, setTo]           = useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError('');
    const params = { limit: PAGE_SIZE, offset };
    if (action.trim()) params.action = action.trim();
    if (from) params.from = from;
    if (to) params.to = to;
    API.get('/api/audit', { params })
      .then(r => setLogs(r.data || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load audit log'))
      .finally(() => setLoading(false));
  }, [offset, action, from, to]);

  useEffect(() => { load(); }, [load]);

  const applyFilters = (e) => {
    e.preventDefault();
    setOffset(0);
    load();
  };

  const ACTION_COLOR = (a) => {
    if (!a) return 'gray';
    if (a.includes('delete') || a.includes('reject') || a.includes('remove')) return 'red';
    if (a.includes('create') || a.includes('approve') || a.includes('invite')) return 'green';
    if (a.includes('apply')) return 'purple';
    if (a.includes('plan') || a.includes('validate')) return 'blue';
    return 'gray';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <form onSubmit={applyFilters} style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>Action contains</label>
          <input value={action} onChange={e => setAction(e.target.value)} placeholder="e.g. project.delete"
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 12, width: 180 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 12 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 4 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 12 }} />
        </div>
        <button type="submit" style={{
          padding: '7px 14px', borderRadius: 7, border: '1px solid #2563EB', background: '#2563EB',
          color: '#FFFFFF', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>Filter</button>
        {(action || from || to) && (
          <button type="button" onClick={() => { setAction(''); setFrom(''); setTo(''); setOffset(0); }} style={{
            padding: '7px 14px', borderRadius: 7, border: '1px solid #D1D5DB', background: '#F3F4F6',
            color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>Clear</button>
        )}
      </form>

      {error && <p style={{ color: '#DC2626', fontSize: 13 }}>{error}</p>}

      {loading ? (
        <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading audit log…</p>
      ) : logs.length === 0 ? (
        <p style={{ color: '#9CA3AF', fontSize: 13 }}>No audit entries match these filters.</p>
      ) : (
        <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#F9FAFB', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: '#6B7280' }}>Time</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: '#6B7280' }}>Action</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: '#6B7280' }}>User</th>
                <th style={{ padding: '8px 12px', fontWeight: 600, color: '#6B7280' }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id} style={{ borderTop: '1px solid #F3F4F6' }}>
                  <td style={{ padding: '8px 12px', color: '#6B7280', whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
                  <td style={{ padding: '8px 12px' }}><Badge color={ACTION_COLOR(l.action)}>{l.action}</Badge></td>
                  <td style={{ padding: '8px 12px', color: '#374151' }}>{l.user_email || '—'}</td>
                  <td style={{ padding: '8px 12px', color: '#9CA3AF', fontFamily: 'monospace', fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.method && l.path ? `${l.method} ${l.path}` : (l.ip || '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12 }}>
        <Btn onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>← Previous</Btn>
        <span style={{ fontSize: 12, color: '#6B7280' }}>Rows {offset + 1}–{offset + logs.length}</span>
        <Btn onClick={() => setOffset(offset + PAGE_SIZE)} disabled={logs.length < PAGE_SIZE}>Next →</Btn>
      </div>
    </div>
  );
}

function SystemTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    API.get('/api/admin/system')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#9CA3AF', fontSize: 13 }}>Loading system status…</p>;
  if (!data)   return <p style={{ color: '#EF4444', fontSize: 13 }}>Failed to load system info</p>;

  const statusBadge = (status) => {
    if (status === 'ok' || status === 'available') return <Badge color="green">✓ {status}</Badge>;
    if (status === 'unavailable' || status === 'not-installed') return <Badge color="yellow">⚠ {status}</Badge>;
    return <Badge color="red">✗ {status}</Badge>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section title="Service Health">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Object.entries(data.checks || {}).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
              <span style={{ width: 100, fontWeight: 600, textTransform: 'capitalize' }}>{key}</span>
              {statusBadge(val.status)}
              {val.path && <span style={{ fontSize: 11, color: '#9CA3AF' }}>{val.path}</span>}
              {val.error && <span style={{ fontSize: 11, color: '#EF4444' }}>{val.error}</span>}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Environment">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Object.entries(data.env || {}).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
              <span style={{ width: 160, fontFamily: 'monospace', fontSize: 12, color: '#6B7280' }}>{key}</span>
              <span style={{ color: val.includes('✓') ? '#059669' : '#DC2626' }}>{val}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Process">
        <div style={{ display: 'flex', gap: 20 }}>
          <Stat label="Uptime" value={formatUptime(data.uptime_seconds)} color="#0284C7" />
          <Stat label="Memory" value={`${data.memory_mb} MB`} color="#7C3AED" />
        </div>
      </Section>
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', margin: '0 0 12px', borderBottom: '1px solid #E5E7EB', paddingBottom: 8 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function formatUptime(s) {
  if (!s) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
