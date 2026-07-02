import React, { useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';

const EMPTY_OUT = { name: '', value: '', description: '', sensitive: false };

/**
 * OutputsEditor — manage Terraform output definitions.
 *
 * Props:
 *   outputs   — { [name]: { value, description, sensitive } }
 *   onChange  — (outputs) => void
 */
export default function OutputsEditor({ outputs = {}, onChange }) {
  const { c } = useTheme();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_OUT);

  const entries = Object.entries(outputs);

  function openNew() { setForm(EMPTY_OUT); setEditing('new'); }
  function openEdit(name) { setForm({ name, ...outputs[name] }); setEditing(name); }

  function remove(name) {
    const next = { ...outputs };
    delete next[name];
    onChange(next);
  }

  function save() {
    if (!form.name.trim() || !form.value.trim()) return;
    const { name, ...rest } = form;
    const out = { value: rest.value };
    if (rest.description) out.description = rest.description;
    if (rest.sensitive)   out.sensitive   = true;
    const next = { ...outputs, [name.trim()]: out };
    if (editing && editing !== 'new' && editing !== name.trim()) delete next[editing];
    onChange(next);
    setEditing(null);
  }

  const inputStyle = {
    width: '100%', fontSize: 12, padding: '4px 8px', borderRadius: 4,
    border: `1px solid ${c.bd}`, background: c.inputBg,
    color: c.fg, outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: 11, color: c.fg2, marginBottom: 2 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: c.fg2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Outputs
        </span>
        <button
          onClick={openNew}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#2563EB', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          + Add
        </button>
      </div>

      {entries.length === 0 && !editing && (
        <p style={{ fontSize: 11, color: c.fg3, fontStyle: 'italic', margin: 0 }}>No outputs defined.</p>
      )}

      {entries.map(([name, o]) => (
        <div key={name} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, padding: '6px 12px', borderRadius: 5,
          background: c.bg2, border: `1px solid ${c.bd}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: c.fg }}>{name}</span>
            <span style={{
              marginLeft: 8, fontSize: 10, color: c.fg3, fontFamily: 'monospace',
              maxWidth: 200, display: 'inline-block', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
            }}>
              {o.value}
            </span>
            {o.sensitive && <span style={{ marginLeft: 4, fontSize: 10, color: '#f97316' }}>🔒</span>}
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => openEdit(name)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, color: '#2563EB', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              Edit
            </button>
            <button
              onClick={() => remove(name)}
              style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {editing !== null && (
        <div style={{
          marginTop: 4, padding: 12, borderRadius: 6,
          border: `1px solid ${c.accentBd}`, background: c.accentSoft,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Name *</label>
              <input
                style={inputStyle}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label style={labelStyle}>Value expression *</label>
              <input
                style={{ ...inputStyle, fontFamily: 'monospace' }}
                value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder="aws_instance.main.id"
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Description</label>
            <input
              style={inputStyle}
              value={form.description || ''}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.sensitive || false}
              onChange={e => setForm(f => ({ ...f, sensitive: e.target.checked }))}
            />
            <span style={{ fontSize: 12, color: c.fg }}>Sensitive output</span>
          </label>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button
              onClick={() => setEditing(null)}
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 5, border: `1px solid ${c.bd}`, color: c.fg, background: c.bg, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={save}
              style={{ fontSize: 12, padding: '4px 12px', borderRadius: 5, background: '#2563EB', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
