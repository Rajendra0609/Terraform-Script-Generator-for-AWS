import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const Logo = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <div style={{
      width: 32, height: 32, background: 'linear-gradient(135deg, #7B42BC, #5325A0)',
      borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 18, fontWeight: 800, color: '#fff'
    }}>T</div>
    <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.3px', color: '#E6EDF3' }}>
      TF<span style={{ color: '#7B42BC' }}>Gen</span>
    </span>
  </div>
);

export default function Navbar() {
  const loc = useLocation();
  const navItem = (to, label) => (
    <Link to={to} style={{
      color: loc.pathname.startsWith(to) ? '#E6EDF3' : '#8B949E',
      textDecoration: 'none', fontSize: 14, fontWeight: 500,
      padding: '4px 12px', borderRadius: 6,
      background: loc.pathname.startsWith(to) ? '#21262D' : 'transparent',
      transition: 'all 0.15s'
    }}>{label}</Link>
  );
  return (
    <nav style={{
      height: 56, background: '#161B22', borderBottom: '1px solid #30363D',
      display: 'flex', alignItems: 'center', padding: '0 20px',
      justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100
    }}>
      <Logo />
      <div style={{ display: 'flex', gap: 4 }}>
        {navItem('/dashboard', 'Dashboard')}
        {navItem('/builder', 'Builder')}
      </div>
      <div style={{ fontSize: 12, color: '#8B949E', fontFamily: 'JetBrains Mono, monospace' }}>
        AWS Terraform Generator v1.0
      </div>
    </nav>
  );
}
