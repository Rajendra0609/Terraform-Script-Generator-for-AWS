import React, { useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';

const TYPES = ['string', 'number', 'bool', 'list(string)', 'map(string)', 'any'];

const EMPTY_VAR = { name: '', type: 'string', default: '', description: '', sensitive: false, validation: null };

/**
 * VariablesEditor — manage Terraform variable definitions.
 *
 * Props:
 *   variables   — { [name]: { type, default, description, sensitive, validation } }
 *   onChange    — (variables) => void
 */
export default function VariablesEditor({ variables = {}, onChange }) {
  const { c } = useTheme();
  const [editing, setEditing] = useState(null); // null | 'new' | varName
  const [form, setForm] = useState(EMPTY_VAR);
  const [valEnabled, setValEnabled] = useState(false);

  const entries = Object.entries(variables);

  function openNew() {
    setForm(EMPTY_VAR);
    setValEnabled(false);
    setEditing('new');
  }

  function openEdit(name) {
    const v = variables[name];
    setForm({ name, ...v });
    setValEnabled(!!v.validation);
    setEditing(name);
  }

  function remove(name) {
    const next = { ...variables };
    delete next[name];
    onChange(next);
  }

  function save() {
    if (!form.name.trim()) return;
    const { name, ...rest } = form;
    const varDef = {
      type:        rest.type        || 'string',
      description: rest.description || '',
      sensitive:   rest.sensitive   || false,
    };
    if (rest.default !== '' && rest.default !== undefined) varDef.default = rest.default;
    if (valEnabled && rest.validation?.condition) varDef.validation = rest.validation;
    const next = { ...variables, [name.trim()]: varDef };
    if (editing && editing !== 'new' && editing !== name.trim()) delete next[editing];
    onChange(next);
    setEditing(null);
  }

  // Shared inline style helpers
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
          Variables
        </span>
        <button
          onClick={openNew}
          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#2563EB', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          + Add
        </button>
      </div>

      {entries.length === 0 && !editing && (
        <p style={{ fontSize: 11, color: c.fg3, fontStyle: 'italic', margin: 0 }}>No variables defined.</p>
      )}

      {entries.map(([name, v]) => (
        <div key={name} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, padding: '6px 12px', borderRadius: 5,
          background: c.bg2, border: `1px solid ${c.bd}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: c.fg }}>{name}</span>
            <span style={{ marginLeft: 8, fontSize: 10, color: c.fg3 }}>({v.type || 'string'})</span>
            {v.sensitive && <span style={{ marginLeft: 4, fontSize: 10, color: '#f97316' }}>🔒 sensitive</span>}
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
              <label style={labelStyle}>Type</label>
              <select
                style={inputStyle}
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              >
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Default value</label>
            <input
              style={inputStyle}
              value={form.default || ''}
              onChange={e => setForm(f => ({ ...f, default: e.target.value }))}
              placeholder="Leave empty for required variable"
            />
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
            <span style={{ fontSize: 12, color: c.fg }}>Sensitive (mask value in logs)</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={valEnabled}
              onChange={e => setValEnabled(e.target.checked)}
            />
            <span style={{ fontSize: 12, color: c.fg }}>Add validation block</span>
          </label>

          {valEnabled && (
            <div style={{ paddingLeft: 12, borderLeft: `2px solid ${c.accentBd}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <label style={labelStyle}>Condition (HCL expression)</label>
                <input
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                  value={form.validation?.condition || ''}
                  onChange={e => setForm(f => ({ ...f, validation: { ...(f.validation || {}), condition: e.target.value } }))}
                  placeholder='can(regex("^[a-z]+$", var.name))'
                />
              </div>
              <div>
                <label style={labelStyle}>Error message</label>
                <input
                  style={inputStyle}
                  value={form.validation?.error_message || ''}
                  onChange={e => setForm(f => ({ ...f, validation: { ...(f.validation || {}), error_message: e.target.value } }))}
                />
              </div>
            </div>
          )}

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
