import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * OAuthCallback — handles the redirect from /api/auth/oauth/:provider/callback
 *
 * The backend redirects to: {FRONTEND_URL}/oauth-callback#token=<accessToken>
 * This page reads the token from the URL fragment, stores it, then sends
 * the user to /dashboard.
 *
 * Route: /oauth-callback  (add to App.jsx)
 */
export default function OAuthCallback() {
  const nav   = useNavigate();
  const { loginWithToken } = useAuth();
  const [error, setError]  = useState('');

  useEffect(() => {
    const hash   = window.location.hash;
    const search = window.location.search;

    // Error from backend
    const params = new URLSearchParams(search);
    const oauthError = params.get('oauth_error');
    if (oauthError) {
      setError(decodeURIComponent(oauthError));
      setTimeout(() => nav('/login'), 4000);
      return;
    }

    // Read token from fragment  #token=xxx
    if (hash && hash.startsWith('#token=')) {
      const token = hash.slice(7);
      if (token && loginWithToken) {
        loginWithToken(token);
        nav('/dashboard');
      } else {
        setError('Invalid OAuth callback — no token received');
        setTimeout(() => nav('/login'), 3000);
      }
      return;
    }

    // Unknown state
    setError('OAuth callback missing token');
    setTimeout(() => nav('/login'), 3000);
  }, [nav, loginWithToken]);

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#F7F9FC', fontFamily: 'inherit',
    }}>
      {!error ? (
        <>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔄</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#374151' }}>Signing you in…</div>
          <div style={{ fontSize: 13, color: '#9CA3AF', marginTop: 6 }}>Please wait</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 40, marginBottom: 16 }}>❌</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#DC2626' }}>Sign-in failed</div>
          <div style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: 360, textAlign: 'center' }}>
            {error}
          </div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 12 }}>
            Redirecting back to login…
          </div>
        </>
      )}
    </div>
  );
}
