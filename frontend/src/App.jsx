import React, { lazy, Suspense, Component } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Navbar from './components/Navbar';

// ── Eagerly loaded (small, always needed on first paint) ──────────────────────
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import OAuthCallback from './pages/OAuthCallback';

// ── Lazily loaded (heavy; only needed after auth) ─────────────────────────────
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Builder   = lazy(() => import('./pages/Builder'));
const History   = lazy(() => import('./pages/History'));
const Studio     = lazy(() => import('./pages/Studio'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const Team       = lazy(() => import('./pages/Team'));

/** Shown while a lazy page chunk is downloading */
function PageLoader() {
  const { c } = useTheme();
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: c.bg, color: c.muted, fontSize: 14,
    }}>
      <span>Loading…</span>
    </div>
  );
}

/**
 * Error boundary that catches ChunkLoadErrors (and any other render errors).
 * Shows a simple "Reload page" prompt instead of a blank screen.
 */
class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    // ChunkLoadError means a JS chunk file is missing — a hard reload fixes it
    if (error && error.name === 'ChunkLoadError') {
      window.location.reload();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#0f0f0f', color: '#a0a0a0', fontSize: 14, gap: 16,
        }}>
          <p>Something went wrong loading this page.</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px', borderRadius: 6, border: 'none',
              background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Redirect unauthenticated users to /login. Shows nothing while auth state
 * loads. If `requiredRole` is given, users authenticated but lacking that
 * role are redirected to /dashboard instead of rendering the page.
 *
 * SECURITY FIX (L-01): previously accepted no role at all, so any
 * logged-in non-admin could navigate straight to /admin and the AdminPanel
 * shell would attempt to mount (every /api/admin/* call it makes still
 * correctly gets a 403 from requireRole('admin') server-side — no data was
 * ever actually exposed — but the route revealed the admin panel's
 * structure to any authenticated user and rendered a broken-looking UI
 * instead of a clean redirect).
 */
function ProtectedRoute({ children, requiredRole }) {
  const { isAuthenticated, loading, user } = useAuth();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (requiredRole && user?.role !== requiredRole) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppContent() {
  const { c } = useTheme();
  const loc = useLocation();
  const hideNav = loc.pathname === '/login' || loc.pathname === '/register' || loc.pathname === '/reset-password';
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: c.bg }}>
      {!hideNav && <Navbar />}
      <ChunkErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Login initialMode="register" />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/oauth-callback" element={<OAuthCallback />} />
            <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/builder" element={<ProtectedRoute><Builder /></ProtectedRoute>} />
            <Route path="/builder/:projectId" element={<ProtectedRoute><Builder /></ProtectedRoute>} />
            <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
            <Route path="/history/:projectId" element={<ProtectedRoute><History /></ProtectedRoute>} />
            <Route path="/studio" element={<ProtectedRoute><Studio /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute requiredRole="admin"><AdminPanel /></ProtectedRoute>} />
            <Route path="/team" element={<ProtectedRoute><Team /></ProtectedRoute>} />
            <Route path="/team/:projectId" element={<ProtectedRoute><Team /></ProtectedRoute>} />
          </Routes>
        </Suspense>
      </ChunkErrorBoundary>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
