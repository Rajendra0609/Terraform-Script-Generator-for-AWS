import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import API from '../api/client';
import { APP_VERSION } from '../version';

const FEATURES = [
  { icon: '🕸️', label: 'Visual graph builder',   sub: '44+ AWS services, drag & connect' },
  { icon: '🏗️', label: 'Architecture patterns',   sub: '8 production-ready templates' },
  { icon: '🛡️', label: 'Security scanning',       sub: 'IAM generator + Checkov integration' },
  { icon: '💰', label: 'Cost estimation',          sub: 'Real-time Infracost analysis' },
  { icon: '🧪', label: 'Scenario labs',            sub: '5 guided exercises with progress tracking' },
  { icon: '🎓', label: 'Learn mode',               sub: 'Interview Q&A + HCL explainer' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimum strength score to allow register submit (45 % = "Fair")
const MIN_REGISTER_STRENGTH_PCT = 45;

// ─── Spinner ─────────────────────────────────────────────────────────────────
function Spinner({ size = 16, color = '#FFFFFF' }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" fill="none" strokeOpacity="0.25" />
      <path d="M12 2 a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─── Eye icon (SVG so no emoji rendering quirks) ─────────────────────────────
function EyeIcon({ open }) {
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// FE-11 fix: accept initialMode so /register opens directly on "Create Account".
// ─── OAuthButton ─────────────────────────────────────────────────────────────
function OAuthButton({ href, icon, label, bg, border, color, disabled }) {
  return (
    <a
      href={disabled ? undefined : href}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '11px 16px', borderRadius: 10, border: `1px solid ${border}`,
        background: disabled ? '#F3F4F6' : bg,
        color: disabled ? '#9CA3AF' : color,
        fontSize: 13, fontWeight: 600,
        textDecoration: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'box-shadow 0.15s, transform 0.1s',
        userSelect: 'none',
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {icon}
      {label}
    </a>
  );
}

export default function Login({ initialMode = 'login' }) {
  const [mode,            setMode]            = useState(initialMode);
  const [email,           setEmail]           = useState('');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error,           setError]           = useState('');
  const [fieldErrors,     setFieldErrors]     = useState({});
  const [loading,         setLoading]         = useState(false);
  const [authStage,       setAuthStage]       = useState('idle');   // idle | validating | authenticating | finishing

  // ── Feature 1: separate show/hide per field ────────────────────────────────
  const [showPassword,        setShowPassword]        = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // ── Feature 6: forgot-password flow ───────────────────────────────────────
  const [forgotMode,        setForgotMode]        = useState(false);
  const [forgotEmail,       setForgotEmail]       = useState('');
  const [forgotSent,        setForgotSent]        = useState(false);
  const [forgotLoading,     setForgotLoading]     = useState(false);
  const [forgotError,       setForgotError]       = useState('');

  // ── Feature 7: terms checkbox ─────────────────────────────────────────────
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [capsLock, setCapsLock] = useState(false);
  const [touched,  setTouched]  = useState({});

  const { login, register } = useAuth();
  const nav      = useNavigate();
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current?.focus(); }, [mode, forgotMode]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setError(''); setForgotMode(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Switch mode: reset everything ────────────────────────────────────────
  function switchMode(m) {
    setMode(m);
    setError(''); setFieldErrors({}); setTouched({});
    setConfirmPassword(''); setAuthStage('idle');
    setShowPassword(false); setShowConfirmPassword(false);
    setTermsAccepted(false);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const validateField = (name, value) => {
    if (name === 'email') {
      if (!value) return 'Email is required';
      if (!EMAIL_RE.test(value)) return 'Enter a valid email address';
    }
    if (name === 'password') {
      if (!value) return 'Password is required';
      if (mode === 'register' && value.length < 8) return 'Minimum 8 characters required';
    }
    if (name === 'confirmPassword') {
      if (mode !== 'register') return '';
      if (!value) return 'Please confirm your password';
      if (value !== password) return 'Passwords do not match';
    }
    return '';
  };

  // ── Password strength ─────────────────────────────────────────────────────
  const passwordChecks = useMemo(() => {
    const v = password || '';
    const hasLower  = /[a-z]/.test(v);
    const hasUpper  = /[A-Z]/.test(v);
    const hasNumber = /\d/.test(v);
    const hasSymbol = /[^A-Za-z0-9]/.test(v);
    const lengthOk  = v.length >= 8;

    const checklist = [
      { key: 'length', label: '8+ characters',     ok: lengthOk },
      { key: 'upper',  label: 'Uppercase',          ok: hasUpper },
      { key: 'lower',  label: 'Lowercase',          ok: hasLower },
      { key: 'number', label: 'Number',             ok: hasNumber },
      { key: 'symbol', label: 'Symbol (!@#…)',      ok: hasSymbol },
    ];

    const score      = [hasLower, hasUpper, hasNumber, hasSymbol].filter(Boolean).length + (lengthOk ? 1 : 0);
    const normalized = Math.max(0, Math.min(5, score));

    const strength = !v
      ? { label: 'Enter a password',  color: '#9CA3AF', pct: 0 }
      : normalized <= 2
        ? { label: 'Weak — add number + symbol', color: '#EF4444', pct: 20 }
        : normalized === 3
          ? { label: 'Fair — add a symbol',       color: '#F59E0B', pct: 45 }
          : normalized === 4
            ? { label: 'Good',                     color: '#10B981', pct: 70 }
            : { label: 'Strong ✓',                 color: '#00A87C', pct: 100 };

    // Hint text for what's still missing
    const missing = [];
    if (!hasNumber) missing.push('a number');
    if (!hasSymbol) missing.push('a symbol');
    const hint = v && missing.length && normalized < 4
      ? `Tip: Add ${missing.join(' and ')} to strengthen`
      : '';

    return { checklist, strength, lengthOk, hint };
  }, [password]);

  // ── Live error derivations ────────────────────────────────────────────────
  const emailErrLive = useMemo(() => {
    if (!email) return 'Email is required';
    if (!EMAIL_RE.test(email)) return 'Enter a valid email address';
    return '';
  }, [email]);

  const passwordErrLive = useMemo(() => {
    if (!password) return 'Password is required';
    if (mode === 'register' && password.length < 8) return 'Minimum 8 characters required';
    return '';
  }, [password, mode]);

  const confirmPasswordErrLive = useMemo(() => {
    if (mode !== 'register') return '';
    if (!confirmPassword) return 'Please confirm your password';
    if (confirmPassword !== password) return 'Passwords do not match';
    return '';
  }, [confirmPassword, mode, password]);

  // ── Feature 2: real-time match indicator ─────────────────────────────────
  const matchIndicator = useMemo(() => {
    if (mode !== 'register' || !confirmPassword) return null;
    const match = confirmPassword === password;
    return {
      ok:    match,
      label: match ? 'Passwords match' : 'Passwords don\'t match',
      color: match ? '#10B981' : '#EF4444',
    };
  }, [confirmPassword, password, mode]);

  // ── Feature 5: canSubmit — strength-gated for register ───────────────────
  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (!email || !password) return false;
    if (emailErrLive) return false;
    if (passwordErrLive) return false;
    if (mode === 'register') {
      if (confirmPasswordErrLive) return false;
      if (!confirmPassword) return false;
      if (!termsAccepted) return false;                                       // Feature 7
      if (passwordChecks.strength.pct < MIN_REGISTER_STRENGTH_PCT) return false; // Feature 5
    }
    return true;
  }, [loading, email, password, emailErrLive, passwordErrLive,
      confirmPasswordErrLive, confirmPassword, mode, termsAccepted, passwordChecks]);

  const handleBlur = (name, value) => {
    setTouched(t => ({ ...t, [name]: true }));
    setFieldErrors(fe => ({ ...fe, [name]: validateField(name, value) }));
  };

  const handleKeyDown = (e) => {
    setCapsLock(e.getModifierState?.('CapsLock') ?? false);
  };

  // ── Feature 4: backend error → field mapping ──────────────────────────────
  const mapBackendErrorToFields = (err) => {
    const msg   = err?.response?.data?.error || err?.message || '';
    const lower = String(msg).toLowerCase();
    const next  = {};

    if (lower.includes('email') || (lower.includes('user') && (lower.includes('not') || lower.includes('found') || lower.includes('exist')))) {
      next.email = msg;
    }
    if (lower.includes('password') || lower.includes('credential') || lower.includes('auth')) {
      next.password = msg;
    }
    // Feature 4: map mismatch/confirm errors specifically to confirmPassword field
    if (lower.includes('mismatch') || lower.includes('confirm') || lower.includes('do not match') || lower.includes("don't match")) {
      next.confirmPassword = msg;
      delete next.password;
    }

    return (next.email || next.password || next.confirmPassword) ? next : null;
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setAuthStage('validating');

    const emailErr   = validateField('email', email);
    const passErr    = validateField('password', password);
    const confirmErr = validateField('confirmPassword', confirmPassword);

    if (emailErr || passErr || confirmErr) {
      setFieldErrors({ email: emailErr, password: passErr, confirmPassword: confirmErr });
      setTouched({ email: true, password: true, confirmPassword: true });
      setAuthStage('idle');
      return;
    }

    setLoading(true);
    setAuthStage('authenticating');

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
      setAuthStage('finishing');
      nav('/dashboard');
    } catch (err) {
      const mapped = mapBackendErrorToFields(err);
      if (mapped) {
        setFieldErrors(prev => ({ ...prev, ...mapped }));
        setTouched({ email: true, password: true, confirmPassword: true });
      }
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
      setAuthStage('idle');
    } finally {
      setLoading(false);
      if (authStage !== 'finishing') setAuthStage('idle');
    }
  };

  // ── Feature 6: forgot password submit ────────────────────────────────────
  const submitForgot = async (e) => {
    e.preventDefault();
    if (!forgotEmail || !EMAIL_RE.test(forgotEmail)) {
      setForgotError('Enter a valid email address');
      return;
    }
    setForgotLoading(true);
    setForgotError('');
    try {
      await API.post('/api/auth/forgot-password', { email: forgotEmail });
      setForgotSent(true);
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        // Endpoint not yet wired — show a polite pending message
        setForgotError('Password reset is not yet enabled on this server. Contact your admin.');
      } else {
        setForgotError(err.response?.data?.error || 'Could not send reset link. Try again.');
      }
    } finally {
      setForgotLoading(false);
    }
  };

  // ── Demo login ────────────────────────────────────────────────────────────
  const fillDemo = async () => {
    const demoEmail = 'demo@tfgen.io';
    const demoPass  = 'demo1234';
    setEmail(demoEmail);
    setPassword(demoPass);
    setFieldErrors({});
    setError('');
    setLoading(true);
    try {
      await login(demoEmail, demoPass);
      nav('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Demo login failed — the demo account may not exist on this server.');
    } finally {
      setLoading(false);
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const inputBase = {
    width: '100%', background: loading ? '#F9FAFB' : '#FFFFFF',
    border: '1px solid #D1D9E6', borderRadius: 10,
    padding: '12px 14px', color: '#1A2340', fontSize: 14,
    outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    cursor: loading ? 'not-allowed' : 'text',
  };
  const inputErrorStyle = { ...inputBase, borderColor: '#E53E52', boxShadow: '0 0 0 3px rgba(229,62,82,0.10)' };
  const labelStyle      = { fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 };
  const fieldErrStyle   = { fontSize: 12, color: '#E53E52', marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 };
  const eyeBtnStyle     = {
    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer',
    padding: '2px 4px', borderRadius: 4, lineHeight: 1, transition: 'color 0.15s',
    display: 'flex', alignItems: 'center',
  };

  // ─────────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', background: '#F7F9FC',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
      overflow: 'hidden', position: 'relative',
    }}>
      {/* CSS keyframes */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .login-left-panel { display: flex; }
        .login-right-panel { display: flex; }
        @media (max-width: 900px) {
          .login-left-panel  { display: none !important; }
          .login-right-panel { width: 100% !important; padding: 24px !important; }
        }
      `}</style>

      {/* Subtle background decoration */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', top: '-15%', left: '-8%', width: '50%', height: '65%', background: 'radial-gradient(ellipse, rgba(0,168,124,0.06) 0%, transparent 65%)', filter: 'blur(2px)' }} />
        <div style={{ position: 'absolute', bottom: '-15%', right: '-8%', width: '45%', height: '55%', background: 'radial-gradient(ellipse, rgba(37,99,235,0.05) 0%, transparent 65%)' }} />
      </div>

      {/* ── Left panel ─────────────────────────────────────────────────────── */}
      <div
        className="login-left-panel"
        style={{ flex: 1, flexDirection: 'column', justifyContent: 'center', padding: '60px 72px', position: 'relative', zIndex: 1 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 56 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 14,
            background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 900, color: '#FFFFFF',
            boxShadow: '0 4px 20px rgba(0,168,124,0.25)',
          }}>✦</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.03em' }}>TFGen</div>
            <div style={{ fontSize: 10, color: '#6B7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Terraform Studio</div>
          </div>
        </div>

        <h1 style={{ fontSize: 40, fontWeight: 900, color: '#111827', letterSpacing: '-0.04em', lineHeight: 1.15, margin: '0 0 16px' }}>
          Infrastructure as Code,<br />
          <span style={{ background: 'linear-gradient(135deg, #00A87C 20%, #2563EB 80%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>without the YAML</span>
        </h1>
        <p style={{ fontSize: 16, color: '#4B5563', lineHeight: 1.7, maxWidth: 400, margin: '0 0 48px' }}>
          Drag, connect, and configure AWS resources visually. Export clean, validated Terraform HCL in seconds.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 28px', maxWidth: 500 }}>
          {FEATURES.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: '#EEF7F3', border: '1px solid #D1E9DF',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
              }}>{f.icon}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1F2937', marginBottom: 2 }}>{f.label}</div>
                <div style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.4 }}>{f.sub}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#00A87C', boxShadow: '0 0 6px rgba(0,168,124,0.5)' }} />
          <span style={{ fontSize: 12, color: '#6B7280', fontWeight: 600 }}>
            {APP_VERSION} — {process.env.REACT_APP_APP_ENV || 'development'} ready
          </span>
        </div>
      </div>

      {/* ── Right panel ────────────────────────────────────────────────────── */}
      <div
        className="login-right-panel"
        style={{ width: 480, alignItems: 'center', justifyContent: 'center', padding: '40px 44px', position: 'relative', zIndex: 1 }}
      >
        <div style={{
          width: '100%', background: '#FFFFFF',
          border: '1px solid #E5E7EB', borderRadius: 20,
          padding: '40px 36px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
        }}>

          {/* ── Feature 6: Forgot Password view ──────────────────────────── */}
          {forgotMode ? (
            <div style={{ animation: 'fadeIn 0.2s ease' }}>
              <button
                onClick={() => { setForgotMode(false); setForgotSent(false); setForgotError(''); setForgotEmail(''); }}
                style={{ background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: '0 0 20px', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                ← Back to sign in
              </button>

              {forgotSent ? (
                <div style={{ textAlign: 'center', padding: '16px 0' }}>
                  <div style={{ fontSize: 40, marginBottom: 16 }}>📬</div>
                  <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800, color: '#111827' }}>Check your inbox</h2>
                  <p style={{ margin: 0, fontSize: 14, color: '#6B7280', lineHeight: 1.6 }}>
                    If <strong>{forgotEmail}</strong> is registered, you'll receive a password reset link shortly.
                  </p>
                  <button
                    onClick={() => { setForgotMode(false); setForgotSent(false); setForgotEmail(''); }}
                    style={{ marginTop: 24, padding: '10px 20px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Back to Sign In
                  </button>
                </div>
              ) : (
                <>
                  <h2 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 800, color: '#111827' }}>Forgot password?</h2>
                  <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6B7280' }}>Enter your email and we'll send a reset link.</p>

                  <form onSubmit={submitForgot} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                      <label style={labelStyle}>Email Address</label>
                      <input
                        ref={emailRef}
                        type="email"
                        value={forgotEmail}
                        onChange={e => { setForgotEmail(e.target.value); setForgotError(''); }}
                        placeholder="you@company.com"
                        autoComplete="email"
                        disabled={forgotLoading}
                        style={{ ...inputBase, cursor: forgotLoading ? 'not-allowed' : 'text' }}
                        onFocus={e => { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; }}
                        onBlurCapture={e => { e.target.style.borderColor = '#D1D9E6'; e.target.style.boxShadow = 'none'; }}
                      />
                      {forgotError && (
                        <div role="alert" style={fieldErrStyle}><span>⚠</span> {forgotError}</div>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={forgotLoading || !forgotEmail}
                      style={{
                        width: '100%', padding: '13px', borderRadius: 11, border: 'none',
                        background: (!forgotEmail || forgotLoading) ? '#E5E7EB' : 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
                        color: (!forgotEmail || forgotLoading) ? '#9CA3AF' : '#fff',
                        fontSize: 14, fontWeight: 800, cursor: forgotLoading ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      }}
                    >
                      {forgotLoading ? <><Spinner /> Sending…</> : 'Send reset link'}
                    </button>
                  </form>
                </>
              )}
            </div>
          ) : (
            /* ── Normal login / register view ──────────────────────────── */
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', background: '#F3F4F6', borderRadius: 11, padding: 4, marginBottom: 28, gap: 2 }} role="tablist">
                {['login', 'register'].map(m => (
                  <button key={m}
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => switchMode(m)}
                    disabled={loading}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      background: mode === m ? '#FFFFFF' : 'transparent',
                      color: mode === m ? '#111827' : '#6B7280',
                      fontSize: 13, fontWeight: 700,
                      transition: 'all 0.18s',
                      boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                    }}>
                    {m === 'login' ? 'Sign In' : 'Create Account'}
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: 24 }}>
                <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.03em' }}>
                  {mode === 'login' ? 'Welcome back' : 'Get started free'}
                </h2>
                <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6B7280' }}>
                  {mode === 'login' ? 'Sign in to your TFGen workspace' : 'Create your Terraform Studio account'}
                </p>

                {/* ── Feature 8: auth stage indicator ─────────────────── */}
                {authStage !== 'idle' && (
                  <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, color: '#6B7280', fontSize: 13, animation: 'fadeIn 0.2s ease' }}>
                    <Spinner size={18} color="#2563EB" />
                    <span>
                      {authStage === 'validating'     && 'Validating your inputs…'}
                      {authStage === 'authenticating' && (mode === 'login' ? 'Authenticating…' : 'Creating your account…')}
                      {authStage === 'finishing'      && 'Finalizing session…'}
                    </span>
                  </div>
                )}
              </div>

              <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

                {/* ── Email ────────────────────────────────────────────── */}
                <div>
                  <label htmlFor="login-email" style={labelStyle}>Email Address</label>
                  <input
                    ref={emailRef}
                    id="login-email"
                    type="email"
                    value={email}
                    disabled={loading}
                    onChange={e => {
                      const v = e.target.value;
                      setEmail(v);
                      if (touched.email) setFieldErrors(fe => ({ ...fe, email: validateField('email', v) }));
                      if (error) setError('');
                    }}
                    onBlur={() => handleBlur('email', email)}
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                    aria-invalid={!!fieldErrors.email}
                    aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                    style={touched.email && fieldErrors.email ? inputErrorStyle : inputBase}
                    onFocus={e => { if (!fieldErrors.email) { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; } }}
                    onBlurCapture={e => { if (!fieldErrors.email) { e.target.style.borderColor = '#D1D9E6'; e.target.style.boxShadow = 'none'; } }}
                  />
                  {touched.email && fieldErrors.email && (
                    <div id="email-error" role="alert" style={fieldErrStyle}><span>⚠</span> {fieldErrors.email}</div>
                  )}
                </div>

                {/* ── Password ─────────────────────────────────────────── */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label htmlFor="login-password" style={{ ...labelStyle, marginBottom: 0 }}>Password</label>
                    {/* ── Feature 6: Forgot password link (login only) ── */}
                    {mode === 'login' && (
                      <button
                        type="button"
                        onClick={() => { setForgotMode(true); setForgotEmail(email); }}
                        style={{ background: 'none', border: 'none', color: '#2563EB', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>

                  <div style={{ position: 'relative' }}>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      disabled={loading}
                      onChange={e => {
                        const v = e.target.value;
                        setPassword(v);
                        if (touched.password) setFieldErrors(fe => ({ ...fe, password: validateField('password', v) }));
                        if (touched.confirmPassword) setFieldErrors(fe => ({ ...fe, confirmPassword: validateField('confirmPassword', confirmPassword) }));
                        if (error) setError('');
                      }}
                      onBlur={() => handleBlur('password', password)}
                      onKeyDown={handleKeyDown}
                      required
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      placeholder={mode === 'register' ? 'Min 8 characters' : '••••••••'}
                      aria-invalid={!!fieldErrors.password}
                      aria-describedby={fieldErrors.password ? 'password-error' : 'password-strength'}
                      style={{ ...(touched.password && fieldErrors.password ? inputErrorStyle : inputBase), paddingRight: 44 }}
                      onFocus={e => { if (!fieldErrors.password) { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; } }}
                      onBlurCapture={e => { if (!fieldErrors.password) { e.target.style.borderColor = '#D1D9E6'; e.target.style.boxShadow = 'none'; } }}
                    />
                    {/* ── Feature 1: separate eye for Password field ──── */}
                    <button
                      type="button"
                      onClick={() => setShowPassword(s => !s)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      style={eyeBtnStyle}
                      onMouseEnter={e => { e.currentTarget.style.color = '#374151'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; }}
                    >
                      <EyeIcon open={showPassword} />
                    </button>
                  </div>

                  {/* ── Feature 3: strength bar + checklist (register only) */}
                  <div id="password-strength" style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 700 }}>
                        Strength:{' '}
                        <span style={{ color: passwordChecks.strength.color }}>{passwordChecks.strength.label}</span>
                      </div>
                      {mode === 'register' && passwordChecks.lengthOk && passwordChecks.strength.pct >= 100 && (
                        <div style={{ fontSize: 12, color: '#10B981', fontWeight: 800 }}>✓ Policy met</div>
                      )}
                    </div>

                    {/* Strength bar */}
                    <div style={{ height: 6, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden', marginTop: 7, transition: 'all 0.3s' }}>
                      <div style={{
                        height: '100%', width: `${passwordChecks.strength.pct}%`,
                        background: passwordChecks.strength.color,
                        borderRadius: 999, transition: 'width 0.35s ease, background 0.35s ease',
                      }} />
                    </div>

                    {/* ── Feature 3: checklist (register only) ── */}
                    {mode === 'register' && password && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9, animation: 'fadeIn 0.2s ease' }}>
                        {passwordChecks.checklist.map(c => (
                          <div key={c.key} style={{
                            fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                            color: c.ok ? '#10B981' : '#6B7280',
                            background: c.ok ? 'rgba(16,185,129,0.08)' : '#F3F4F6',
                            borderRadius: 6, padding: '3px 8px',
                            border: `1px solid ${c.ok ? 'rgba(16,185,129,0.20)' : '#E5E7EB'}`,
                            transition: 'all 0.2s',
                          }}>
                            <span>{c.ok ? '✓' : '·'}</span>
                            {c.label}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Hint text */}
                    {mode === 'register' && passwordChecks.hint && (
                      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 6, fontStyle: 'italic' }}>
                        💡 {passwordChecks.hint}
                      </div>
                    )}
                  </div>

                  {touched.password && fieldErrors.password && (
                    <div id="password-error" role="alert" style={fieldErrStyle}><span>⚠</span> {fieldErrors.password}</div>
                  )}
                  {capsLock && (
                    <div style={{ fontSize: 12, color: '#D97706', marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>⇪</span> Caps Lock is on
                    </div>
                  )}
                </div>

                {/* ── Confirm Password (register only) ─────────────────── */}
                {mode === 'register' && (
                  <div>
                    <label htmlFor="login-confirm-password" style={labelStyle}>Confirm Password</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        id="login-confirm-password"
                        // ── Feature 1: uses showConfirmPassword, not showPassword ──
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        disabled={loading}
                        onChange={e => {
                          const v = e.target.value;
                          setConfirmPassword(v);
                          if (touched.confirmPassword) setFieldErrors(fe => ({ ...fe, confirmPassword: validateField('confirmPassword', v) }));
                          if (error) setError('');
                        }}
                        onBlur={() => handleBlur('confirmPassword', confirmPassword)}
                        required
                        autoComplete="new-password"
                        placeholder="Re-enter password"
                        aria-invalid={!!fieldErrors.confirmPassword}
                        aria-describedby={fieldErrors.confirmPassword ? 'confirm-password-error' : 'confirm-match'}
                        style={{
                          ...(touched.confirmPassword && fieldErrors.confirmPassword ? inputErrorStyle : inputBase),
                          // green border when matching
                          ...(matchIndicator?.ok && !fieldErrors.confirmPassword
                            ? { borderColor: '#10B981', boxShadow: '0 0 0 3px rgba(16,185,129,0.10)' }
                            : {}),
                          paddingRight: 44,
                        }}
                        onFocus={e => {
                          if (!fieldErrors.confirmPassword && !matchIndicator?.ok) {
                            e.target.style.borderColor = '#00A87C';
                            e.target.style.boxShadow   = '0 0 0 3px rgba(0,168,124,0.10)';
                          }
                        }}
                        onBlurCapture={e => {
                          if (!fieldErrors.confirmPassword && !matchIndicator?.ok) {
                            e.target.style.borderColor = '#D1D9E6';
                            e.target.style.boxShadow   = 'none';
                          }
                        }}
                      />
                      {/* ── Feature 1: separate eye for Confirm Password ── */}
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(s => !s)}
                        aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                        style={eyeBtnStyle}
                        onMouseEnter={e => { e.currentTarget.style.color = '#374151'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; }}
                      >
                        <EyeIcon open={showConfirmPassword} />
                      </button>
                    </div>

                    {/* ── Feature 2: real-time match indicator ──────────── */}
                    {matchIndicator && (
                      <div id="confirm-match" style={{
                        fontSize: 12, fontWeight: 700, marginTop: 6,
                        display: 'flex', alignItems: 'center', gap: 5,
                        color: matchIndicator.color,
                        animation: 'fadeIn 0.15s ease',
                      }}>
                        <span>{matchIndicator.ok ? '✅' : '❌'}</span>
                        {matchIndicator.label}
                      </div>
                    )}

                    {/* Field-level error (only if no match indicator or field untouched with mismatch) */}
                    {touched.confirmPassword && fieldErrors.confirmPassword && !matchIndicator && (
                      <div id="confirm-password-error" role="alert" style={fieldErrStyle}>
                        <span>⚠</span> {fieldErrors.confirmPassword}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Feature 7: Terms & Privacy checkbox (register only) ── */}
                {mode === 'register' && (
                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, cursor: loading ? 'not-allowed' : 'pointer',
                    fontSize: 13, color: '#374151', lineHeight: 1.5, userSelect: 'none',
                  }}>
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      disabled={loading}
                      onChange={e => setTermsAccepted(e.target.checked)}
                      style={{ marginTop: 2, accentColor: '#00A87C', width: 15, height: 15, flexShrink: 0, cursor: loading ? 'not-allowed' : 'pointer' }}
                    />
                    <span>
                      I agree to the{' '}
                      <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#2563EB', textDecoration: 'underline', textUnderlineOffset: 2 }}>Terms of Service</a>
                      {' '}and{' '}
                      <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#2563EB', textDecoration: 'underline', textUnderlineOffset: 2 }}>Privacy Policy</a>
                    </span>
                  </label>
                )}

                {/* Banner error */}
                {error && (
                  <div role="alert" style={{
                    background: '#FEF2F2', border: '1px solid #FECACA',
                    borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#DC2626',
                    display: 'flex', alignItems: 'flex-start', gap: 8, animation: 'fadeIn 0.2s ease',
                  }}>
                    <span style={{ flexShrink: 0, marginTop: 1 }}>⚠</span><span>{error}</span>
                  </div>
                )}

                {/* ── Feature 8: Submit button with spinner ─────────────── */}
                <button
                  type="submit"
                  disabled={!canSubmit}
                  style={{
                    width: '100%', padding: '13px', borderRadius: 11, border: 'none',
                    cursor: !canSubmit ? 'not-allowed' : 'pointer',
                    background: !canSubmit ? '#E5E7EB' : 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
                    color: !canSubmit ? '#9CA3AF' : '#FFFFFF',
                    fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em',
                    transition: 'all 0.18s', marginTop: 4,
                    boxShadow: !canSubmit ? 'none' : '0 4px 16px rgba(0,168,124,0.20)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                  onMouseEnter={e => { if (canSubmit) { e.currentTarget.style.boxShadow = '0 6px 24px rgba(0,168,124,0.30)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                  onMouseLeave={e => { if (canSubmit) { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,168,124,0.20)'; e.currentTarget.style.transform = 'translateY(0)'; } }}
                >
                  {loading
                    ? <><Spinner />{mode === 'login' ? 'Signing in…' : 'Creating account…'}</>
                    : (mode === 'login' ? 'Sign In →' : 'Create Account →')
                  }
                </button>
              </form>

              {/* OR divider */}
              <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
                <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>OR</span>
                <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
              </div>

              {/* Phase 3: OAuth / SSO buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                <OAuthButton
                  href="/api/auth/oauth/google"
                  disabled={loading}
                  icon={
                    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                  }
                  label="Continue with Google"
                  bg="#FFFFFF"
                  border="#D1D5DB"
                  color="#374151"
                />
                <OAuthButton
                  href="/api/auth/oauth/github"
                  disabled={loading}
                  icon={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
                    </svg>
                  }
                  label="Continue with GitHub"
                  bg="#24292E"
                  border="#24292E"
                  color="#FFFFFF"
                />
              </div>

              {/* Second OR divider before demo */}
              <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
                <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>or use demo</span>
                <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
              </div>

              {/* Demo button */}
              <button
                onClick={fillDemo}
                disabled={loading}
                style={{
                  width: '100%', marginTop: 14, padding: '11px', borderRadius: 10,
                  border: '1px solid #D1E9DF', background: '#F0FDF7',
                  color: '#00A87C', fontSize: 13, fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.15s',
                  opacity: loading ? 0.6 : 1,
                }}
                onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = '#DCFCE7'; e.currentTarget.style.borderColor = '#86EFAC'; } }}
                onMouseLeave={e => { e.currentTarget.style.background = '#F0FDF7'; e.currentTarget.style.borderColor = '#D1E9DF'; }}
              >
                ⚡ Try with demo credentials
              </button>

              <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>
                {mode === 'login'
                  ? <span>No account yet?{' '}
                      <button
                        onClick={() => switchMode('register')}
                        disabled={loading}
                        style={{ background: 'none', border: 'none', color: '#00A87C', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
                      >Create one free →</button>
                    </span>
                  : <span>Already have an account?{' '}
                      <button
                        onClick={() => switchMode('login')}
                        disabled={loading}
                        style={{ background: 'none', border: 'none', color: '#00A87C', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
                      >Sign in →</button>
                    </span>
                }
              </p>

              <div style={{ marginTop: 20, textAlign: 'center', fontSize: 11, color: '#9CA3AF', lineHeight: 1.6 }}>
                <span>🔒 Your data is encrypted and securely stored</span>
                <div style={{ marginTop: 6, fontSize: 10, color: '#9CA3AF' }}>
                  © {new Date().getFullYear()} TFGen. All rights reserved.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
