import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ServiceSelector from '../components/ServiceSelector';
import ConfigPanel from '../components/ConfigPanel';
import CodePreview from '../components/CodePreview';
import ValidationPanel from '../components/ValidationPanel';
import { useToast, ToastContainer } from '../components/Toast';
import { projectsAPI, templatesAPI, terraformAPI } from '../api/client';
import { generateHCL, generateProviderBlock, buildFullHCL } from '../engine/templateEngine';
import { getAwsRegionLabel } from '../utils/awsRegions';

const BTN = ({ onClick, color, children, disabled, style = {} }) => (
  <button onClick={onClick} disabled={disabled} style={{
    padding: '8px 16px', borderRadius: 7, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13, fontWeight: 600, background: color || '#21262D',
    color: color ? '#fff' : '#E6EDF3', opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
    display: 'flex', alignItems: 'center', gap: 6, ...style
  }}>{children}</button>
);

function ResourceTabs({ resources, activeIdx, onSelect, onRemove }) {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '10px 16px', borderBottom: '1px solid #30363D', flexWrap: 'wrap' }}>
      {resources.map((r, i) => (
        <div key={r._id} onClick={() => onSelect(i)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            background: i === activeIdx ? '#21262D' : 'transparent',
            border: `1px solid ${i === activeIdx ? '#7B42BC' : '#30363D'}`,
            color: i === activeIdx ? '#E6EDF3' : '#8B949E', fontSize: 12, fontWeight: 500
          }}>
          <span>{r.label}</span>
          {r.is_module && <span style={{ fontSize: 9, background: '#7B42BC33', color: '#9F6FD0', padding: '1px 4px', borderRadius: 3 }}>M</span>}
          <span onClick={e => { e.stopPropagation(); onRemove(i); }}
            style={{ marginLeft: 2, color: '#8B949E', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</span>
        </div>
      ))}
      {resources.length === 0 && <span style={{ fontSize: 12, color: '#484F58' }}>Add a service from the left panel →</span>}
    </div>
  );
}

export default function Builder() {
  const { projectId } = useParams();
  const nav = useNavigate();
  const { toasts, show } = useToast();

  const [project, setProject]       = useState(null);
  const [services, setServices]     = useState([]);
  const [resources, setResources]   = useState([]);
  const [activeIdx, setActiveIdx]   = useState(0);
  const [fullHCL, setFullHCL]       = useState('');
  const [validResult, setValidResult] = useState(null);
  const [validType, setValidType]   = useState(null);
  const [validLoading, setValidLoading] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [showPanel, setShowPanel]   = useState(false);

  // Load templates from backend
  useEffect(() => {
    templatesAPI.list().then(r => setServices(r.data)).catch(() => show('Cannot load templates from backend', 'error'));
  }, []);

  // Load existing project
  useEffect(() => {
    if (!projectId) return;
    projectsAPI.get(projectId).then(r => {
      setProject(r.data);
      if (r.data.resources?.length) {
        const mapped = r.data.resources.map(res => ({
          _id: Math.random().toString(36).slice(2),
          service_type: res.service_type,
          label: services.find(s => s.service_type === res.service_type)?.label || res.service_type,
          schema_def: services.find(s => s.service_type === res.service_type)?.schema_def || [],
          template_body: services.find(s => s.service_type === res.service_type)?.template_body || '',
          module_body: services.find(s => s.service_type === res.service_type)?.module_body || null,
          category: services.find(s => s.service_type === res.service_type)?.category || '',
          config: res.config,
          is_module: res.is_module,
          hcl_output: res.hcl_output,
        }));
        setResources(mapped);
      }
    }).catch(() => show('Project not found', 'error'));
  }, [projectId, services]);

  // Rebuild full HCL whenever resources change
  const rebuildHCL = useCallback((res) => {
    const region = project?.aws_region || 'ap-south-1';
    const environment = project?.environment || 'dev';
    const backendConfig = project?.backend_config || {};
    const variables = res.reduce((acc, r) => ({ ...acc, ...r.variables }), {});
    const outputs = res.reduce((acc, r) => ({ ...acc, ...r.outputs }), {});
    setFullHCL(buildFullHCL(res, region, environment, backendConfig, variables, outputs));
  }, [project]);

  useEffect(() => { rebuildHCL(resources); }, [resources, rebuildHCL]);

  const handleAddService = (svc) => {
    const defaults = {};
    (svc.schema_def || []).forEach(f => { defaults[f.id] = f.default || ''; });
    const environment = project?.environment || 'dev';
    const hcl = generateHCL(svc.template_body || '', defaults, environment);
    const newRes = {
      _id: Math.random().toString(36).slice(2),
      service_type: svc.service_type,
      label: svc.label,
      schema_def: svc.schema_def,
      template_body: svc.template_body,
      module_body: svc.module_body,
      category: svc.category,
      config: defaults,
      variables: {},
      outputs: {},
      is_module: false,
      hcl_output: hcl,
      icon: svc.icon,
    };
    const updated = [...resources, newRes];
    setResources(updated);
    setActiveIdx(updated.length - 1);
    setValidResult(null);
  };

  const handleConfigChange = (config, hcl) => {
    const updated = resources.map((r, i) => i === activeIdx ? { ...r, config, hcl_output: hcl } : r);
    setResources(updated);
    setValidResult(null);
  };

  const handleToggleModule = () => {
    const r = resources[activeIdx];
    if (!r) return;
    const isModule = !r.is_module;
    const tpl = isModule ? r.module_body : r.template_body;
    const environment = project?.environment || 'dev';
    const hcl = tpl ? generateHCL(tpl, r.config, environment) : r.hcl_output;
    const updated = resources.map((res, i) => i === activeIdx ? { ...res, is_module: isModule, hcl_output: hcl } : res);
    setResources(updated);
  };

  const handleRemove = (idx) => {
    const updated = resources.filter((_, i) => i !== idx);
    setResources(updated);
    setActiveIdx(Math.max(0, idx - 1));
    setValidResult(null);
  };

  const handleValidate = async () => {
    if (!fullHCL) return show('No HCL to validate', 'warning');
    const clean = stripHtml(fullHCL);
    setValidLoading(true); setValidType('validate'); setValidResult(null); setShowPanel(true);
    try {
      const res = await terraformAPI.validate(clean);
      setValidResult(res.data);
      if (res.data.offline) show('Terraform CLI not on server', 'warning');
      else show(res.data.valid ? 'Valid ✓' : 'Validation failed', res.data.valid ? 'success' : 'error');
    } catch (e) { show('Validate request failed', 'error'); }
    finally { setValidLoading(false); }
  };

  const handleFmt = async () => {
    if (!fullHCL) return show('No HCL to format', 'warning');
    const clean = stripHtml(fullHCL);
    setValidLoading(true); setValidType('fmt'); setValidResult(null); setShowPanel(true);
    try {
      const res = await terraformAPI.fmt(clean);
      setValidResult(res.data);
      if (res.data.success) {
        setFullHCL(res.data.formatted);
        show('Formatted successfully', 'success');
      } else {
        show(res.data.offline ? 'Terraform CLI not available' : 'Format failed', 'warning');
      }
    } catch (e) { show('Fmt request failed', 'error'); }
    finally { setValidLoading(false); }
  };

  const handleSave = async () => {
    if (!projectId) return show('Open a project from Dashboard first', 'warning');
    setSaving(true);
    try {
      const res = resources.map((r, i) => ({
        service_type: r.service_type,
        resource_name: r.config?.name || r.label,
        config: r.config,
        is_module: r.is_module,
        module_source: '',
        hcl_output: r.hcl_output,
      }));
      await projectsAPI.saveResources(projectId, res);
      await projectsAPI.saveVersion(projectId, { full_hcl: stripHtml(fullHCL), resource_count: resources.length });
      show('Project saved ✓', 'success');
    } catch (e) { show('Save failed', 'error'); }
    finally { setSaving(false); }
  };

  const handleDownload = () => {
    if (!fullHCL) return show('No HCL to download', 'warning');
    const blob = new Blob([stripHtml(fullHCL)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project?.name || 'terraform'}.tf`;
    a.click();
    show('Downloaded main.tf', 'success');
  };

  function stripHtml(input) {
    if (!input) return '';
    // Remove HTML tags that may be present if colorized HTML was accidentally saved
    return input.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  const activeResource = resources[activeIdx] || null;

  return (
    <div style={{ height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ToastContainer toasts={toasts} />

      {/* Project Bar */}
      <div style={{ padding: '8px 16px', background: '#161B22', borderBottom: '1px solid #30363D', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={() => nav('/dashboard')} style={{ background: 'transparent', border: 'none', color: '#8B949E', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>←</button>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#E6EDF3' }}>{project?.name || 'New Project'}</div>
          <div style={{ fontSize: 11, color: '#8B949E' }}>
            {project?.aws_region ? getAwsRegionLabel(project.aws_region) : 'Select a project'}
          </div>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 8 }}>
          <BTN onClick={handleValidate} disabled={!fullHCL || validLoading}>
            <span>⬡</span> Validate
          </BTN>
          <BTN onClick={handleFmt} disabled={!fullHCL || validLoading}>
            <span>⌥</span> Format
          </BTN>
          <BTN onClick={handleDownload} disabled={!fullHCL}>
            <span>↓</span> Download .tf
          </BTN>
          {projectId && (
            <BTN onClick={handleSave} color="#7B42BC" disabled={saving}>
              {saving ? 'Saving...' : '💾 Save'}
            </BTN>
          )}
          {projectId && (
            <BTN onClick={() => nav(`/history/${projectId}`)}>
              📋 History
            </BTN>
          )}
        </div>
      </div>

      {/* Resource Tabs */}
      <div style={{ flexShrink: 0 }}>
        <ResourceTabs resources={resources} activeIdx={activeIdx} onSelect={setActiveIdx} onRemove={handleRemove} />
      </div>

      {/* 3-Panel Layout */}
      <div className="split-panel" style={{ flex: 1 }}>
        {/* Left: Service Selector */}
        <div className="panel-left">
          <ServiceSelector services={services} addedServices={resources} onAdd={handleAddService} />
        </div>

        {/* Center: Config */}
        <div className="panel-center">
          <ConfigPanel
            service={activeResource}
            config={activeResource?.config || {}}
            isModule={activeResource?.is_module || false}
            onChange={handleConfigChange}
            region={project?.aws_region || 'ap-south-1'}
            onToggleModule={handleToggleModule}
          />
        </div>

        {/* Right: Code Preview */}
        <div className="panel-right" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <CodePreview
              hcl={fullHCL}
              onHclChange={setFullHCL}
            />
          </div>
          {/* Validation Panel */}
          {showPanel && (
            <div style={{ borderTop: '1px solid #30363D', background: '#0D1117', maxHeight: 200, overflow: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #30363D' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#8B949E', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {validType === 'fmt' ? 'terraform fmt' : 'terraform validate'}
                </span>
                <button onClick={() => setShowPanel(false)} style={{ background: 'transparent', border: 'none', color: '#8B949E', cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
              <ValidationPanel result={validResult} type={validType} loading={validLoading} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
