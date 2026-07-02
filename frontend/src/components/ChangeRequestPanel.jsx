import React, { useState, useEffect, useCallback } from 'react';
import API from '../api/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Badge({ color, children, small }) {
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
      padding: small ? '1px 6px' : '2px 8px',
      borderRadius: 6, fontSize: small ? 10 : 11, fontWeight: 600,
    }}>{children}</span>
  );
}

const STATUS_COLOR = { open: 'blue', approved: 'green', rejected: 'red', merged: 'purple' };
const STATUS_ICON  = { open: '🔵', approved: '✅', rejected: '❌', merged: '🟣' };

function Btn({ onClick, children, variant = 'default', disabled, loading, small }) {
  const vs = {
    default: { bg: '#F9FAFB', border: '#E5E7EB', color: '#374151' },
    primary: { bg: '#2563EB', border: '#2563EB', color: '#FFF' },
    success: { bg: '#10B981', border: '#10B981', color: '#FFF' },
    danger:  { bg: '#EF4444', border: '#EF4444', color: '#FFF' },
    ghost:   { bg: 'transparent', border: 'transparent', color: '#6B7280' },
  };
  const v = vs[variant] || vs.default;
  const pad = small ? '4px 10px' : '7px 14px';
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{
      padding: pad, borderRadius: 7, border: `1px solid ${v.border}`,
      background: disabled || loading ? '#F3F4F6' : v.bg,
      color: disabled || loading ? '#9CA3AF' : v.color,
      fontSize: small ? 11 : 12, fontWeight: 600,
      cursor: disabled || loading ? 'not-allowed' : 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>{loading ? '…' : children}</button>
  );
}

/**
 * ChangeRequestPanel — drop-in panel for Builder and Dashboard
 *
 * Props:
 *   projectId  — UUID of the current project
 *   versions   — array of { id, version_number } (from project_versions)
 *   currentUser — { id, email, role }
 *   compact    — if true, show collapsed summary
 */
export default function ChangeRequestPanel({ projectId, versions = [], currentUser, compact }) {
  const [crs, setCRs]        = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);  // full CR view
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError]    = useState('');

  const load = useCallback(() => {
    if (!projectId || !UUID_RE.test(projectId)) return;
    setLoading(true);
    API.get(`/api/change-requests/project/${projectId}`)
      .then(r => setCRs(r.data || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load change requests'))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const openCount = crs.filter(c => c.status === 'open').length;

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#6B7280' }}>
          {openCount > 0 ? (
            <><Badge color="blue">{openCount} open CR{openCount > 1 ? 's' : ''}</Badge></>
          ) : 'No open CRs'}
        </span>
        <Btn small onClick={() => setShowCreate(true)}>+ Submit CR</Btn>
        {showCreate && (
          <CreateCRModal
            projectId={projectId}
            versions={versions}
            onClose={() => setShowCreate(false)}
            onCreated={() => { setShowCreate(false); load(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 400 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 18px', borderBottom: '1px solid #E5E7EB',
        background: '#FFFFFF',
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
            Change Requests
          </h3>
          <p style={{ margin: 0, fontSize: 12, color: '#6B7280' }}>
            PR-style review before applying — {crs.length} total, {openCount} open
          </p>
        </div>
        <Btn variant="primary" onClick={() => setShowCreate(true)}>
          + Submit for Review
        </Btn>
      </div>

      {error && (
        <div style={{ padding: '10px 18px', background: '#FEF2F2', color: '#DC2626', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* CR list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, background: '#F9FAFB' }}>
        {loading && <p style={{ color: '#9CA3AF', fontSize: 13, padding: 8 }}>Loading…</p>}

        {!loading && crs.length === 0 && (
          <div style={{
            textAlign: 'center', padding: '40px 20px', color: '#9CA3AF',
            background: '#FFFFFF', borderRadius: 10, border: '1px dashed #D1D5DB',
          }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#374151' }}>No change requests yet</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Submit a version for review before applying to production.
            </div>
            <div style={{ marginTop: 16 }}>
              <Btn variant="primary" onClick={() => setShowCreate(true)}>Submit First CR</Btn>
            </div>
          </div>
        )}

        {!loading && crs.map(cr => (
          <CRCard
            key={cr.id}
            cr={cr}
            currentUser={currentUser}
            onSelect={() => setSelected(cr)}
            onRefresh={load}
          />
        ))}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateCRModal
          projectId={projectId}
          versions={versions}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}

      {selected && (
        <CRDetailModal
          crId={selected.id}
          currentUser={currentUser}
          onClose={() => setSelected(null)}
          onRefresh={() => { load(); setSelected(null); }}
        />
      )}
    </div>
  );
}

// ─── CRCard ───────────────────────────────────────────────────────────────────
function CRCard({ cr, currentUser, onSelect, onRefresh }) {
  const [acting, setActing] = useState(false);

  const quickAction = async (action, payload = {}) => {
    setActing(true);
    try {
      await API.post(`/api/change-requests/${cr.id}/${action}`, payload);
      onRefresh();
    } catch (e) {
      alert(e.response?.data?.error || `Action "${action}" failed`);
    } finally { setActing(false); }
  };

  const canReview = currentUser && ['admin', 'deployer'].includes(currentUser.role) && cr.author_id !== currentUser.id;
  const isAuthor  = currentUser?.id === cr.author_id;

  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 10,
      padding: '14px 16px', marginBottom: 8, cursor: 'pointer',
      borderLeft: `4px solid ${cr.status === 'approved' ? '#10B981' : cr.status === 'rejected' ? '#EF4444' : cr.status === 'merged' ? '#8B5CF6' : '#3B82F6'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }} onClick={onSelect}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              {STATUS_ICON[cr.status]} {cr.title}
            </span>
            <Badge color={STATUS_COLOR[cr.status]}>{cr.status}</Badge>
            {cr.version_number && <Badge color="gray" small>v{cr.version_number}</Badge>}
          </div>

          <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
            By {cr.author_email || 'Unknown'} · {new Date(cr.created_at).toLocaleString()}
            {cr.approved_by_email && ` · Approved by ${cr.approved_by_email}`}
            {cr.rejected_by_email && ` · Rejected by ${cr.rejected_by_email}`}
          </div>

          {cr.description && (
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6, lineHeight: 1.5 }}>
              {cr.description.length > 120 ? cr.description.slice(0, 120) + '…' : cr.description}
            </div>
          )}

          {cr.reject_reason && (
            <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6, fontStyle: 'italic' }}>
              Rejection reason: {cr.reject_reason}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          {cr.status === 'open' && canReview && (
            <>
              <Btn small variant="success" onClick={() => quickAction('approve', { comment: 'Approved ✅' })} loading={acting}>
                Approve
              </Btn>
              <Btn small variant="danger" onClick={() => {
                const reason = window.prompt('Rejection reason (optional):');
                if (reason !== null) quickAction('reject', { reason });
              }} loading={acting}>
                Reject
              </Btn>
            </>
          )}
          {cr.status === 'approved' && (currentUser?.role === 'admin' || currentUser?.role === 'deployer') && (
            <Btn small variant="primary" onClick={() => quickAction('merge')} loading={acting}>
              Mark Merged
            </Btn>
          )}
          {cr.status === 'open' && isAuthor && (
            <Btn small variant="ghost" onClick={async () => {
              if (!window.confirm('Withdraw this change request?')) return;
              try { await API.delete(`/api/change-requests/${cr.id}`); onRefresh(); }
              catch (e) { alert(e.response?.data?.error || 'Failed to withdraw'); }
            }}>
              Withdraw
            </Btn>
          )}
          <Btn small onClick={onSelect}>Detail →</Btn>
        </div>
      </div>
    </div>
  );
}

// ─── CRDetailModal ────────────────────────────────────────────────────────────
function CRDetailModal({ crId, currentUser, onClose, onRefresh }) {
  const [cr, setCR]          = useState(null);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading]  = useState(true);
  const [posting, setPosting]  = useState(false);
  const [acting, setActing]    = useState(false);

  const loadAll = useCallback(() => {
    Promise.all([
      API.get(`/api/change-requests/${crId}`),
      API.get(`/api/change-requests/${crId}/comments`),
    ]).then(([crRes, commRes]) => {
      setCR(crRes.data);
      setComments(commRes.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [crId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const postComment = async () => {
    if (!newComment.trim()) return;
    setPosting(true);
    try {
      const r = await API.post(`/api/change-requests/${crId}/comments`, { body: newComment.trim() });
      setComments(prev => [...prev, r.data]);
      setNewComment('');
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to post comment');
    } finally { setPosting(false); }
  };

  const action = async (act, payload = {}) => {
    setActing(true);
    try {
      await API.post(`/api/change-requests/${crId}/${act}`, payload);
      onRefresh();
    } catch (e) {
      alert(e.response?.data?.error || `Action failed`);
      setActing(false);
    }
  };

  const canReview = currentUser && ['admin', 'deployer'].includes(currentUser.role) && cr?.author_id !== currentUser?.id;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000, padding: 20,
    }}>
      <div style={{
        background: '#FFFFFF', borderRadius: 14, width: '100%', maxWidth: 680,
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
      }}>
        {/* Modal header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #E5E7EB', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            {loading ? <div style={{ color: '#9CA3AF' }}>Loading…</div> : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                    {STATUS_ICON[cr.status]} {cr.title}
                  </h2>
                  <Badge color={STATUS_COLOR[cr.status]}>{cr.status}</Badge>
                  {cr.version_number && <Badge color="gray">v{cr.version_number}</Badge>}
                </div>
                <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
                  {cr.project_name} · by {cr.author_email} · {new Date(cr.created_at).toLocaleString()}
                </div>
              </>
            )}
          </div>
          <button onClick={onClose} style={{
            border: 'none', background: '#F3F4F6', borderRadius: 8,
            width: 30, height: 30, cursor: 'pointer', fontSize: 16, color: '#374151',
          }}>✕</button>
        </div>

        {/* Body */}
        {!loading && cr && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
            {cr.description && (
              <div style={{
                background: '#F9FAFB', border: '1px solid #E5E7EB',
                borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, lineHeight: 1.6,
              }}>
                {cr.description}
              </div>
            )}

            {cr.reject_reason && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#991B1B',
              }}>
                ❌ Rejected: {cr.reject_reason}
              </div>
            )}

            {/* Review actions */}
            {cr.status === 'open' && canReview && (
              <div style={{
                background: '#F0FDF4', border: '1px solid #A7F3D0',
                borderRadius: 8, padding: 14, marginBottom: 16,
                display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#065F46' }}>Review this CR:</span>
                <Btn variant="success" onClick={() => action('approve', { comment: 'Approved ✅' })} loading={acting}>
                  ✅ Approve
                </Btn>
                <Btn variant="danger" onClick={() => {
                  const reason = window.prompt('Rejection reason:');
                  if (reason !== null) action('reject', { reason });
                }} loading={acting}>
                  ❌ Reject
                </Btn>
              </div>
            )}

            {cr.status === 'approved' && (
              <div style={{
                background: '#F0FDF4', border: '1px solid #A7F3D0',
                borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#065F46',
              }}>
                ✅ Approved by {cr.approved_by_email} on {new Date(cr.approved_at).toLocaleString()}
                {(currentUser?.role === 'admin' || currentUser?.role === 'deployer') && (
                  <Btn small style={{ marginLeft: 10 }} variant="primary" onClick={() => action('merge')}>
                    Mark Merged
                  </Btn>
                )}
              </div>
            )}

            {/* Comments */}
            <div style={{ marginBottom: 12 }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 10px' }}>
                💬 Discussion ({comments.length})
              </h4>

              {comments.length === 0 && (
                <p style={{ fontSize: 12, color: '#9CA3AF', margin: 0 }}>No comments yet.</p>
              )}

              {comments.map(cm => (
                <div key={cm.id} style={{
                  background: '#F9FAFB', border: '1px solid #E5E7EB',
                  borderRadius: 8, padding: 12, marginBottom: 8,
                }}>
                  <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 6 }}>
                    <strong>{cm.author_email || 'Unknown'}</strong> · {new Date(cm.created_at).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{cm.body}</div>
                </div>
              ))}
            </div>

            {/* New comment box */}
            <div style={{ borderTop: '1px solid #E5E7EB', paddingTop: 14 }}>
              <textarea
                value={newComment}
                onChange={e => setNewComment(e.target.value)}
                placeholder="Leave a comment…"
                rows={3}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 7,
                  border: '1px solid #D1D5DB', fontSize: 13, resize: 'vertical',
                  fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                <Btn variant="primary" onClick={postComment} loading={posting} disabled={!newComment.trim()}>
                  Post Comment
                </Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── CreateCRModal ────────────────────────────────────────────────────────────
function CreateCRModal({ projectId, versions, onClose, onCreated }) {
  const [versionId, setVersionId] = useState(versions?.[0]?.id || '');
  const [title, setTitle]         = useState('');
  const [description, setDesc]    = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const submit = async () => {
    if (!versionId) { setError('Select a version to review'); return; }
    setSaving(true);
    setError('');
    try {
      await API.post('/api/change-requests', {
        project_id: projectId,
        version_id: versionId,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
      });
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create change request');
    } finally { setSaving(false); }
  };

  const inp = { width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 20,
    }}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 500, padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>📋 Submit for Review</h2>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6B7280' }}>
          A reviewer must approve before you can apply this version.
        </p>

        {error && <div style={{ color: '#DC2626', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
            Version to review *
          </label>
          <select value={versionId} onChange={e => setVersionId(e.target.value)} style={inp}>
            <option value="">Select a saved version…</option>
            {(versions || []).map(v => (
              <option key={v.id} value={v.id}>
                Version {v.version_number}
                {v.saved_at ? ` — ${new Date(v.saved_at).toLocaleString()}` : ''}
              </option>
            ))}
          </select>
          {(!versions || versions.length === 0) && (
            <div style={{ fontSize: 11, color: '#DC2626', marginTop: 4 }}>
              Save a version first before creating a change request.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
            Title (optional)
          </label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Describe what changed…" style={inp} />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
            Description (optional)
          </label>
          <textarea value={description} onChange={e => setDesc(e.target.value)}
            placeholder="Why is this change needed? What are the risks?" rows={4} style={{ ...inp, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={submit} loading={saving} disabled={!versionId}>
            Submit for Review
          </Btn>
        </div>
      </div>
    </div>
  );
}
