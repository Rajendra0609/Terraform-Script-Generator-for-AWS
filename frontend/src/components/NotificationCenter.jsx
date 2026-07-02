import React, { useState, useEffect, useRef, useCallback } from 'react';
import API from '../api/client';

const TYPE_ICON = {
  'change_request.created':  '📋',
  'change_request.approved': '✅',
  'change_request.rejected': '❌',
  'plan.failed':             '🔴',
  'plan.succeeded':          '🟢',
  'apply.succeeded':         '🚀',
  'apply.failed':            '💥',
  'policy.violated':         '🚫',
  'checkov.critical':        '🚨',
  'member.invited':          '👋',
};

/**
 * NotificationCenter — Notification bell icon + dropdown for Navbar
 * 
 * Usage: <NotificationCenter onNavigate={href => navigate(href)} />
 */
export default function NotificationCenter({ onNavigate }) {
  const [open, setOpen]       = useState(false);
  const [notifs, setNotifs]   = useState([]);
  const [count, setCount]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [prefOpen, setPrefOpen] = useState(false);
  const dropdownRef = useRef(null);
  const pollRef     = useRef(null);

  const fetchCount = useCallback(async () => {
    try {
      const r = await API.get('/api/notifications/unread-count');
      setCount(r.data?.count || 0);
    } catch (_) {}
  }, []);

  const fetchNotifs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await API.get('/api/notifications?limit=30');
      setNotifs(r.data || []);
    } catch (_) {}
    finally { setLoading(false); }
  }, []);

  // Poll unread count every 60 seconds
  useEffect(() => {
    fetchCount();
    pollRef.current = setInterval(fetchCount, 60_000);
    return () => clearInterval(pollRef.current);
  }, [fetchCount]);

  // Load notifications when dropdown opens
  useEffect(() => {
    if (open) fetchNotifs();
  }, [open, fetchNotifs]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const markRead = async (id) => {
    await API.post(`/api/notifications/${id}/read`).catch(() => {});
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    setCount(prev => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await API.post('/api/notifications/read-all').catch(() => {});
    setNotifs(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    setCount(0);
  };

  const deleteNotif = async (id) => {
    await API.delete(`/api/notifications/${id}`).catch(() => {});
    setNotifs(prev => prev.filter(n => n.id !== id));
  };

  const handleNotifClick = (n) => {
    if (!n.read_at) markRead(n.id);
    if (n.link && onNavigate) { onNavigate(n.link); setOpen(false); }
  };

  const unreadNotifs = notifs.filter(n => !n.read_at);
  const readNotifs   = notifs.filter(n => n.read_at);

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'relative', border: 'none', borderRadius: 8,
          background: open ? '#F3F4F6' : 'transparent',
          width: 34, height: 34, cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#6B7280',
        }}
        title="Notifications"
      >
        🔔
        {count > 0 && (
          <span style={{
            position: 'absolute', top: 4, right: 4,
            background: '#EF4444', color: '#FFF',
            borderRadius: 10, minWidth: 16, height: 16, fontSize: 9,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, padding: '0 3px', border: '2px solid #FFFFFF',
          }}>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          width: 360, maxHeight: 520, background: '#FFFFFF',
          border: '1px solid #E5E7EB', borderRadius: 12,
          boxShadow: '0 10px 40px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column',
          zIndex: 9999,
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #E5E7EB',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>
              Notifications {count > 0 && <span style={{ color: '#6B7280', fontWeight: 400 }}>({count} unread)</span>}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {count > 0 && (
                <button onClick={markAllRead} style={{
                  border: 'none', background: 'none', fontSize: 11,
                  color: '#2563EB', cursor: 'pointer', fontWeight: 600, padding: '2px 4px',
                }}>
                  Mark all read
                </button>
              )}
              <button onClick={() => { setPrefOpen(true); setOpen(false); }} style={{
                border: 'none', background: 'none', fontSize: 16,
                cursor: 'pointer', color: '#9CA3AF', padding: '2px 4px',
              }} title="Preferences">⚙️</button>
            </div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && (
              <div style={{ padding: 24, textAlign: 'center', color: '#9CA3AF', fontSize: 13 }}>
                Loading…
              </div>
            )}

            {!loading && notifs.length === 0 && (
              <div style={{ padding: 32, textAlign: 'center', color: '#9CA3AF' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔔</div>
                <div style={{ fontSize: 13 }}>No notifications yet</div>
              </div>
            )}

            {/* Unread */}
            {unreadNotifs.length > 0 && (
              <div>
                <div style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Unread
                </div>
                {unreadNotifs.map(n => (
                  <NotifItem key={n.id} n={n} onClick={() => handleNotifClick(n)} onDelete={() => deleteNotif(n.id)} />
                ))}
              </div>
            )}

            {/* Read */}
            {readNotifs.length > 0 && (
              <div>
                <div style={{ padding: '8px 16px 4px', fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Earlier
                </div>
                {readNotifs.map(n => (
                  <NotifItem key={n.id} n={n} onClick={() => handleNotifClick(n)} onDelete={() => deleteNotif(n.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Preferences modal */}
      {prefOpen && <NotifPreferences onClose={() => setPrefOpen(false)} />}
    </div>
  );
}

function NotifItem({ n, onClick, onDelete }) {
  const [hover, setHover] = useState(false);
  const icon = TYPE_ICON[n.type] || '📢';
  const timeAgo = formatTimeAgo(n.created_at);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '10px 16px', cursor: n.link ? 'pointer' : 'default',
        background: !n.read_at ? '#EFF6FF' : (hover ? '#F9FAFB' : '#FFFFFF'),
        borderBottom: '1px solid #F3F4F6', display: 'flex', gap: 10, alignItems: 'flex-start',
        transition: 'background 0.1s',
        position: 'relative',
      }}
    >
      {/* Unread dot */}
      {!n.read_at && (
        <div style={{
          position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)',
          width: 6, height: 6, borderRadius: '50%', background: '#2563EB',
        }} />
      )}

      <div style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>{icon}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: n.read_at ? 400 : 600, color: '#111827', lineHeight: 1.4 }}>
          {n.title}
        </div>
        {n.body && (
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2, lineHeight: 1.4 }}>
            {n.body.length > 80 ? n.body.slice(0, 80) + '…' : n.body}
          </div>
        )}
        <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 3 }}>
          {timeAgo}
          {n.actor_email && ` · ${n.actor_email}`}
        </div>
      </div>

      {/* Delete button on hover */}
      {hover && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          style={{
            border: 'none', background: '#F3F4F6', borderRadius: 6,
            width: 22, height: 22, cursor: 'pointer', fontSize: 11,
            color: '#9CA3AF', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >✕</button>
      )}
    </div>
  );
}

function NotifPreferences({ onClose }) {
  const [prefs, setPrefs]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [testUrl, setTestUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    API.get('/api/notifications/preferences')
      .then(r => setPrefs(r.data))
      .catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await API.put('/api/notifications/preferences', prefs);
      onClose();
    } catch (e) {
      alert(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const testWebhook = async () => {
    setTesting(true);
    setTestResult('');
    try {
      const r = await API.post('/api/notifications/webhook-test', { url: testUrl });
      setTestResult(r.data.success ? `✅ Success (HTTP ${r.data.status})` : `❌ Failed: ${r.data.error}`);
    } catch (e) {
      setTestResult(`❌ ${e.response?.data?.error || 'Request failed'}`);
    } finally { setTesting(false); }
  };

  const toggle = (key) => setPrefs(p => ({ ...p, [key]: !p[key] }));

  const inp = { width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #D1D5DB', fontSize: 13, boxSizing: 'border-box' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 20,
    }}>
      <div style={{ background: '#FFFFFF', borderRadius: 12, width: '100%', maxWidth: 440, padding: 24 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>⚙️ Notification Preferences</h3>

        {!prefs ? <p style={{ color: '#9CA3AF' }}>Loading…</p> : (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Channels
              </div>
              {[
                { key: 'notify_inapp', label: '🔔 In-app notifications' },
                { key: 'notify_email', label: '📧 Email notifications' },
              ].map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!prefs[key]} onChange={() => toggle(key)} />
                  {label}
                </label>
              ))}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Events
              </div>
              {[
                { key: 'notify_plan_done',   label: '🔵 Plan completed / failed' },
                { key: 'notify_apply_done',  label: '🚀 Apply completed / failed' },
                { key: 'notify_cr_review',   label: '📋 Change request review updates' },
                { key: 'notify_policy_fail', label: '🚫 Policy violation detected' },
              ].map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!prefs[key]} onChange={() => toggle(key)} />
                  {label}
                </label>
              ))}
            </div>

            {/* Webhook */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Webhook
              </div>
              <input
                value={prefs.webhook_url || ''}
                onChange={e => setPrefs(p => ({ ...p, webhook_url: e.target.value }))}
                placeholder="https://hooks.slack.com/…"
                style={inp}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                <input
                  value={testUrl}
                  onChange={e => setTestUrl(e.target.value)}
                  placeholder="Test URL…"
                  style={{ ...inp, flex: 1 }}
                />
                <button
                  onClick={testWebhook}
                  disabled={testing || !testUrl}
                  style={{
                    padding: '7px 12px', borderRadius: 7, border: '1px solid #D1D5DB',
                    background: '#F9FAFB', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >{testing ? '…' : 'Test'}</button>
              </div>
              {testResult && (
                <div style={{ fontSize: 12, marginTop: 4, color: testResult.startsWith('✅') ? '#059669' : '#DC2626' }}>
                  {testResult}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #D1D5DB', background: '#F9FAFB', fontSize: 12, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', background: '#2563EB', color: '#FFF', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {saving ? 'Saving…' : 'Save Preferences'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
