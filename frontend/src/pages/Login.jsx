import React, { useState, useEffect, useRef, useMemo } from 'react';

import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const FEATURES = [
  { icon: '🕸️', label: 'Visual graph builder', sub: '44+ AWS services, drag & connect' },
  { icon: '🏗️', label: 'Architecture patterns', sub: '8 production-ready templates' },
  { icon: '🛡️', label: 'Security scanning', sub: 'IAM generator + Checkov integration' },
  { icon: '💰', label: 'Cost estimation', sub: 'Real-time Infracost analysis' },
  { icon: '🧪', label: 'Scenario labs', sub: '5 guided exercises with progress tracking' },
  { icon: '🎓', label: 'Learn mode', sub: 'Interview Q&A + HCL explainer' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// FE-11 fix: accept initialMode so <Route path="/register" element={<Login initialMode="register" />} />
// opens directly on the "Create Account" tab instead of the default "Sign In" tab.
export default function Login({ initialMode = 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [touched, setTouched] = useState({});
  const { login, register } = useAuth();
  const nav = useNavigate();
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current?.focus(); }, [mode]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setError('');
        setFieldErrors(fe => ({ ...fe }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      if (!value) return 'Confirm password is required';
      if (value.length < 8) return 'Minimum 8 characters required';
      if (value !== password) return 'Passwords do not match';
    }

    return '';
  };

  const passwordChecks = useMemo(() => {
    const v = password || '';
    const isRegister = mode === 'register';
    const hasLower = /[a-z]/.test(v);
    const hasUpper = /[A-Z]/.test(v);
    const hasNumber = /\d/.test(v);
    const hasSymbol = /[^A-Za-z0-9]/.test(v);

    const lengthOk = v.length >= 8;

    const checklist = [
      { key: 'length', label: 'At least 8 characters', ok: isRegister ? lengthOk : v.length > 0 },
      { key: 'upper', label: 'Uppercase letter', ok: isRegister ? hasUpper : v.length > 0 },
      { key: 'lower', label: 'Lowercase letter', ok: isRegister ? hasLower : v.length > 0 },
      { key: 'number', label: 'Number', ok: isRegister ? hasNumber : v.length > 0 },
      { key: 'symbol', label: 'Symbol', ok: isRegister ? hasSymbol : v.length > 0 },
    ];

    const score = [hasLower, hasUpper, hasNumber, hasSymbol].filter(Boolean).length + (lengthOk ? 1 : 0);
    const normalized = Math.max(0, Math.min(5, score));

    const strength =
      !v
        ? { label: 'Enter a password', color: '#9CA3AF', pct: 0 }
        : normalized <= 2
          ? { label: 'Weak', color: '#EF4444', pct: 20 }
          : normalized === 3
            ? { label: 'Fair', color: '#F59E0B', pct: 45 }
            : normalized === 4
              ? { label: 'Good', color: '#10B981', pct: 70 }
              : { label: 'Strong', color: '#00A87C', pct: 100 };

    return { checklist, strength, lengthOk };
  }, [password, mode]);

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
    if (!confirmPassword) return 'Confirm password is required';
    if (confirmPassword.length < 8) return 'Minimum 8 characters required';
    if (confirmPassword !== password) return 'Passwords do not match';
    return '';
  }, [confirmPassword, mode, password]);

  const canSubmit = useMemo(() => {
    if (loading) return false;
    if (!email || !password) return false;
    if (emailErrLive) return false;
    if (passwordErrLive) return false;
    if (mode === 'register' && confirmPasswordErrLive) return false;
    if (mode === 'register' && !confirmPassword) return false;
    return true;
  }, [loading, email, password, emailErrLive, passwordErrLive, confirmPasswordErrLive, confirmPassword, mode]);


  const handleBlur = (name, value) => {
    setTouched(t => ({ ...t, [name]: true }));
    const err = validateField(name, value);
    setFieldErrors(fe => ({ ...fe, [name]: err }));
  };

  const handleKeyDown = (e) => {
    setCapsLock(e.getModifierState && e.getModifierState('CapsLock'));
  };

  const [authStage, setAuthStage] = useState('idle');

  const mapBackendErrorToFields = (err) => {
    const msg = err?.response?.data?.error || err?.message || '';
    const lower = String(msg).toLowerCase();

    // Common patterns (best-effort; backend message format may vary)
    const next = {};

    if (lower.includes('email')) {
      next.email = msg;
    } else if (lower.includes('user') && (lower.includes('not') || lower.includes('found') || lower.includes('exist'))) {
      next.email = msg;
    }

    if (lower.includes('password') || lower.includes('credential') || lower.includes('auth')) {
      next.password = msg;
    }

    if (!next.email && !next.password) return null;
    return next;
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setAuthStage('validating');

    const emailErr = validateField('email', email);
    const passErr = validateField('password', password);
    const confirmErr = validateField('confirmPassword', confirmPassword);

    if (emailErr || passErr || confirmErr) {
      setFieldErrors({
        email: emailErr,
        password: passErr,
        confirmPassword: confirmErr,
      });
      setTouched({ email: true, password: true, confirmPassword: true });
      setAuthStage('idle');
      return;
    }

    setLoading(true);
    setAuthStage(mode === 'login' ? 'authenticating' : 'authenticating');

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
        setFieldErrors((prev) => ({ ...prev, ...mapped }));
        setTouched({ email: true, password: true });
      }
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
      setAuthStage('idle');
    } finally {
      setLoading(false);
      setAuthStage('idle');
    }
  };


  // FE-10 fix: calling setEmail/setPassword then submit() doesn't work because
  // React state updates are asynchronous — submit() would still see the old values.
  // Instead, call login() directly with the demo credentials and populate the
  // fields in parallel so the user sees what was used. Also improves the error
  // message so it doesn't imply the demo account is guaranteed to exist.
  const fillDemo = async () => {
    const demoEmail = 'demo@tfgen.io';
    const demoPass  = 'demo1234';
    setEmail(demoEmail);
    setPassword(demoPass);
    setConfirmPassword(demoPass);
    setFieldErrors({});
    setError('');
    setLoading(true);
    try {
      await login(demoEmail, demoPass);
      nav('/dashboard');
    } catch (err) {
      setError(
        err.response?.data?.error ||
        'Demo login failed — the demo account may not be seeded on this server.'
      );
    } finally {
      setLoading(false);
    }
  };

  /* -- Styles --- */
  const inputBase = {
    width: '100%', background: '#FFFFFF', border: '1px solid #D1D9E6',
    borderRadius: 10, padding: '12px 14px', color: '#1A2340', fontSize: 14,
    outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const inputErrorStyle = {
    ...inputBase,
    borderColor: '#E53E52',
    boxShadow: '0 0 0 3px rgba(229,62,82,0.10)',
  };

  const labelStyle = {
    fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6,
  };

  const fieldErrStyle = {
    fontSize: 12, color: '#E53E52', marginTop: 5, display: 'flex', alignItems: 'center', gap: 4,
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', background: '#F7F9FC',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
      overflow: 'hidden', position: 'relative',
    }}>
      {/* Subtle background decoration */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', top: '-15%', left: '-8%', width: '50%', height: '65%', background: 'radial-gradient(ellipse, rgba(0,168,124,0.06) 0%, transparent 65%)', filter: 'blur(2px)' }} />
        <div style={{ position: 'absolute', bottom: '-15%', right: '-8%', width: '45%', height: '55%', background: 'radial-gradient(ellipse, rgba(37,99,235,0.05) 0%, transparent 65%)' }} />
      </div>

      {/* Left panel — branding & features */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '60px 72px', position: 'relative', zIndex: 1,
      }}
        className="login-left-panel"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 56 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 14,
            background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 900, color: '#FFFFFF',
            boxShadow: '0 4px 20px rgba(0,168,124,0.25)',
          }}>*</div>
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
            {process.env.REACT_APP_APP_VERSION || '0.0.1'} — {process.env.REACT_APP_APP_ENV || 'development'} ready
          </span>
        </div>
      </div>

      {/* Right panel — auth card */}
      <div style={{
        width: 480, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 44px', position: 'relative', zIndex: 1,
      }}
        className="login-right-panel"
      >
        <div style={{
          width: '100%', background: '#FFFFFF',
          border: '1px solid #E5E7EB', borderRadius: 20,
          padding: '40px 36px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
        }}>
          {/* Tabs */}
          <div style={{ display: 'flex', background: '#F3F4F6', borderRadius: 11, padding: 4, marginBottom: 28, gap: 2 }}
            role="tablist"
          >
            {['login', 'register'].map(m => (
              <button key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => { setMode(m); setError(''); setFieldErrors({}); setTouched({}); setConfirmPassword(''); setAuthStage('idle'); }}

                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
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
            {authStage !== 'idle' && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, color: '#6B7280', fontSize: 13 }}>
                <div style={{ width: 22, height: 22, borderRadius: 999, border: '2px solid rgba(37,99,235,0.20)', borderTopColor: '#2563EB', animation: 'spin 0.9s linear infinite' }} />
                <div>
                  {authStage === 'validating' && 'Validating your inputs…'}
                  {authStage === 'authenticating' && 'Authenticating…'}
                  {authStage === 'finishing' && 'Finalizing session…'}
                </div>
              </div>
            )}
          </div>


          <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <label htmlFor="login-email" style={labelStyle}>Email Address</label>
              <input
                ref={emailRef}
                id="login-email"
                type="email"
                value={email}
                  onChange={e => {
                    const v = e.target.value;
                    setEmail(v);
                    if (touched.email) {
                      setFieldErrors((fe) => ({ ...fe, email: validateField('email', v) }));
                    }
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
                <div id="email-error" role="alert" style={fieldErrStyle}>
                  <span>⚠</span> {fieldErrors.email}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="login-password" style={labelStyle}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => {
                    const v = e.target.value;
                    setPassword(v);
                    if (touched.password) {
                      setFieldErrors((fe) => ({ ...fe, password: validateField('password', v) }));
                    }
                    if (touched.confirmPassword) {
                      setFieldErrors((fe) => ({ ...fe, confirmPassword: validateField('confirmPassword', confirmPassword) }));
                    }
                    if (error) setError('');
                  }}
                  onBlur={() => handleBlur('password', password)}
                  onKeyDown={handleKeyDown}
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'register' ? 'Min 8 characters' : '••••••••'}
                  aria-invalid={!!fieldErrors.password}
                  aria-describedby={fieldErrors.password ? 'password-error' : capsLock ? 'caps-warn' : 'password-strength'}
                  style={{ ...(touched.password && fieldErrors.password ? inputErrorStyle : inputBase), paddingRight: 44 }}
                  onFocus={e => { if (!fieldErrors.password) { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; } }}
                  onBlurCapture={e => { if (!fieldErrors.password) { e.target.style.borderColor = '#D1D9E6'; e.target.style.boxShadow = 'none'; } }}
                />
                <button type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer',
                    fontSize: 16, padding: '2px', borderRadius: 4, lineHeight: 1,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#374151'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; }}
                >
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>

              {/* Real-time strength */}
              <div id="password-strength" style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 700 }}>
                    Strength: <span style={{ color: passwordChecks.strength.color }}>{passwordChecks.strength.label}</span>
                  </div>
                  {mode === 'register' && passwordChecks.lengthOk && (
                    <div style={{ fontSize: 12, color: '#10B981', fontWeight: 800 }}>✓ Policy ready</div>
                  )}
                </div>
                <div style={{ height: 8, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden', marginTop: 8 }}>
                  <div style={{ height: '100%', width: `${passwordChecks.strength.pct}%`, background: passwordChecks.strength.color }} />
                </div>

                {mode === 'register' && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    {passwordChecks.checklist.slice(0, 5).map((c) => (
                      <div key={c.key} style={{ fontSize: 12, color: c.ok ? '#10B981' : '#6B7280', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 16, height: 16, borderRadius: 6, background: c.ok ? 'rgba(16,185,129,0.14)' : '#EEF2F7', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: c.ok ? '#10B981' : '#6B7280' }}>
                          {c.ok ? '✓' : '•'}
                        </span>
                        {c.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {touched.password && fieldErrors.password && (
                <div id="password-error" role="alert" style={fieldErrStyle}>
                  <span>⚠</span> {fieldErrors.password}
                </div>
              )}
              {capsLock && (
                <div id="caps-warn" style={{ fontSize: 12, color: '#D97706', marginTop: 5, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>⇪</span> Caps Lock is on
                </div>
              )}
            </div>

            {mode === 'register' && (
              <div>
                <label htmlFor="login-confirm-password" style={labelStyle}>Confirm Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    id="login-confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={e => {
                      const v = e.target.value;
                      setConfirmPassword(v);
                      if (touched.confirmPassword) {
                        setFieldErrors((fe) => ({ ...fe, confirmPassword: validateField('confirmPassword', v) }));
                      }
                      if (error) setError('');
                    }}
                    onBlur={() => handleBlur('confirmPassword', confirmPassword)}
                    required
                    autoComplete="new-password"
                    placeholder="Re-enter password"
                    aria-invalid={!!fieldErrors.confirmPassword}
                    aria-describedby={fieldErrors.confirmPassword ? 'confirm-password-error' : undefined}
                    style={{ ...(touched.confirmPassword && fieldErrors.confirmPassword ? inputErrorStyle : inputBase), paddingRight: 44 }}
                    onFocus={e => { if (!fieldErrors.confirmPassword) { e.target.style.borderColor = '#00A87C'; e.target.style.boxShadow = '0 0 0 3px rgba(0,168,124,0.10)'; } }}
                    onBlurCapture={e => { if (!fieldErrors.confirmPassword) { e.target.style.borderColor = '#D1D9E6'; e.target.style.boxShadow = 'none'; } }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    style={{
                      position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', color: '#9CA3AF', cursor: 'pointer',
                      fontSize: 16, padding: '2px', borderRadius: 4, lineHeight: 1,
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#374151'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#9CA3AF'; }}
                  >
                    {showPassword ? '🙈' : '👁'}
                  </button>
                </div>

                {touched.confirmPassword && fieldErrors.confirmPassword && (
                  <div id="confirm-password-error" role="alert" style={fieldErrStyle}>
                    <span>⚠</span> {fieldErrors.confirmPassword}
                  </div>
                )}
              </div>
            )}


            {error && (
              <div role="alert" style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#DC2626',
                display: 'flex', alignItems: 'flex-start', gap: 8,
              }}>
                <span style={{ flexShrink: 0, marginTop: 1 }}>⚠</span><span>{error}</span>
              </div>
            )}

            <button type="submit" disabled={!canSubmit}

              style={{
                width: '100%', padding: '13px', borderRadius: 11, border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                background: !canSubmit ? '#E5E7EB' : 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
                color: !canSubmit ? '#9CA3AF' : '#FFFFFF',

                fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em',
                transition: 'all 0.18s', marginTop: 4,
                boxShadow: !canSubmit ? 'none' : '0 4px 16px rgba(0,168,124,0.20)',
                opacity: !canSubmit ? 0.7 : 1,

              }}
              onMouseEnter={e => { if (!loading) { e.currentTarget.style.boxShadow = '0 6px 24px rgba(0,168,124,0.30)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
              onMouseLeave={e => { if (!loading) { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,168,124,0.20)'; e.currentTarget.style.transform = 'translateY(0)'; } }}
            >
              {loading ? (mode === 'login' ? 'Signing in…' : 'Creating account…') : (mode === 'login' ? 'Sign In →' : 'Create Account →')}
            </button>
          </form>

          <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
            <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 600 }}>OR</span>
            <div style={{ flex: 1, height: 1, background: '#E5E7EB' }} />
          </div>

          <button onClick={fillDemo}
            style={{
              width: '100%', marginTop: 14, padding: '11px', borderRadius: 10,
              border: '1px solid #D1E9DF', background: '#F0FDF7',
              color: '#00A87C', fontSize: 13, fontWeight: 700,
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#DCFCE7'; e.currentTarget.style.borderColor = '#86EFAC'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#F0FDF7'; e.currentTarget.style.borderColor = '#D1E9DF'; }}>
            ⚡ Try with demo credentials
          </button>

          <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: 13, color: '#6B7280', lineHeight: 1.6 }}>
            {mode === 'login'
              ? <span>No account yet?{' '}<button onClick={() => { setMode('register'); setError(''); setFieldErrors({}); setTouched({}); setConfirmPassword(''); }} style={{ background: 'none', border: 'none', color: '#00A87C', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>Create one free →</button></span>
              : <span>Already have an account?{' '}<button onClick={() => { setMode('login'); setError(''); setFieldErrors({}); setTouched({}); setConfirmPassword(''); }} style={{ background: 'none', border: 'none', color: '#00A87C', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>Sign in →</button></span>
            }
          </p>

          <div style={{ marginTop: 20, textAlign: 'center', fontSize: 11, color: '#9CA3AF', lineHeight: 1.6 }}>
            <span>🔒 Your data is encrypted and securely stored</span>
            <div style={{ marginTop: 6, fontSize: 10, color: '#9CA3AF' }}>
              © {new Date().getFullYear()} TFGen. All rights reserved.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
