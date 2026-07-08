import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Navbar from './components/Navbar';

// ── Eagerly loaded (small, always needed on first paint) ──────────────────────
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';

// ── Lazily loaded (heavy; only needed after auth) ─────────────────────────────
// Each page is split into its own chunk so the login screen loads immediately
// and subsequent navigations only download the code they actually need.
// Studio is split separately because it carries the Monaco editor (~2 MB).
const Dashboard    = lazy(() => import('./pages/Dashboard'));
const Builder      = lazy(() => import('./pages/Builder'));
const History      = lazy(() => import('./pages/History'));
const Studio       = lazy(() => import('./pages/Studio'));

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

/** Redirect unauthenticated users to /login. Shows nothing while auth state loads. */
function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

function AppContent() {
  const { c } = useTheme();
  const loc = useLocation();
  const hideNav = loc.pathname === '/login' || loc.pathname === '/register' || loc.pathname === '/reset-password';
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: c.bg }}>
      {!hideNav && <Navbar />}
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Login initialMode="register" />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/builder" element={<ProtectedRoute><Builder /></ProtectedRoute>} />
          <Route path="/builder/:projectId" element={<ProtectedRoute><Builder /></ProtectedRoute>} />
          <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
          <Route path="/history/:projectId" element={<ProtectedRoute><History /></ProtectedRoute>} />
          <Route path="/studio" element={<ProtectedRoute><Studio /></ProtectedRoute>} />
        </Routes>
      </Suspense>
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
