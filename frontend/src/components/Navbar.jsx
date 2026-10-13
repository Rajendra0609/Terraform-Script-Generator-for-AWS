import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { awsAPI, projectsAPI } from '../api/client';
import AwsCredentialsModal from './AwsCredentialsModal';
import { getLastProjectId } from '../utils/lastProjectStorage';
import { APP_VERSION } from '../version';

export default function Navbar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAwsModal, setShowAwsModal] = useState(false);
  const [awsConnected, setAwsConnected] = useState(false);
  const [liveStatus, setLiveStatus] = useState('checking');
  const [pendingInvites, setPendingInvites] = useState(0);

  // UI/UX FIX: this Navbar previously had zero responsive handling anywhere
  // (confirmed by grepping the whole frontend during this audit — no
  // `@media`, `isMobile`, or `innerWidth` check existed in this file, or in
  // any component besides one media query in Login.jsx), so on a phone-width
  // viewport the five nav links + AWS button + registry icon + avatar would
  // simply overflow the fixed-height 52px bar with no way to scroll to the
  // clipped items (index.css sets `overflow: hidden` on the app root). This
  // collapses everything but the brand and avatar into a single hamburger
  // menu below a width threshold, mirroring the pattern already used for the
  // existing avatar dropdown (a fixed overlay + an absolutely positioned
  // panel) rather than introducing a new UI idiom.
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 860 : false));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 860);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Any navigation change (a link inside the mobile menu was clicked, or the
  // user switched between mobile/desktop, e.g. by rotating a tablet) should
  // close whichever menu is open rather than leaving a stale one on screen.
  useEffect(() => { setMobileMenuOpen(false); setMenuOpen(false); }, [loc.pathname, isMobile]);

  useEffect(() => {
    if (!user) { setPendingInvites(0); return; }
    const fetchInvites = () => {
      projectsAPI.myInvitations()
        .then(r => setPendingInvites((r.data || []).length))
        .catch(() => {});
    };
    fetchInvites();
    const timer = setInterval(fetchInvites, 60000);
    return () => clearInterval(timer);
  }, [user]);

  // Read the last active projectId so the History link can go directly to that
  // project's version history. The Builder writes this per-user-namespaced
  // key whenever a project is successfully loaded (see L-04 fix in
  // utils/lastProjectStorage.js — this used to be a single global key shared
  // across every account on the browser).
  const lastProjectId = getLastProjectId(user?.id);
  const historyHref = lastProjectId ? `/history/${lastProjectId}` : '/history';
  const isAdmin = user?.role === 'admin';

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
    // UI/UX FIX: styles for the new mobile hamburger menu — deliberately
    // reuse the same visual language (colors, radii, shadow) as the
    // existing desktop dropdown above rather than introducing a new style.
    hamburgerBtn: {
      width: 36, height: 36,
      background: 'transparent', border: '1px solid #E5E7EB',
      borderRadius: 8, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#374151', fontSize: 18, flexShrink: 0,
    },
    mobilePanel: {
      position: 'absolute', top: 52, left: 0, right: 0,
      background: '#FFFFFF', borderBottom: '1px solid #E5E7EB',
      boxShadow: '0 12px 36px rgba(0,0,0,0.10)',
      zIndex: 200, padding: 10,
      maxHeight: 'calc(100vh - 52px)', overflowY: 'auto',
    },
  };

  const initials = user?.email?.slice(0, 2).toUpperCase() || '??';

  // UI/UX FIX: mobile layout — kept as a fully separate return branch
  // (rather than threading isMobile checks through the desktop JSX below)
  // so the existing, working desktop layout has zero chance of regressing;
  // the two share only the precomputed styles/handlers above.
  if (isMobile) {
    const navItems = user ? [
      { icon: '🏠', label: 'Dashboard', to: '/dashboard' },
      { icon: '🧪', label: 'Studio', to: '/studio' },
      { icon: '🕘', label: 'History', to: historyHref },
      { icon: '👥', label: 'Team', to: '/team', badge: pendingInvites > 0 ? pendingInvites : null },
      ...(isAdmin ? [{ icon: '🛠', label: 'Admin', to: '/admin' }] : []),
    ] : [];

    return (
      <nav style={{ ...s.nav, position: 'relative' }}>
        <Link to="/" style={s.brand}>
          <div style={s.logo}>{'\u2B21'}</div>
          <span style={{ fontSize: 14, fontWeight: 800, color: '#111827', letterSpacing: '-0.03em' }}>TFGen</span>
        </Link>

        <div style={{ flex: 1 }} />

        {user && (
          <span style={{ position: 'relative', marginRight: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', position: 'absolute', top: -1, right: -1, background: liveStatus === 'live' ? '#059669' : '#9CA3AF', border: '1.5px solid #fff' }} />
            <span style={{ ...s.iconBtn, border: '1px solid #E5E7EB' }} onClick={() => { setMobileMenuOpen(false); setShowAwsModal(true); }} title="AWS connection status">☁️</span>
          </span>
        )}

        <button
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileMenuOpen}
          style={s.hamburgerBtn}
          onClick={() => setMobileMenuOpen(v => !v)}
        >
          {mobileMenuOpen ? '\u2715' : '\u2630'}
        </button>

        {mobileMenuOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, top: 52, zIndex: 199 }} onClick={() => setMobileMenuOpen(false)} />
            <div style={s.mobilePanel}>
              {user ? (
                <>
                  <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid #E5E7EB', marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{user.email}</div>
                    <div style={{ fontSize: 10, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{user.role || 'editor'}</div>
                  </div>
                  {navItems.map(item => (
                    <Link key={item.to} to={item.to} style={s.dropItem} onClick={() => setMobileMenuOpen(false)}>
                      <span>{item.icon}</span> {item.label}
                      {item.badge && (
                        <span style={{ marginLeft: 'auto', background: '#EF4444', color: '#fff', borderRadius: 99, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>{item.badge}</span>
                      )}
                    </Link>
                  ))}
                  <div style={{ height: 1, background: '#E5E7EB', margin: '6px 0' }} />
                  <a href="https://registry.terraform.io/browse/providers" target="_blank" rel="noreferrer" style={s.dropItem}>
                    <span>{'\u2295'}</span> Terraform Registry
                  </a>
                  <div style={{ height: 1, background: '#E5E7EB', margin: '6px 0' }} />
                  <button style={{ ...s.dropItem, color: '#DC2626' }} onClick={() => { setMobileMenuOpen(false); handleLogout(); }}>
                    <span>{'\u2296'}</span> Sign out
                  </button>
                </>
              ) : (
                <>
                  <button style={{ ...s.dropItem }} onClick={() => { setMobileMenuOpen(false); nav('/login'); }}>Sign in</button>
                  <button style={{ ...s.dropItem, fontWeight: 700, color: '#059669' }} onClick={() => { setMobileMenuOpen(false); nav('/register'); }}>Get Started</button>
                </>
              )}
            </div>
          </>
        )}

        {showAwsModal && (
          <AwsCredentialsModal onClose={() => { setShowAwsModal(false); checkAwsStatus(); }} />
        )}
      </nav>
    );
  }

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
        {APP_VERSION}
      </span>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Link to="/dashboard" style={s.navLink(isActive('/dashboard'))}>
            <span className="navbar-emoji">🏠</span>{' '}Dashboard
          </Link>
          <Link to="/studio" style={s.navLink(isActive('/studio'))}>
            <span className="navbar-emoji">🧪</span>{' '}Studio
          </Link>
          <Link to={historyHref} style={s.navLink(isActive('/history'))}>
            <span className="navbar-emoji">🕘</span>{' '}History
          </Link>
          <Link to="/team" style={s.navLink(isActive('/team'))}>
            <span className="navbar-emoji">👥</span>{' '}Team
            {pendingInvites > 0 && (
              <span style={{
                marginLeft: 5, background: '#EF4444', color: '#fff', borderRadius: 99,
                fontSize: 10, fontWeight: 700, padding: '1px 6px', verticalAlign: 'middle',
              }}>{pendingInvites}</span>
            )}
          </Link>
          {isAdmin && (
            <Link to="/admin" style={s.navLink(isActive('/admin'))}>
              🛠 Admin
            </Link>
          )}
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
