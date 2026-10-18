import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import API from '../api/client';

const PASSWORD_MIN = 8;

// ── Tiny spinner (matches Login.jsx style) ────────────────────────────────────
function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 16, height: 16,
      border: '2px solid rgba(255,255,255,0.3)',
      borderTopColor: '#fff', borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }} />
  );
}

// ── Password strength bar ─────────────────────────────────────────────────────
function StrengthBar({ password }) {
  const checks = [
    password.length >= PASSWORD_MIN,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = checks.filter(Boolean).length;
  const label = ['', 'Weak', 'Fair', 'Good', 'Strong'][score];
  const colors = ['#E5E7EB', '#EF4444', '#F59E0B', '#3B82F6', '#10B981'];
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 99,
            background: i <= score ? colors[score] : '#E5E7EB',
            transition: 'background 0.25s',
          }} />
        ))}
      </div>
      {password && (
        <p style={{ margin: 0, fontSize: 11, color: colors[score], fontWeight: 600 }}>{label}</p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ResetPassword() {
  const [searchParams]    = useSearchParams();
  const nav               = useNavigate();
  const token             = searchParams.get('token') || '';

  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass,        setShowPass]        = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState('');
  const [done,            setDone]            = useState(false);
  const [countdown,       setCountdown]       = useState(5);

  const passRef = useRef(null);
  useEffect(() => { passRef.current?.focus(); }, []);

  // Auto-redirect after success
  useEffect(() => {
    if (!done) return;
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); nav('/login'); }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [done, nav]);

  // ── Missing token guard ────────────────────────────────────────────────────
  if (!token) {
    return (
      <PageShell>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <h2 style={headingStyle}>Invalid reset link</h2>
          <p style={subStyle}>
            This link is missing a reset token. Please request a new one from the login page.
          </p>
          <NavButton onClick={() => nav('/login')}>Back to Sign In</NavButton>
        </div>
      </PageShell>
    );
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await API.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const msg = err.response?.data?.error || 'Something went wrong. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // ── Success state ──────────────────────────────────────────────────────────
  if (done) {
    return (
      <PageShell>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h2 style={headingStyle}>Password updated!</h2>
          <p style={subStyle}>
            Your password has been changed successfully. You'll be redirected to the sign-in
            page in <strong>{countdown}s</strong>.
          </p>
          <NavButton onClick={() => nav('/login')}>Sign In Now</NavButton>
        </div>
      </PageShell>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <PageShell>
      <h2 style={{ ...headingStyle, marginBottom: 4 }}>Choose a new password</h2>
      <p style={{ ...subStyle, marginBottom: 28 }}>
        Must be at least {PASSWORD_MIN} characters.
      </p>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* New password */}
        <div>
          <label style={labelStyle}>New Password</label>
          <div style={{ position: 'relative' }}>
            <input
              ref={passRef}
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              placeholder="Min 8 characters"
              autoComplete="new-password"
              disabled={loading}
              style={{ ...inputStyle(loading), paddingRight: 44 }}
            />
            <EyeToggle show={showPass} onToggle={() => setShowPass(s => !s)} />
          </div>
          <StrengthBar password={password} />
        </div>

        {/* Confirm password */}
        <div>
          <label style={labelStyle}>Confirm Password</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showConfirm ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
              placeholder="Re-enter your password"
              autoComplete="new-password"
              disabled={loading}
              style={{ ...inputStyle(loading), paddingRight: 44 }}
            />
            <EyeToggle show={showConfirm} onToggle={() => setShowConfirm(s => !s)} />
          </div>
          {confirmPassword && password !== confirmPassword && (
            <p style={fieldErrStyle}>Passwords do not match</p>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div role="alert" style={{
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: 8, padding: '10px 14px',
            fontSize: 13, color: '#B91C1C', display: 'flex', gap: 8, alignItems: 'flex-start',
          }}>
            <span>⚠</span> {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !password || !confirmPassword}
          style={{
            width: '100%', padding: '13px', borderRadius: 11, border: 'none',
            background: (loading || !password || !confirmPassword)
              ? '#E5E7EB'
              : 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
            color: (loading || !password || !confirmPassword) ? '#9CA3AF' : '#fff',
            fontSize: 14, fontWeight: 800,
            cursor: (loading || !password || !confirmPassword) ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'background 0.2s',
          }}
        >
          {loading ? <><Spinner /> Updating password…</> : 'Set new password'}
        </button>

        {/* Back link */}
        <button
          type="button"
          onClick={() => nav('/login')}
          style={{
            background: 'none', border: 'none', color: '#6B7280',
            fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0,
            textDecoration: 'underline', textUnderlineOffset: 2,
          }}
        >
          ← Back to Sign In
        </button>
      </form>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </PageShell>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function PageShell({ children }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 50%, #0F172A 100%)',
      padding: '24px 16px',
    }}>
      <div style={{
        background: '#ffffff', borderRadius: 20, padding: '40px 36px',
        width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        animation: 'fadeIn 0.25s ease',
      }}>
        {/* Brand mark */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <span style={{
            display: 'inline-block', padding: '8px 18px', borderRadius: 10,
            background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
            fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: '-0.3px',
          }}>
            🔐 TFGen
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function EyeToggle({ show, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      style={{
        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
        background: 'none', border: 'none', cursor: 'pointer',
        color: '#9CA3AF', fontSize: 18, padding: 0, lineHeight: 1,
      }}
      aria-label={show ? 'Hide password' : 'Show password'}
    >
      {show ? '🙈' : '👁'}
    </button>
  );
}

function NavButton({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginTop: 24, padding: '11px 28px', borderRadius: 10, border: 'none',
        background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
        color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const headingStyle = {
  margin: '0 0 8px', fontSize: 22, fontWeight: 800, color: '#111827',
};
const subStyle = {
  margin: '0 0 8px', fontSize: 14, color: '#6B7280', lineHeight: 1.6,
};
const labelStyle = {
  display: 'block', marginBottom: 6, fontSize: 12,
  fontWeight: 700, color: '#374151', letterSpacing: '0.03em',
};
const fieldErrStyle = {
  margin: '4px 0 0', fontSize: 12, color: '#EF4444', fontWeight: 500,
};
const inputStyle = (disabled) => ({
  width: '100%', background: disabled ? '#F9FAFB' : '#FFFFFF',
  border: '1px solid #D1D9E6', borderRadius: 10,
  padding: '12px 14px', color: '#1A2340', fontSize: 14,
  outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  transition: 'border-color 0.15s, box-shadow 0.15s',
  cursor: disabled ? 'not-allowed' : 'text',
});
