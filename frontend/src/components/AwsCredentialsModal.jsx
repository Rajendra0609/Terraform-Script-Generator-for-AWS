import React, { useState, useEffect } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { awsAPI } from '../api/client';
import { AWS_REGIONS as AWS_REGIONS_MAP, DEFAULT_AWS_REGION } from '../utils/awsRegions';

const AWS_REGIONS = Object.entries(AWS_REGIONS_MAP).map(([value, label]) => ({ value, label: `${label} (${value})` }));

export default function AwsCredentialsModal({ onClose }) {
  const { c } = useTheme();
  const [existing, setExisting]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [form, setForm] = useState({
    access_key_id:     '',
    secret_access_key: '',
    aws_region:        DEFAULT_AWS_REGION,
    label:             'My AWS Account',
  });

  useEffect(() => {
    awsAPI.getCredentials()
      .then(r => { setExisting(r.data.credentials); setLoading(false); })
      .catch(err => {
        if (err.response?.status === 401) {
          setError('You must be logged in to manage AWS credentials.');
        }
        setLoading(false);
      });
  }, []);

  function handleChange(e) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    setError(''); setSuccess('');
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!form.access_key_id.trim() || !form.secret_access_key.trim()) {
      return setError('Access Key ID and Secret Access Key are required.');
    }
    // Client-side key format check
    const keyId = form.access_key_id.trim();
    if (!/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(keyId)) {
      return setError(
        `Invalid Access Key ID format. Expected format: AKIA... or ASIA... followed by 16 uppercase letters/digits. Got: "${keyId.slice(0, 8)}…"\n\nMake sure you copied the full key without extra spaces.`
      );
    }
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await awsAPI.saveCredentials({
        access_key_id:     form.access_key_id.trim(),
        secret_access_key: form.secret_access_key.trim(),
        aws_region:        form.aws_region,
        label:             form.label.trim() || 'My AWS Account',
      });
      const info    = res.data.accountInfo;
      const warning = res.data.warning; // set by backend when SKIP_STS_VERIFY=true or STS was unreachable
      // FIX: when the backend saved credentials without live STS verification it
      // returns a `warning` field. Show that instead of the misleading
      // "Credentials verified" message so the user knows verification was skipped.
      if (warning) {
        setSuccess(`⚠️ Credentials saved (unverified): ${warning}`);
      } else {
        setSuccess(`Credentials verified and saved! AWS Account: ${info?.account || 'N/A'}`);
      }
      // Refresh displayed metadata
      const r = await awsAPI.getCredentials();
      setExisting(r.data.credentials);
      setForm(f => ({ ...f, access_key_id: '', secret_access_key: '' }));
    } catch (err) {
      const data = err.response?.data;
      let msg = data?.error || err.message || 'Failed to save credentials.';
      // Surface the raw AWS error detail prominently
      if (data?.detail && data.detail !== msg) {
        // Decode common AWS error messages into friendly text
        let detail = data.detail;
        if (detail.includes('InvalidClientTokenId') || detail.includes('not authorized to perform')) {
          detail = 'AWS rejected the Access Key ID — it may be invalid, disabled, or deleted in IAM.';
        } else if (detail.includes('SignatureDoesNotMatch')) {
          detail = 'The Secret Access Key is incorrect or contains extra whitespace. Copy it fresh from the AWS console.';
        } else if (detail.includes('security token') || detail.includes('ExpiredToken')) {
          detail = 'The security token has expired. If using a temporary ASIA key, generate a fresh one.';
        }
        msg += `\n\nAWS says: ${detail}`;
      }
      // Network-level failure
      if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
        msg = 'Cannot reach the TFGen backend. Make sure the server is running.';
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Remove your stored AWS credentials? Live AWS data lookups will fall back to curated data.')) return;
    setDeleting(true); setError(''); setSuccess('');
    try {
      await awsAPI.deleteCredentials();
      setExisting(null);
      setSuccess('AWS credentials removed.');
    } catch {
      setError('Failed to remove credentials.');
    } finally {
      setDeleting(false);
    }
  }

  const inputStyle = {
    width: '100%', background: c.bg3, border: `1px solid ${c.bd}`,
    borderRadius: 6, padding: '8px 12px', color: c.fg,
    fontSize: 13, fontFamily: 'JetBrains Mono, monospace', boxSizing: 'border-box',
    outline: 'none',
  };
  const labelStyle = { fontSize: 12, color: c.fg2, fontWeight: 600, marginBottom: 4, display: 'block' };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: c.bg2, border: `1px solid ${c.bd}`, borderRadius: 12,
        width: 520, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto',
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: c.fg }}>
              🔐 AWS Credentials
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: c.fg3 }}>
              Stored encrypted in your account. Used for live AMI, AZ and instance-type lookups.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 20, padding: 4 }}>✕</button>
        </div>

        <div style={{ padding: 24 }}>
          {/* Security notice */}
          <div style={{ background: c.bg3, border: `1px solid ${c.bd}`, borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: c.fg2 }}>
            <strong style={{ color: '#f59e0b' }}>🛡 Security:</strong>{' '}
            Your secret key is encrypted with AES-256-GCM before storage and never returned in API responses.
            We recommend using an IAM user with <strong>read-only EC2 permissions</strong> (e.g. <code style={{ color: c.accent }}>AmazonEC2ReadOnlyAccess</code>).
            <br /><br />
            <strong style={{ color: '#60a5fa' }}>ℹ️ ap-south-1 / Mumbai users:</strong>{' '}
            Use a permanent IAM user key (<code style={{ color: c.accent }}>AKIA...</code>), not a temporary session key (<code style={{ color: c.accent }}>ASIA...</code>), unless you also provide a session token. Make sure the IAM user has <code style={{ color: c.accent }}>sts:GetCallerIdentity</code> permission.
          </div>

          {/* Existing credentials display */}
          {loading ? (
            <p style={{ color: c.fg3, fontSize: 13 }}>Loading…</p>
          ) : existing ? (
            <div style={{ background: '#16a34a18', border: '1px solid #16a34a44', borderRadius: 8, padding: '12px 16px', marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#4ade80' }}>✅ Credentials connected</p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: c.fg2 }}>
                    <strong>Label:</strong> {existing.label}<br />
                    <strong>Region:</strong> {existing.aws_region}<br />
                    <strong>Key ID:</strong> <code style={{ color: c.accent }}>{existing.access_key_id}</code><br />
                    <strong>Verified:</strong> {existing.verified_at ? new Date(existing.verified_at).toLocaleString() : 'N/A'}
                  </p>
                </div>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{
                    background: '#ef44441a', border: '1px solid #ef444444', color: '#f87171',
                    borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  {deleting ? 'Removing…' : '🗑 Remove'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ background: c.bg3, border: `1px dashed ${c.bd}`, borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: c.fg3 }}>
              No AWS credentials stored. Without credentials, AMIs and availability zones will use curated static data.
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSave} autoComplete="off">
            <h3 style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, color: c.fg }}>
              {existing ? 'Update Credentials' : 'Add Credentials'}
            </h3>

            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Label (optional)</label>
              <input
                name="label" value={form.label} onChange={handleChange}
                placeholder="My AWS Account" style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Default Region</label>
              <select name="aws_region" value={form.aws_region} onChange={handleChange} style={{ ...inputStyle, cursor: 'pointer' }}>
                {AWS_REGIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Access Key ID</label>
              <input
                name="access_key_id" value={form.access_key_id} onChange={handleChange}
                placeholder="AKIAIOSFODNN7EXAMPLE" autoComplete="off"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 16, position: 'relative' }}>
              <label style={labelStyle}>Secret Access Key</label>
              <input
                name="secret_access_key" value={form.secret_access_key} onChange={handleChange}
                type={showSecret ? 'text' : 'password'}
                placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                autoComplete="new-password"
                style={{ ...inputStyle, paddingRight: 44 }}
              />
              <button
                type="button"
                onClick={() => setShowSecret(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: 26,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: c.fg3, fontSize: 16, padding: 2,
                }}
              >
                {showSecret ? '🙈' : '👁'}
              </button>
            </div>

            {error && (
              <div style={{ background: '#ef44441a', border: '1px solid #ef444466', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#f87171', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                ❌ {error}
              </div>
            )}
            {success && (
              <div style={{ background: '#16a34a1a', border: '1px solid #16a34a66', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: '#4ade80' }}>
                ✅ {success}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button" onClick={onClose}
                style={{ background: 'transparent', border: `1px solid ${c.bd}`, color: c.fg2, borderRadius: 6, padding: '7px 18px', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                type="submit" disabled={saving}
                style={{ background: c.accent, border: 'none', color: '#fff', borderRadius: 6, padding: '7px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}
              >
                {saving ? '⏳ Verifying & Saving…' : existing ? '🔄 Update Credentials' : '💾 Save Credentials'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
