import React, { useState, useEffect } from 'react';
import { learnAPI } from '../api/client';

export default function InterviewPanel({ resources = [], c }) {
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [openIdx, setOpenIdx] = useState(null);
  const [filter, setFilter] = useState('all');

  const serviceKeys = [...new Set(resources.map(r => r.service_type || r.serviceType).filter(Boolean))];

  useEffect(() => {
    setLoading(true);
    learnAPI.questions(serviceKeys)
      .then(r => setQuestions(r.data.questions || []))
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false));
  }, [serviceKeys.join(',')]); // eslint-disable-line

  const categories = ['all', 'General', ...serviceKeys];
  const filtered = filter === 'all' ? questions
    : filter === 'General' ? questions.slice(0, 6)
    : questions.filter((_, i) => i >= 6);

  const s = {
    wrap: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
    header: { padding: '12px 16px 8px', borderBottom: `1px solid ${c.bd}` },
    title: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: c.fg3, marginBottom: 8 },
    chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
    chip: (active) => ({ padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${active ? c.accent : c.bd}`, background: active ? c.accent + '20' : 'transparent', color: active ? c.accent : c.fg3 }),
    list: { flex: 1, overflow: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
    qCard: (open) => ({ background: open ? c.bg2 : c.bg3, border: `1px solid ${open ? c.accent + '40' : c.bd}`, borderRadius: 9, overflow: 'hidden', cursor: 'pointer', transition: 'all 0.15s' }),
    qHead: { padding: '10px 14px', fontSize: 12, fontWeight: 600, color: c.fg, display: 'flex', alignItems: 'flex-start', gap: 8 },
    qBody: { padding: '0 14px 12px 30px', fontSize: 12, color: c.fg2, lineHeight: 1.6 },
    empty: { textAlign: 'center', color: c.fg3, fontSize: 12, padding: 30, fontStyle: 'italic' },
  };

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.title}>📋 Interview Questions — {questions.length} questions</div>
        <div style={s.chips}>
          {categories.map(cat => (
            <span key={cat} style={s.chip(filter === cat)} onClick={() => setFilter(cat)}>
              {cat === 'all' ? 'All' : cat}
            </span>
          ))}
        </div>
      </div>

      <div style={s.list}>
        {loading && <div style={s.empty}>Loading questions…</div>}
        {!loading && filtered.length === 0 && (
          <div style={s.empty}>
            Add services to your project to see relevant interview questions.
          </div>
        )}
        {!loading && filtered.map((q, i) => (
          <div key={i} style={s.qCard(openIdx === i)} onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <div style={s.qHead}>
              <span style={{ color: c.accent, fontSize: 13, marginTop: -1 }}>{openIdx === i ? '▾' : '▸'}</span>
              <span>{q.q}</span>
            </div>
            {openIdx === i && (
              <div style={s.qBody}>{q.a}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
