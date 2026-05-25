import React, { useState, useCallback } from 'react';

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((msg, type = 'info') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);
  return { toasts, show };
}

export function ToastContainer({ toasts }) {
  const colors = { success: '#3FB950', error: '#F85149', info: '#7B42BC', warning: '#D29922' };
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {toasts.map(t => (
        <div key={t.id} className="fade-in" style={{
          background: 'var(--bg-tertiary, #1E2130)', border: `1px solid ${colors[t.type] || colors.info}44`,
          borderLeft: `3px solid ${colors[t.type] || colors.info}`,
          borderRadius: 8, padding: '10px 16px', fontSize: 13, color: 'var(--text-primary, #F3F4F6)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxWidth: 320
        }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
