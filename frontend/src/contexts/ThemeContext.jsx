import React, { createContext, useContext, useEffect } from 'react';

const ThemeContext = createContext();

const LIGHT_THEME = {
  bg:          '#FFFFFF',
  bg2:         '#F0F4FB',
  bg3:         '#E4EAF6',
  bg4:         '#D8E2F2',
  bd:          '#C5D2E8',
  bd2:         '#B0C2DC',
  fg:          '#0F1E3A',
  fg2:         '#4A6080',
  fg3:         '#8A9EB8',
  accent:      '#00A87C',
  accentHover: '#009070',
  accentSoft:  '#00A87C15',
  accentBd:    '#00A87C40',
  ok:          '#00A87C',
  okBg:        '#00A87C10',
  err:         '#E53E52',
  errBg:       '#E53E5210',
  warn:        '#D97706',
  warnBg:      '#D9770610',
  info:        '#2563EB',
  infoBg:      '#2563EB10',
  inputBg:     '#FFFFFF',
  catCompute:  '#4F46E5',
  catStorage:  '#059669',
  catNetwork:  '#0284C7',
  catDatabase: '#7C3AED',
  catSecurity: '#DC2626',
  catMonitor:  '#16A34A',
  catContain:  '#0891B2',
  catCICD:     '#B45309',
  catAdmin:    '#6D28D9',
};

export function ThemeProvider({ children }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('tfgen.theme', 'light');
  }, []);

  const isDark = false;
  const toggle = () => {};
  const c = LIGHT_THEME;

  return (
    <ThemeContext.Provider value={{ isDark, toggle, c }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
