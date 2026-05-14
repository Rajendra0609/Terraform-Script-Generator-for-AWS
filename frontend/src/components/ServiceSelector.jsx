import React, { useState } from 'react';

const ICONS = {
  SERVER: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="5" rx="1"/><rect x="2" y="10" width="20" height="5" rx="1"/><rect x="2" y="17" width="20" height="5" rx="1"/><circle cx="6" cy="5.5" r="0.8" fill="currentColor"/><circle cx="6" cy="12.5" r="0.8" fill="currentColor"/></svg>),
  AUTOSCALE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>),
  LOADBALANCER: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 5v14M5 12H2M22 12h-3M5 8l-3 4 3 4M19 8l3 4-3 4"/></svg>),
  BUCKET: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 7h18l-2 12H5L3 7z"/><path d="M8 7V5a4 4 0 018 0v2"/></svg>),
  DISK: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="5"/><path d="M2 12v5c0 2.8 4.5 5 10 5s10-2.2 10-5v-5"/><circle cx="16" cy="13" r="0.8" fill="currentColor"/></svg>),
  FILESHARE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 15l5-5 4 4 5-5 4 4"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>),
  NETWORK: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="1" y="8" width="6" height="4" rx="1"/><rect x="17" y="3" width="6" height="4" rx="1"/><rect x="17" y="13" width="6" height="4" rx="1"/><path d="M7 10h5v-5h5M7 10h5v5h5"/></svg>),
  SUBNET: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="5" y="7" width="6" height="5" rx="1"/><rect x="13" y="7" width="6" height="5" rx="1"/></svg>),
  SHIELD: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-4 9-8 10C8 21 4 17 4 12V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>),
  GLOBE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg>),
  GATEWAY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/><circle cx="5" cy="12" r="2"/></svg>),
  ROUTE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 17h5l8-10h5M16 7l3 3-3 3M8 14l-3 3 3 3"/></svg>),
  DNS: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/><path d="M12 7v10M8 9h8M8 15h8"/></svg>),
  CDN: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 010 9H5a4 4 0 01-.999-7.867"/><path d="M12 12v6M9 15l3 3 3-3"/></svg>),
  DATABASE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="9" ry="3"/><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6"/><path d="M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/></svg>),
  DYNAMODB: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="9" ry="3"/><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6"/><path d="M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/><path d="M7 9l2 2 4-4" strokeWidth="2"/></svg>),
  CACHE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>),
  LOCK: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>),
  USER: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>),
  POLICY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8l-5-5z"/><path d="M9 3v5h7M8 13h8M8 17h5"/></svg>),
  USERGROUP: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="9" cy="7" r="3"/><path d="M3 20c0-3 2.7-5 6-5"/><circle cx="16" cy="7" r="3"/><path d="M21 20c0-3-2.7-5-6-5s-6 2-6 5h12"/></svg>),
  KEY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="8" cy="15" r="5"/><path d="M13 15h9M17 11v4"/><circle cx="8" cy="15" r="2" fill="currentColor" stroke="none"/></svg>),
  SECRET: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><path d="M12 16v2M12 14a1 1 0 100 2 1 1 0 000-2"/></svg>),
  FUNCTION: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8z"/><polyline points="17 3 17 8 12 8"/><path d="M9 12l2 2 4-4"/></svg>),
  ALARM: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/><path d="M2 8a10 10 0 0120 0"/></svg>),
  LOGS: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h7"/></svg>),
  SNS: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51L8.59 10.49"/></svg>),
  QUEUE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="4" rx="1"/><rect x="2" y="11" width="20" height="4" rx="1"/><rect x="2" y="17" width="12" height="4" rx="1"/></svg>),
  EVENT: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>),
  CLUSTER: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="16" r="2"/><circle cx="4" cy="16" r="2"/><path d="M12 7v2M17.5 14l-1.5-1M6.5 14l1.5-1"/></svg>),
  CONTAINERS: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.29 7L12 12l8.71-5M12 22V12"/></svg>),
  REGISTRY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.29 7L12 12l8.71-5M12 22V12M15 3.6l-3 1.7-3-1.7"/></svg>),
  PIPELINE: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="5" cy="12" r="3"/><circle cx="12" cy="5" r="3"/><circle cx="19" cy="12" r="3"/><circle cx="12" cy="19" r="3"/><path d="M8 12h3M13 5l2 4M13 19l2-4M16 12h3"/></svg>),
  BUILD: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>),
  DEPLOY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>),
  APIGATEWAY: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="7" width="6" height="10" rx="1"/><rect x="16" y="7" width="6" height="10" rx="1"/><path d="M8 12h8M14 9l3 3-3 3"/></svg>),
  PARAMETER: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 0v20M12 7h4.5a2.5 2.5 0 010 5H12v5"/></svg>),
  BACKUP: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>),
  AUDIT: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8l-5-5z"/><path d="M9 3v5h7"/><path d="M8 13h8M8 17h5M8 9h2"/></svg>),
  GUARD: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-4 9-8 10C8 21 4 17 4 12V6l8-4z"/><circle cx="12" cy="12" r="3"/></svg>),
  WAF: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-4 9-8 10C8 21 4 17 4 12V6l8-4z"/><path d="M9 12h6M12 9v6"/></svg>),
  BUDGET: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>),
  CONFIG: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>),
  TRANSIT: (<svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>),
};

const CATEGORY_COLORS = {
  'Compute':       { bg: '#1C1F2E', border: '#3D4070', accent: '#818CF8' },
  'Storage':       { bg: '#1C2A1C', border: '#2E5E2E', accent: '#4ADE80' },
  'Networking':    { bg: '#1A2030', border: '#2D4A6E', accent: '#38BDF8' },
  'Database':      { bg: '#251C2E', border: '#5E3D6E', accent: '#C084FC' },
  'IAM & Security':{ bg: '#2A1C1C', border: '#6E2E2E', accent: '#F87171' },
  'Monitoring':    { bg: '#1F251A', border: '#3A5E2A', accent: '#86EFAC' },
  'Containers':    { bg: '#1C2228', border: '#2E4A5E', accent: '#22D3EE' },
  'CI/CD':         { bg: '#251F1A', border: '#6E4A2E', accent: '#FCD34D' },
  'Admin & Ops':   { bg: '#201C28', border: '#4A3A6E', accent: '#A78BFA' },
};

const CATEGORY_ORDER = [
  'Compute','Storage','Networking','Database',
  'IAM & Security','Monitoring','Containers','CI/CD','Admin & Ops',
];

export default function ServiceSelector({ services, addedServices, onAdd }) {
  const [search, setSearch] = useState('');
  const addedIds = new Set(addedServices.map(s => s.service_type));

  const filtered = search.trim()
    ? services.filter(s =>
        s.label.toLowerCase().includes(search.toLowerCase()) ||
        s.category.toLowerCase().includes(search.toLowerCase())
      )
    : services;

  const categories = CATEGORY_ORDER.filter(c => filtered.some(s => s.category === c));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Search */}
      <div style={{ padding: '12px 12px 8px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search services…"
          style={{
            width: '100%', background: '#0D1117', border: '1px solid #30363D',
            borderRadius: 6, color: '#E6EDF3', padding: '7px 10px', fontSize: 12,
            outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#484F58', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
          {filtered.length} services
        </div>
        {categories.map(cat => {
          const catServices = filtered.filter(s => s.category === cat);
          const colors = CATEGORY_COLORS[cat] || CATEGORY_COLORS['Compute'];
          return (
            <div key={cat} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10, color: colors.accent, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6, paddingLeft: 2 }}>
                {cat}
              </div>
              {catServices.map(svc => {
                const isAdded = addedIds.has(svc.service_type);
                const hasModule = !!svc.module_body;
                return (
                  <button key={svc.service_type}
                    onClick={() => !isAdded && onAdd(svc)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 9px', marginBottom: 3, borderRadius: 7, border: 'none',
                      cursor: isAdded ? 'default' : 'pointer',
                      background: isAdded ? colors.bg : 'transparent',
                      color: isAdded ? colors.accent : '#8B949E',
                      transition: 'all 0.15s', textAlign: 'left',
                    }}
                    onMouseEnter={e => { if (!isAdded) { e.currentTarget.style.background = colors.bg; e.currentTarget.style.color = colors.accent; }}}
                    onMouseLeave={e => { if (!isAdded) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#8B949E'; }}}
                  >
                    <span style={{ flexShrink: 0, opacity: isAdded ? 1 : 0.6 }}>
                      {ICONS[svc.icon] || ICONS.SERVER}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500, flex: 1, lineHeight: 1.3 }}>{svc.label}</span>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      {hasModule && (
                        <span style={{ fontSize: 9, background: '#7B42BC33', color: '#9F6FD0', padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}>
                          MOD
                        </span>
                      )}
                      {isAdded && (
                        <span style={{ fontSize: 9, background: colors.accent + '22', color: colors.accent, padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}>
                          ✓
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: '#484F58', fontSize: 12, paddingTop: 24 }}>
            No services match "{search}"
          </div>
        )}
      </div>
    </div>
  );
}
