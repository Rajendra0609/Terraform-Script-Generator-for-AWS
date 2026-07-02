import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { projectsAPI } from '../api/client';

/**
 * Team.jsx — Project member management + pending invitations.
 *
 * This page closes a gap that existed even though the backend was fully
 * ready for it: project_members (viewer/editor/deployer roles) has had a
 * complete invite / accept / remove API in routes/projects.js, but no
 * frontend screen ever called it. Invited users had no way to discover an
 * invitation existed, and project owners had no UI to invite or manage
 * teammates at all.
 *
 * Two things live on this page:
 *  1. "Pending invitations" — projects *other people* invited you to, that
 *     you haven't accepted or declined yet. Always shown if any exist,
 *     regardless of which project (if any) is selected in the URL.
 *  2. "Team" for a specific project — full member list + invite form
 *     (owner/admin only) + role display + remove (owner/admin) or
 *     leave-project (self) actions.
 */

const ROLE_COLORS = {
  admin:    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
  deployer: { bg: '#F5F3FF', border: '#DDD6FE', text: '#5B21B6' },
  editor:   { bg: '#EFF6FF', border: '#BFDBFE', text: '#1E40AF' },
  viewer:   { bg: '#F9FAFB', border: '#E5E7EB', text: '#374151' },
  owner:    { bg: '#F0FDF4', border: '#BBF7D0', text: '#065F46' },
};

function RoleBadge({ role }) {
  const c = ROLE_COLORS[role] || ROLE_COLORS.viewer;
  return (
    <span style={{
      background: c.bg, border: `1px solid ${c.border}`, color: c.text,
      padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
    }}>{role}</span>
  );
}

function Btn({ onClick, children, variant = 'default', disabled, loading, small }) {
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
        padding: small ? '5px 10px' : '8px 16px', borderRadius: 7, border: `1px solid ${v.border}`,
        background: disabled || loading ? '#E5E7EB' : v.bg,
        color: disabled || loading ? '#9CA3AF' : v.color,
        fontSize: small ? 11 : 13, fontWeight: 600, cursor: disabled || loading ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >{loading ? '…' : children}</button>
  );
}

export default function Team() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();

  const [invitations, setInvitations] = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError] = useState('');

  const [project, setProject] = useState(null);
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(!!projectId);
  const [membersError, setMembersError] = useState('');

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState('');
  const [busyAction, setBusyAction] = useState(null); // membership_id / user_id currently loading

  const loadInvitations = useCallback(() => {
    setInvitesLoading(true);
    projectsAPI.myInvitations()
      .then(r => setInvitations(r.data || []))
      .catch(e => setInvitesError(e.response?.data?.error || 'Failed to load invitations'))
      .finally(() => setInvitesLoading(false));
  }, []);

  const loadTeam = useCallback(() => {
    if (!projectId) { setMembersLoading(false); return; }
    setMembersLoading(true);
    setMembersError('');
    Promise.all([projectsAPI.get(projectId), projectsAPI.getMembers(projectId)])
      .then(([p, m]) => { setProject(p.data); setMembers(m.data || []); })
      .catch(e => setMembersError(e.response?.data?.error || 'Failed to load team — you may not have access to this project yet.'))
      .finally(() => setMembersLoading(false));
  }, [projectId]);

  useEffect(() => { loadInvitations(); }, [loadInvitations]);
  useEffect(() => { loadTeam(); }, [loadTeam]);

  const isOwner = project && user && project.user_id === user.id;
  const canManage = isOwner || user?.role === 'admin';

  const handleAccept = async (inv) => {
    setBusyAction(inv.membership_id);
    try {
      await projectsAPI.acceptInvite(inv.project_id, user.id);
      setInvitations(prev => prev.filter(i => i.membership_id !== inv.membership_id));
      nav(`/team/${inv.project_id}`);
    } catch (e) {
      setInvitesError(e.response?.data?.error || 'Failed to accept invitation');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDecline = async (inv) => {
    setBusyAction(inv.membership_id);
    try {
      await projectsAPI.declineInvite(inv.project_id, user.id);
      setInvitations(prev => prev.filter(i => i.membership_id !== inv.membership_id));
    } catch (e) {
      setInvitesError(e.response?.data?.error || 'Failed to decline invitation');
    } finally {
      setBusyAction(null);
    }
  };

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg('');
    try {
      await projectsAPI.inviteMember(projectId, { email: inviteEmail.trim(), role: inviteRole });
      setInviteMsg(`✓ Invited ${inviteEmail.trim()} as ${inviteRole}`);
      setInviteEmail('');
      loadTeam();
    } catch (e) {
      setInviteMsg(e.response?.data?.error || 'Failed to invite — make sure they already have a TFGen account.');
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (m) => {
    if (!window.confirm(`Remove ${m.email} from this project?`)) return;
    setBusyAction(m.user_id);
    try {
      await projectsAPI.removeMember(projectId, m.user_id);
      setMembers(prev => prev.filter(x => x.user_id !== m.user_id));
    } catch (e) {
      setMembersError(e.response?.data?.error || 'Failed to remove member');
    } finally {
      setBusyAction(null);
    }
  };

  const handleLeave = async () => {
    if (!window.confirm('Leave this project? You will lose access unless invited again.')) return;
    setBusyAction(user.id);
    try {
      await projectsAPI.declineInvite(projectId, user.id); // same DELETE endpoint — self-removal
      nav('/dashboard');
    } catch (e) {
      setMembersError(e.response?.data?.error || 'Failed to leave project');
    } finally {
      setBusyAction(null);
    }
  };

  const s = {
    page: { minHeight: 'calc(100vh - 52px)', background: '#F7F9FC', color: '#111827' },
    header: { background: '#FFFFFF', borderBottom: '1px solid #E5E7EB', padding: '20px 32px' },
    body: { padding: '24px 32px', maxWidth: 800, margin: '0 auto' },
    card: { background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 20 },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #F3F4F6' },
    input: { padding: '8px 12px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, flex: 1 },
    select: { padding: '8px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13 },
  };

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>👥 Team</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6B7280' }}>
          {project ? `Members of "${project.name}"` : 'Manage project invitations and teammates'}
        </p>
      </div>

      <div style={s.body}>
        {/* ── Pending invitations (always shown if any exist) ───────────── */}
        {!invitesLoading && invitations.length > 0 && (
          <div style={s.card}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>📬 Pending invitations</h3>
            {invitesError && <p style={{ color: '#DC2626', fontSize: 12 }}>{invitesError}</p>}
            {invitations.map(inv => (
              <div key={inv.membership_id} style={s.row}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{inv.project_name}</div>
                  <div style={{ fontSize: 12, color: '#6B7280' }}>
                    Invited by {inv.invited_by_email || 'a project owner'} as <RoleBadge role={inv.role} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn variant="success" small loading={busyAction === inv.membership_id} onClick={() => handleAccept(inv)}>Accept</Btn>
                  <Btn variant="danger" small loading={busyAction === inv.membership_id} onClick={() => handleDecline(inv)}>Decline</Btn>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── No project selected: empty state ───────────────────────────── */}
        {!projectId && (
          <div style={s.card}>
            {invitesLoading ? (
              <p style={{ fontSize: 13, color: '#6B7280' }}>Loading…</p>
            ) : invitations.length === 0 ? (
              <p style={{ fontSize: 13, color: '#6B7280' }}>No pending invitations. Open a project from your Dashboard and use its "Team" button to manage members.</p>
            ) : null}
            <Link to="/dashboard" style={{ fontSize: 13, color: '#2563EB', fontWeight: 600 }}>← Back to Dashboard</Link>
          </div>
        )}

        {/* ── Team for the selected project ──────────────────────────────── */}
        {projectId && (
          <div style={s.card}>
            {membersLoading ? (
              <p style={{ fontSize: 13, color: '#6B7280' }}>Loading team…</p>
            ) : membersError ? (
              <p style={{ fontSize: 13, color: '#DC2626' }}>{membersError}</p>
            ) : (
              <>
                <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>Members</h3>

                <div style={s.row}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{project?.owner_email || 'Project owner'}</div>
                  </div>
                  <RoleBadge role="owner" />
                </div>

                {members.filter(m => m.accepted_at).map(m => (
                  <div key={m.user_id} style={s.row}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{m.email}</div>
                      <div style={{ fontSize: 11, color: '#9CA3AF' }}>Joined {new Date(m.accepted_at).toLocaleDateString()}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <RoleBadge role={m.role} />
                      {canManage && (
                        <Btn variant="danger" small loading={busyAction === m.user_id} onClick={() => handleRemove(m)}>Remove</Btn>
                      )}
                      {!canManage && m.user_id === user?.id && (
                        <Btn variant="danger" small loading={busyAction === m.user_id} onClick={handleLeave}>Leave</Btn>
                      )}
                    </div>
                  </div>
                ))}

                {members.filter(m => !m.accepted_at).length > 0 && (
                  <>
                    <h4 style={{ margin: '16px 0 8px', fontSize: 12, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' }}>Awaiting response</h4>
                    {members.filter(m => !m.accepted_at).map(m => (
                      <div key={m.user_id} style={s.row}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#9CA3AF' }}>{m.email}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <RoleBadge role={m.role} />
                          {canManage && (
                            <Btn variant="danger" small loading={busyAction === m.user_id} onClick={() => handleRemove(m)}>Cancel invite</Btn>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {members.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280' }}>No teammates yet — invite one below.</p>
                )}

                {canManage && (
                  <form onSubmit={handleInvite} style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #F3F4F6' }}>
                    <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 700 }}>Invite a teammate</h3>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        style={s.input}
                        type="email"
                        placeholder="teammate@company.com"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        required
                      />
                      <select style={s.select} value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
                        <option value="viewer">Viewer — read only</option>
                        <option value="editor">Editor — build &amp; save</option>
                        <option value="deployer">Deployer — build, plan &amp; apply</option>
                      </select>
                      <Btn variant="primary" loading={inviting} disabled={!inviteEmail.trim()}>Invite</Btn>
                    </div>
                    <p style={{ fontSize: 11, color: '#9CA3AF', margin: '6px 0 0' }}>
                      They must already have a TFGen account under this email address.
                    </p>
                    {inviteMsg && <p style={{ fontSize: 12, color: inviteMsg.startsWith('✓') ? '#059669' : '#DC2626', marginTop: 8 }}>{inviteMsg}</p>}
                  </form>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
