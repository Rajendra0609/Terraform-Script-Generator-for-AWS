import React, { useState, useCallback, useRef } from 'react';
import { diagramAPI } from '../api/client';
import { downloadSvg, downloadPng, downloadPdf, downloadDrawio } from '../utils/svgExport';

const ACCEPTED_EXT = ['.tf', '.tfvars'];

export default function ArchitectureDiagram({ c, hcl }) {
  const [inputMode, setInputMode] = useState('project'); // project | paste | upload
  const [pastedHcl, setPastedHcl] = useState('');
  const [files, setFiles] = useState([]); // [{filename, content}]
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { architecture, svg, svgWidth, svgHeight, drawioXml, warnings, stats }
  const [zoom, setZoom] = useState(1);
  const [showWarnings, setShowWarnings] = useState(false);
  const [exporting, setExporting] = useState('');
  const fileInputRef = useRef();
  const viewportRef = useRef();

  const currentHclLength = inputMode === 'project' ? (hcl || '').length : inputMode === 'paste' ? pastedHcl.length : files.reduce((s, f) => s + f.content.length, 0);

  const addFiles = useCallback(async (fileList) => {
    const picked = Array.from(fileList).filter(f => ACCEPTED_EXT.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (!picked.length) { setError('Please choose .tf or .tfvars files.'); return; }
    const read = await Promise.all(picked.map(async f => ({ filename: f.name, content: await f.text() })));
    setFiles(prev => [...prev, ...read]);
    setError('');
  }, []);

  const generate = useCallback(async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      let body;
      if (inputMode === 'project') {
        if (!hcl || !hcl.trim()) { setError('No generated Terraform in the current project yet — add some resources first, or switch to Paste / Upload.'); setLoading(false); return; }
        body = { hcl };
      } else if (inputMode === 'paste') {
        if (!pastedHcl.trim()) { setError('Paste some Terraform HCL first.'); setLoading(false); return; }
        body = { hcl: pastedHcl };
      } else {
        if (!files.length) { setError('Upload at least one .tf file first.'); setLoading(false); return; }
        body = { files };
      }
      const r = await diagramAPI.generate(body);
      setResult(r.data);
      setZoom(1);
      if (!r.data.architecture) {
        setError(r.data.warnings?.[0] || 'No AWS resources were found to diagram.');
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Diagram generation failed.');
    } finally {
      setLoading(false);
    }
  }, [inputMode, hcl, pastedHcl, files]);

  const doExport = useCallback(async (format) => {
    if (!result?.svg) return;
    setExporting(format);
    try {
      const base = `aws-architecture-${Date.now()}`;
      if (format === 'svg') downloadSvg(result.svg, `${base}.svg`);
      else if (format === 'png') await downloadPng(result.svg, result.svgWidth, result.svgHeight, `${base}.png`, 2);
      else if (format === 'pdf') await downloadPdf(result.svg, result.svgWidth, result.svgHeight, `${base}.pdf`, 2);
      else if (format === 'drawio') downloadDrawio(result.drawioXml, `${base}.drawio`);
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    } finally {
      setExporting('');
    }
  }, [result]);

  const fitToScreen = useCallback(() => {
    if (!result?.svgWidth || !viewportRef.current) return;
    const pad = 40;
    const vw = viewportRef.current.clientWidth - pad;
    const vh = viewportRef.current.clientHeight - pad;
    const scale = Math.min(vw / result.svgWidth, vh / result.svgHeight, 1.5);
    setZoom(Math.max(0.15, scale));
  }, [result]);

  const tabBtn = (id, label) => (
    <button
      onClick={() => setInputMode(id)}
      style={{
        padding: '6px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 6, border: `1px solid ${inputMode === id ? c.accent : c.bd}`,
        background: inputMode === id ? c.accent : c.bg2, color: inputMode === id ? '#fff' : c.fg2, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  const exportBtn = (id, label) => (
    <button
      onClick={() => doExport(id)}
      disabled={!result?.svg || !!exporting}
      style={{
        padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: `1px solid ${c.bd}`,
        background: c.bg2, color: c.fg2, cursor: result?.svg ? 'pointer' : 'not-allowed', opacity: result?.svg ? 1 : 0.5,
      }}
    >
      {exporting === id ? '…' : label}
    </button>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: c.bg }}>
      {/* Toolbar */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${c.bd}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: c.fg, marginRight: 8 }}>AWS Architecture Diagram</div>
          {tabBtn('project', 'Current Project')}
          {tabBtn('paste', 'Paste HCL')}
          {tabBtn('upload', 'Upload Files')}
          <div style={{ flex: 1 }} />
          <button
            onClick={generate}
            disabled={loading || currentHclLength === 0}
            style={{
              padding: '7px 16px', fontSize: 12.5, fontWeight: 700, borderRadius: 6, border: 'none',
              background: currentHclLength === 0 ? c.bd : c.accent, color: '#fff',
              cursor: currentHclLength === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Generating…' : '⚡ Generate Diagram'}
          </button>
        </div>

        {inputMode === 'project' && (
          <div style={{ fontSize: 11.5, color: c.fg3 }}>
            Uses the Terraform currently generated for this project ({(hcl || '').length.toLocaleString()} chars).
          </div>
        )}

        {inputMode === 'paste' && (
          <textarea
            value={pastedHcl}
            onChange={e => setPastedHcl(e.target.value)}
            placeholder='Paste Terraform HCL here, e.g. resource "aws_vpc" "main" { ... }'
            spellCheck={false}
            style={{
              width: '100%', height: 140, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: 10,
              borderRadius: 6, border: `1px solid ${c.bd}`, background: c.bg2, color: c.fg, resize: 'vertical',
            }}
          />
        )}

        {inputMode === 'upload' && (
          <div>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? c.accent : c.bd}`, borderRadius: 8, padding: 16, textAlign: 'center',
                cursor: 'pointer', fontSize: 12.5, color: c.fg3, background: dragging ? c.bg3 : 'transparent',
              }}
            >
              Drop .tf files here, or click to browse ({files.length} loaded)
              <input ref={fileInputRef} type="file" multiple accept=".tf,.tfvars" style={{ display: 'none' }}
                onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </div>
            {files.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {files.map((f, i) => (
                  <span key={i} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 12, background: c.bg2, border: `1px solid ${c.bd}`, color: c.fg2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {f.filename}
                    <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: c.fg3, fontSize: 12, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12, color: '#DC2626', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 6, padding: '8px 10px' }}>
            {error}
          </div>
        )}
      </div>

      {/* Result toolbar: stats, warnings, zoom, export */}
      {result?.svg && (
        <div style={{ padding: '8px 16px', borderBottom: `1px solid ${c.bd}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: c.bg2 }}>
          <span style={{ fontSize: 11.5, color: c.fg3 }}>
            {result.stats.mapped_resources} mapped · {result.stats.uncategorized_resources} uncategorized · {result.stats.vpc_count} VPC{result.stats.vpc_count !== 1 ? 's' : ''} · {result.stats.connection_count} connections
          </span>
          {result.warnings?.length > 0 && (
            <button onClick={() => setShowWarnings(s => !s)} style={{ fontSize: 11.5, color: '#B45309', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
              ⚠ {result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''} {showWarnings ? '▲' : '▼'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={() => setZoom(z => Math.max(0.15, z - 0.15))} style={{ ...zoomBtnStyle(c) }}>−</button>
          <span style={{ fontSize: 11.5, color: c.fg3, minWidth: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3, z + 0.15))} style={{ ...zoomBtnStyle(c) }}>+</button>
          <button onClick={fitToScreen} style={{ ...zoomBtnStyle(c), width: 'auto', padding: '0 10px' }}>Fit</button>
          <div style={{ width: 1, height: 20, background: c.bd, margin: '0 4px' }} />
          {exportBtn('svg', 'SVG')}
          {exportBtn('png', 'PNG')}
          {exportBtn('pdf', 'PDF')}
          {exportBtn('drawio', 'Draw.io')}
        </div>
      )}

      {result?.warnings?.length > 0 && showWarnings && (
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${c.bd}`, background: '#FFFBEB', maxHeight: 140, overflow: 'auto' }}>
          {result.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11.5, color: '#92600F', padding: '2px 0' }}>• {w}</div>
          ))}
        </div>
      )}

      {/* Diagram viewport */}
      <div ref={viewportRef} style={{ flex: 1, overflow: 'auto', position: 'relative', background: '#FAFAFA' }}>
        {!result?.svg && !loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: c.fg3, padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 34 }}>🗺️</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: c.fg2, maxWidth: 380 }}>
              Generate an AWS-style architecture diagram from Terraform
            </div>
            <div style={{ fontSize: 12, maxWidth: 380, lineHeight: 1.5 }}>
              Groups resources by VPC, Availability Zone, and public/private subnet, infers traffic flow, and exports to SVG, PNG, PDF, or Draw.io.
            </div>
          </div>
        )}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.fg3, fontSize: 13 }}>
            Parsing Terraform and laying out the diagram…
          </div>
        )}
        {result?.svg && (
          <div style={{ padding: 24, display: 'inline-block', minWidth: '100%', boxSizing: 'border-box' }}>
            <div
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: result.svgWidth, height: result.svgHeight }}
              dangerouslySetInnerHTML={{ __html: result.svg }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function zoomBtnStyle(c) {
  return {
    width: 26, height: 26, borderRadius: 6, border: `1px solid ${c.bd}`, background: c.bg,
    color: c.fg2, cursor: 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', padding: 0,
  };
}
