import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import API from '../api/client';

const AuthContext = createContext();

// BUG-008 fix: access token lives ONLY in React state — never in localStorage.
// The refresh token is stored in an HttpOnly cookie by the backend; JS cannot
// read it, so it cannot be exfiltrated by XSS or third-party scripts.
// On page load we call /refresh (cookie sent automatically) to get a fresh
// access token, restoring the session without touching localStorage.

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [token, setToken]     = useState(null);  // in-memory only
  const [loading, setLoading] = useState(true);

  // Sync access token to axios header (no localStorage)
  useEffect(() => {
    if (token) {
      API.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete API.defaults.headers.common['Authorization'];
    }
  }, [token]);

  // On mount: attempt silent token refresh via HttpOnly cookie.
  // If the cookie is absent or expired this will 401 and we stay logged-out.
  useEffect(() => {
    API.post('/api/auth/refresh')
      .then(r => {
        const at = r.data.token || r.data.accessToken;
        if (at) setToken(at);
        return API.get('/api/auth/me');
      })
      .then(r => setUser(r.data))
      .catch(() => clearSession())
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for session-expiry events fired by the axios interceptor
  useEffect(() => {
    const handler = () => clearSession();
    window.addEventListener('tfgen:session-expired', handler);
    return () => window.removeEventListener('tfgen:session-expired', handler);
  }, []);

  function clearSession() {
    setToken(null);
    setUser(null);
    // No localStorage to clear — the backend clears the HttpOnly cookie on logout
  }

  const login = useCallback(async (email, password) => {
    const res = await API.post('/api/auth/login', { email, password });
    const at = res.data.token || res.data.accessToken;
    if (at) {
      // BUG-FIX: Set the axios header synchronously HERE, before calling
      // setUser(). setUser() triggers a re-render of every component that
      // consumes useAuth() (e.g. Navbar). Those components fire their own
      // useEffect API calls immediately during that render cycle — before
      // the useEffect([token]) below has a chance to run. Without setting
      // the header here, those calls go out with no Bearer token → 401.
      API.defaults.headers.common['Authorization'] = `Bearer ${at}`;
      setToken(at);
    }
    setUser(res.data.user);
    return res.data;
  }, []);

  const register = useCallback(async (email, password) => {
    const res = await API.post('/api/auth/register', { email, password });
    const at = res.data.token || res.data.accessToken;
    if (at) {
      // Same fix as login() above — set header synchronously before setUser()
      API.defaults.headers.common['Authorization'] = `Bearer ${at}`;
      setToken(at);
    }
    setUser(res.data.user);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      // Backend revokes the refresh token and clears the cookie
      await API.post('/api/auth/logout');
    } catch { /* best-effort */ }
    clearSession();
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
