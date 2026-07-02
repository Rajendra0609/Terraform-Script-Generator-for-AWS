import React, { useState, useEffect } from 'react';
import { learnAPI } from '../api/client';

const DIFF_COLORS = { Beginner: '#34D399', Intermediate: '#FCD34D', Advanced: '#FB7185' };

function ProgressBar({ completed, total, c }) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: c.bg3, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#34D399' : c.accent, borderRadius: 2, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontSize: 10, color: c.fg3, width: 34, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

export default function ScenarioLabs({ c, onApplyPattern }) {
  const [labs, setLabs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeLab, setActiveLab] = useState(null);
  const [progress, setProgress] = useState({}); // { labId: Set<stepId> }
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    learnAPI.getLabs().then(r => { setLabs(r.data.labs || []); setLoading(false); }).catch(() => setLoading(false));
    // Load local progress from localStorage as fallback
    try {
      const saved = JSON.parse(localStorage.getItem('lab_progress') || '{}');
      const parsed = {};
      Object.entries(saved).forEach(([k, v]) => { parsed[k] = new Set(v); });
      setProgress(parsed);
    } catch {}
  }, []);

  const saveProgress = (labId, stepId, done) => {
    setProgress(prev => {
      const next = { ...prev };
      if (!next[labId]) next[labId] = new Set();
      else next[labId] = new Set(next[labId]);
      if (done) next[labId].add(stepId); else next[labId].delete(stepId);
      // Persist to localStorage
      const toSave = {};
      Object.entries(next).forEach(([k, v]) => { toSave[k] = [...v]; });
      try { localStorage.setItem('lab_progress', JSON.stringify(toSave)); } catch {}
      return next;
    });
    learnAPI.saveProgress(labId, stepId, done).catch(() => {});
  };

  const categories = ['all', ...new Set(labs.map(l => l.category))];
  const filtered = filter === 'all' ? labs : labs.filter(l => l.category === filter);

  const s = {
    wrap: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
    toolbar: { padding: '12px 16px 10px', borderBottom: `1px solid ${c.bd}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    title: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.fg3, flex: 1 },
    chip: (active) => ({ padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? c.accent : c.bd}`, background: active ? c.accent + '20' : 'transparent', color: active ? c.accent : c.fg3 }),
    list: { flex: 1, overflow: 'auto', padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, alignContent: 'start' },
    card: { background: c.bg2, border: `1px solid ${c.bd}`, borderRadius: 12, padding: 14, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, transition: 'border-color 0.15s, box-shadow 0.15s' },
    labDetail: { flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 },
  };

  if (activeLab) {
    const prog = progress[activeLab.id] || new Set();
    const completed = activeLab.steps.filter(s => prog.has(s.id)).length;
    return (
      <div style={s.wrap}>
        <div style={{ ...s.toolbar, gap: 12 }}>
          <button onClick={() => setActiveLab(null)} style={{ background: 'none', border: 'none', color: c.accent, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
            ← Back to Labs
          </button>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: c.fg }}>{activeLab.icon} {activeLab.title}</div>
          <span style={{ fontSize: 11, color: DIFF_COLORS[activeLab.difficulty], fontWeight: 600 }}>{activeLab.difficulty}</span>
          <span style={{ fontSize: 11, color: c.fg3 }}>⏱ {activeLab.duration}</span>
        </div>

        <div style={s.labDetail}>
          <p style={{ fontSize: 13, color: c.fg2, margin: 0, lineHeight: 1.6 }}>{activeLab.description}</p>

          <div style={{ background: c.bg2, border: `1px solid ${c.bd}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.fg3, marginBottom: 10 }}>
              Progress — {completed}/{activeLab.steps.length} steps
            </div>
            <ProgressBar completed={completed} total={activeLab.steps.length} c={c} />
          </div>

          {activeLab.patternId && onApplyPattern && (
            <button onClick={() => onApplyPattern(activeLab.patternId)}
              style={{ padding: '9px 16px', borderRadius: 8, border: `1px solid ${c.accent}`, background: c.accent + '15', color: c.accent, fontWeight: 700, fontSize: 12, cursor: 'pointer', alignSelf: 'flex-start' }}>
              ⚡ Load Pattern into Builder
            </button>
          )}

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.fg3, marginBottom: 10 }}>
              Objectives
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {activeLab.objectives.map((o, i) => (
                <li key={i} style={{ fontSize: 12, color: c.fg2, lineHeight: 1.5 }}>{o}</li>
              ))}
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.fg3, marginBottom: 10 }}>
              Steps
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeLab.steps.map((step) => {
                const done = prog.has(step.id);
                return (
                  <div key={step.id} style={{ background: done ? '#34D39912' : c.bg3, border: `1px solid ${done ? '#34D39940' : c.bd}`, borderRadius: 9, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <button onClick={() => saveProgress(activeLab.id, step.id, !done)}
                      style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${done ? '#34D399' : c.bd}`, background: done ? '#34D399' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1, color: '#001A0F', fontSize: 12, fontWeight: 800 }}>
                      {done ? '✓' : ''}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: done ? '#34D399' : c.fg, marginBottom: 4 }}>
                        Step {step.id}: {step.title}
                      </div>
                      <div style={{ fontSize: 12, color: c.fg2, lineHeight: 1.5 }}>{step.description}</div>
                      <div style={{ fontSize: 11, color: c.fg3, marginTop: 6, fontStyle: 'italic' }}>
                        💡 {step.checkHint}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.toolbar}>
        <div style={s.title}>🧪 Guided Scenario Labs — {labs.length} labs</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {categories.map(cat => (
            <span key={cat} style={s.chip(filter === cat)} onClick={() => setFilter(cat)}>{cat === 'all' ? 'All' : cat}</span>
          ))}
        </div>
      </div>

      <div style={s.list}>
        {loading && <div style={{ gridColumn: '1/-1', textAlign: 'center', color: c.fg3, fontSize: 12, padding: 30 }}>Loading labs…</div>}
        {filtered.map(lab => {
          const prog = progress[lab.id] || new Set();
          const completed = lab.steps.filter(s => prog.has(s.id)).length;
          return (
            <div key={lab.id} style={s.card}
              onClick={() => setActiveLab(lab)}
              onMouseEnter={e => { e.currentTarget.style.borderColor = c.accent + '60'; e.currentTarget.style.boxShadow = `0 0 0 1px ${c.accent}20`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = c.bd; e.currentTarget.style.boxShadow = 'none'; }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24 }}>{lab.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: c.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lab.title}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                    <span style={{ fontSize: 10, color: DIFF_COLORS[lab.difficulty], fontWeight: 600 }}>{lab.difficulty}</span>
                    <span style={{ fontSize: 10, color: c.fg3 }}>⏱ {lab.duration}</span>
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: c.fg2, margin: 0, lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{lab.description}</p>
              <ProgressBar completed={completed} total={lab.steps.length} c={c} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
