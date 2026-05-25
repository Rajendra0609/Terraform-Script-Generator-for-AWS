import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { awsAPI } from '../api/client';
import AwsCredentialsModal from './AwsCredentialsModal';

export default function Navbar() {
  const { user, logout } = useAuth();
  const { c } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAwsModal, setShowAwsModal] = useState(false);
  const [awsConnected, setAwsConnected] = useState(false);
  const [liveStatus, setLiveStatus] = useState('checking');

  // Read the last active projectId so the History link can go directly to that
  // project's version history.  The Builder writes 'tfgen.lastProjectId' to
  // localStorage whenever a project is successfully loaded.
  const UUID_RE_NAV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const lastProjectId = (() => {
    try {
      const id = localStorage.getItem('tfgen.lastProjectId');
      return id && UUID_RE_NAV.test(id) ? id : null;
    } catch { return null; }
  })();
  const historyHref = lastProjectId ? `/history/${lastProjectId}` : '/history';

  const checkAwsStatus = React.useCallback(() => {
    if (!user) { setAwsConnected(false); setLiveStatus('offline'); return; }
    awsAPI.getCredentials()
      .then(r => {
        const connected = !!r.data?.credentials;
        setAwsConnected(connected);
        setLiveStatus(connected ? 'live' : 'offline');
      })
      .catch(() => { setAwsConnected(false); setLiveStatus('offline'); });
  }, [user]);

  useEffect(() => {
    checkAwsStatus();
    const timer = setInterval(checkAwsStatus, 60000);
    return () => clearInterval(timer);
  }, [checkAwsStatus]);

  const isActive = (path) => loc.pathname === path || loc.pathname.startsWith(path + '/');

  const handleLogout = () => { logout(); nav('/login'); };

  const s = {
    nav: {
      height: 52,
      background: '#FFFFFF',
      borderBottom: '1px solid #E5E7EB',
      display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 0,
      position: 'relative', zIndex: 100,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      flexShrink: 0,
    },
    brand: {
      display: 'flex', alignItems: 'center', gap: 10,
      textDecoration: 'none', flexShrink: 0, marginRight: 28,
    },
    logo: {
      width: 32, height: 32,
      background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
      borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 16, fontWeight: 800, color: '#FFFFFF',
      boxShadow: '0 2px 8px rgba(0,168,124,0.25)',
    },
    navLink: (active) => ({
      padding: '6px 12px', borderRadius: 7,
      fontSize: 13, fontWeight: active ? 600 : 500,
      color: active ? '#111827' : '#6B7280',
      textDecoration: 'none',
      display: 'flex', alignItems: 'center', gap: 6,
      transition: 'all 0.15s',
      background: active ? '#F3F4F6' : 'transparent',
      border: active ? '1px solid #E5E7EB' : '1px solid transparent',
    }),
    divider: { width: 1, height: 22, background: '#E5E7EB', margin: '0 10px', flexShrink: 0 },
    iconBtn: {
      width: 32, height: 32,
      background: 'transparent', border: '1px solid transparent',
      borderRadius: 7, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#6B7280', fontSize: 16, transition: 'all 0.15s',
    },
    avatar: {
      width: 30, height: 30, borderRadius: '50%',
      background: 'linear-gradient(135deg, #00A87C 0%, #2563EB 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 800, color: '#FFFFFF',
      cursor: 'pointer', border: '2px solid transparent',
      transition: 'border-color 0.15s', flexShrink: 0,
    },
    dropdown: {
      position: 'absolute', top: 44, right: 16,
      background: '#FFFFFF', border: '1px solid #E5E7EB',
      borderRadius: 12, padding: 6,
      boxShadow: '0 12px 36px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.03)',
      zIndex: 200, minWidth: 200,
    },
    dropItem: {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '9px 12px', borderRadius: 7,
      fontSize: 13, fontWeight: 500,
      color: '#4B5563', cursor: 'pointer',
      transition: 'all 0.12s', textDecoration: 'none',
      border: 'none', background: 'none', width: '100%', textAlign: 'left',
    },
  };

  const initials = user?.email?.slice(0, 2).toUpperCase() || '??';

  return (
    <nav style={s.nav}>
      <Link to="/" style={s.brand}>
        <div style={s.logo}>{'\u2B21'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#111827', letterSpacing: '-0.03em' }}>TFGen</span>
          <span style={{ fontSize: 9, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Terraform Studio</span>
        </div>
      </Link>

      <span style={{ padding: '2px 8px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 99, fontSize: 9, fontWeight: 700, color: '#059669', letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 20, flexShrink: 0 }}>
        {process.env.REACT_APP_APP_VERSION || '0.0.1'}
      </span>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Link to="/dashboard" style={s.navLink(isActive('/dashboard'))}>
            <span className="navbar-emoji">🏠</span>{' '}Dashboard
          </Link>
          <Link to={historyHref} style={s.navLink(isActive('/history'))}>
            <span className="navbar-emoji">🕘</span>{' '}History
          </Link>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {user && (
          <button
            onClick={() => setShowAwsModal(true)}
            title={liveStatus === 'live' ? 'AWS Connected — live data active. Click to manage.' : liveStatus === 'checking' ? 'Checking AWS connection...' : 'Connect AWS credentials for live data'}
            style={{
              ...s.iconBtn,
              border: liveStatus === 'live' ? '1px solid #BBF7D0' : '1px solid #E5E7EB',
              background: liveStatus === 'live' ? '#F0FDF4' : 'transparent',
              color: liveStatus === 'live' ? '#059669' : '#6B7280',
              fontSize: 13, fontWeight: 700, padding: '0 10px', width: 'auto', gap: 6, display: 'flex', alignItems: 'center',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = liveStatus === 'live' ? '#DCFCE7' : '#F3F4F6';
              e.currentTarget.style.color = liveStatus === 'live' ? '#059669' : '#111827';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = liveStatus === 'live' ? '#F0FDF4' : 'transparent';
              e.currentTarget.style.color = liveStatus === 'live' ? '#059669' : '#6B7280';
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flexShrink: 0, background: liveStatus === 'live' ? '#059669' : liveStatus === 'checking' ? '#D97706' : '#9CA3AF', boxShadow: liveStatus === 'live' ? '0 0 0 2px rgba(5,150,105,0.2), 0 0 6px rgba(5,150,105,0.4)' : 'none' }} />
            <span style={{ fontSize: 11 }}>{liveStatus === 'live' ? '☁️ Live' : liveStatus === 'checking' ? '☁️ AWS...' : '☁️ AWS'}</span>
          </button>
        )}

        <a href="https://registry.terraform.io/browse/providers" target="_blank" rel="noreferrer"
          style={{ ...s.iconBtn, textDecoration: 'none' }} title="Terraform Registry"
          onMouseEnter={e => { e.currentTarget.style.background = '#F3F4F6'; e.currentTarget.style.color = '#111827'; e.currentTarget.style.borderColor = '#E5E7EB'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6B7280'; e.currentTarget.style.borderColor = 'transparent'; }}>
          <span>{'\u2295'}</span>
        </a>

        <div style={s.divider} />

        {user ? (
          <div style={{ position: 'relative' }}>
            <div style={{ ...s.avatar, ...(menuOpen ? { borderColor: '#00D4A1' } : {}) }}
              onClick={() => setMenuOpen(v => !v)} title={user.email}>
              {initials}
            </div>

            {menuOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setMenuOpen(false)} />
                <div style={s.dropdown}>
                  <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid #E5E7EB', marginBottom: 4 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#111827', marginBottom: 2 }}><span>👤</span>&nbsp;{user.email}</div>
                    <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{user.role || 'editor'}</div>
                  </div>

                  {[{ icon: '🏠', label: 'Dashboard', to: '/dashboard' }, { icon: '🕘', label: 'History', to: historyHref }].map(item => (
                    <Link key={item.to} to={item.to} style={s.dropItem} onClick={() => setMenuOpen(false)}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F3F4F6'; e.currentTarget.style.color = '#111827'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#4B5563'; }}>
                      <span>{item.icon}</span> {item.label}
                    </Link>
                  ))}

                  <div style={{ height: 1, background: '#E5E7EB', margin: '4px 0' }} />

                  <button style={{ ...s.dropItem, color: awsConnected ? '#059669' : '#4B5563' }}
                    onClick={() => { setMenuOpen(false); setShowAwsModal(true); }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#F0FDF4'; e.currentTarget.style.color = '#059669'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = awsConnected ? '#059669' : '#4B5563'; }}>
                    <span>☁️</span>
                    <span style={{ marginLeft: 6 }}>{awsConnected ? '🟢 AWS Connected' : '🔌 Connect AWS'}</span>
                  </button>

                  <div style={{ height: 1, background: '#E5E7EB', margin: '4px 0' }} />

                  <button style={{ ...s.dropItem, color: '#DC2626' }} onClick={handleLogout}
                    onMouseEnter={e => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#DC2626'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#DC2626'; }}>
                    <span>{'\u2296'}</span>{' '}Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => nav('/login')}
              style={{ padding: '6px 14px', borderRadius: 7, border: '1px solid #D1D5DB', background: '#FFFFFF', color: '#4B5563', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s' }}>
              Sign in
            </button>
            <button onClick={() => nav('/register')}
              style={{ padding: '6px 14px', borderRadius: 7, border: 'none', background: 'linear-gradient(135deg, #00A87C, #2563EB)', color: '#FFFFFF', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              Get Started
            </button>
          </div>
        )}
      </div>

      {showAwsModal && (
        <AwsCredentialsModal onClose={() => { setShowAwsModal(false); checkAwsStatus(); }} />
      )}
    </nav>
  );
}
