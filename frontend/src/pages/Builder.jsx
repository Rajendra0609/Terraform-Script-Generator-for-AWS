import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ServiceSelector from '../components/ServiceSelector';
import ConfigPanel from '../components/ConfigPanel';
import CodePreview from '../components/CodePreview';
import AdvancedFilesEditor from '../components/AdvancedFilesEditor';
import ValidationPanel from '../components/ValidationPanel';
import PlanDiffPanel from '../components/PlanDiffPanel';
import SecurityFindings from '../components/SecurityFindings';
import CostBadge from '../components/CostBadge';
import ResourceGraph from '../components/ResourceGraph';
import PresetsPanel from '../components/PresetsPanel';
import LintPanel from '../components/LintPanel';
import VariablesEditor from '../components/VariablesEditor';
import OutputsEditor from '../components/OutputsEditor';
import sanitizeHcl from '../utils/sanitizeHcl';
import { useToast, ToastContainer } from '../components/Toast';
import { useTheme } from '../contexts/ThemeContext';
import { projectsAPI, templatesAPI, terraformAPI, jobsAPI } from '../api/client';
import { generateHCL, buildFullHCL, buildSplitHCL, detectSecretsInHcl } from '../engine/templateEngine';
import { getAwsRegionLabel, DEFAULT_AWS_REGION } from '../utils/awsRegions';
import { applyWiringToAll } from '../utils/dependencyWiring';
import HclExplainer from '../components/HclExplainer';
import InterviewPanel from '../components/InterviewPanel';
import { ApplyStatusPanel } from '../components/ApplyStatusPanel';
import { awsAPI } from '../api/client';
import ScenarioLabs from '../components/ScenarioLabs';
import ArchPatternPicker from '../components/ArchPatternPicker';
import IamPolicyModal from '../components/IamPolicyModal';
import StateInspector from '../components/StateInspector';
import ChangeRequestPanel from '../components/ChangeRequestPanel';
import ModuleRegistry from '../components/ModuleRegistry';
import MultiEnvPanel from '../components/MultiEnvPanel';
import BackendGenerator from '../components/BackendGenerator';
import TerragruntPanel from '../components/TerragruntPanel';

// --- Category colors (light-mode friendly) -----------------------------------
const CAT_COLOR = {
  'Compute':        '#4F46E5',
  'Storage':        '#059669',
  'Networking':     '#0284C7',
  'Database':       '#7C3AED',
  'IAM & Security': '#DC2626',
  'Monitoring':     '#16A34A',
  'Containers':     '#0891B2',
  'CI/CD':          '#B45309',
  'Admin & Ops':    '#6D28D9',
  'Analytics':      '#EA580C',
  'App Integration':'#0D9488',
  'Machine Learning':'#DB2777',
};

// --- Compact icon button -----------------------------------------------------
function IconBtn({ onClick, disabled, title, children, variant = 'default', c }) {
  const variants = {
    default: { bg: '#F8FAFC', border: '#E2E8F0', color: '#475569', hover: '#F1F5F9' },
    accent:  { bg: c.accent, border: c.accent, color: '#FFFFFF', hover: c.accentHover || '#009070' },
    ghost:   { bg: 'transparent', border: 'transparent', color: '#64748B', hover: '#F1F5F9' },
    success: { bg: '#F0FDF4', border: '#A7F3D0', color: '#059669', hover: '#DCFCE7' },
    danger:  { bg: '#FEF2F2', border: '#FECACA', color: '#DC2626', hover: '#FEE2E2' },
  };
  const v = variants[variant] || variants.default;
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 13px', borderRadius: 8, border: `1px solid ${v.border}`,
        background: hover && !disabled ? v.hover : v.bg, color: v.color,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        transition: 'all 0.15s ease', whiteSpace: 'nowrap',
        boxShadow: hover && !disabled ? '0 2px 4px rgba(0,0,0,0.06)' : 'none',
        transform: hover && !disabled ? 'translateY(-0.5px)' : 'none',
        letterSpacing: '0.01em',
      }}>
      {children}
    </button>
  );
}

// --- Resource tab -------------------------------------------------------------
// Dependency hierarchy — show a "L" prefix for resources that reference a parent
const PARENT_FIELDS = ['vpc_id', 'subnet_id', 'subnet_ids', 'vpc_zone_identifier'];
function getParentType(resource, resources) {
  const wf = resource.wiredFrom || {};
  for (const fid of PARENT_FIELDS) {
    if (wf[fid]?.sourceId) {
      const parent = resources.find(r => r._id === wf[fid].sourceId);
      if (parent) return parent.service_type;
    }
  }
  return null;
}

function ResTab({ resource, active, onSelect, onRemove, c, isChild }) {
  const color = CAT_COLOR[resource.category] || c.accent;
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '6px 12px 6px 10px', borderRadius: 8, cursor: 'pointer',
        border: active ? `1.5px solid ${color}` : `1px solid ${hover ? color + '60' : 'transparent'}`,
        background: active ? color + '12' : hover ? color + '06' : 'transparent',
        transition: 'all 0.15s ease', flexShrink: 0,
        marginLeft: isChild ? 8 : 0,
        boxShadow: active ? `0 2px 8px ${color}15` : 'none',
      }}>
      {/* Hierarchy prefix */}
      {isChild && <span style={{ fontSize: 10, color: '#9CA3AF', marginRight: -2 }}>L</span>}
      {/* Color dot */}
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}40` }} />
      <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? '#111827' : hover ? '#374151' : '#6B7280', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '0.01em' }}>
        {resource.label}
      </span>
      {resource.is_module && (
        <span style={{ fontSize: 9, background: color + '20', color, padding: '2px 6px', borderRadius: 4, fontWeight: 700, letterSpacing: '0.03em' }}>MOD</span>
      )}
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        aria-label={`Remove ${resource.label}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 5, background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 14, lineHeight: 1, padding: 0, transition: 'all 0.15s', opacity: hover || active ? 1 : 0 }}
        onMouseEnter={e => { e.currentTarget.style.background = '#FEE2E2'; e.currentTarget.style.color = '#DC2626'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#9CA3AF'; }}>
        ×
      </button>
    </div>
  );
}

// --- View mode tab ------------------------------------------------------------
function ViewTab({ id, label, active, onClick, c, badge }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '9px 16px', fontSize: 12, fontWeight: 600, border: 'none',
        cursor: 'pointer', fontFamily: 'inherit',
        background: active ? '#FFFFFF' : hover ? '#F3F4F6' : 'transparent',
        color: active ? '#059669' : hover ? '#374151' : '#9CA3AF',
        borderBottom: active ? '2.5px solid #059669' : '2.5px solid transparent',
        transition: 'all 0.18s ease', whiteSpace: 'nowrap',
        borderRadius: active ? '6px 6px 0 0' : '0',
        boxShadow: active ? '0 1px 3px rgba(5,150,105,0.08)' : 'none',
        letterSpacing: '0.01em',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}>
      {label}
      {badge && (
        <span title="AI-powered" style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700,
          background: active ? 'linear-gradient(135deg,#7C3AED,#2563EB)' : 'rgba(124,58,237,0.12)',
          color: active ? '#fff' : '#7C3AED',
        }}>{badge}</span>
      )}
    </button>
  );
}

// --- Toolbar Dropdown ---------------------------------------------------------
function ToolbarDropdown({ label, c, children, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handle = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;

    const updatePos = () => {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    };

    updatePos(); // compute immediately on open

    window.addEventListener('scroll', updatePos, true); // capture phase catches nested scrollers
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={btnRef}
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '6px 12px', borderRadius: 8, border: `1px solid ${open ? '#059669' : '#E2E8F0'}`,
          background: open ? '#F0FDF4' : '#F8FAFC', color: disabled ? '#CBD5E1' : open ? '#059669' : '#475569',
          cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
          fontFamily: 'inherit', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1,
          transition: 'all 0.15s ease', letterSpacing: '0.01em',
          boxShadow: open ? '0 2px 6px rgba(5,150,105,0.08)' : 'none',
        }}>
        {label} <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999,
          background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 12,
          boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 4px 8px rgba(0,0,0,0.06)', minWidth: 220, overflowY: 'auto',
          maxHeight: '400px', padding: '6px 0',
        }}>
          {React.Children.map(children, child => child && React.cloneElement(child, { closeMenu: () => setOpen(false) }))}
        </div>
      )}
    </div>
  );
}

function DropdownItem({ children, onClick, disabled, divider, closeMenu }) {
  if (divider) return <div style={{ height: 1, background: '#F1F5F9', margin: '4px 8px' }} />;
  return (
    <button
      onClick={e => { if (!disabled) { onClick?.(e); closeMenu?.(); } }}
      disabled={disabled}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '9px 16px', border: 'none', background: 'transparent',
        fontSize: 12.5, color: disabled ? '#CBD5E1' : '#374151',
        cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        transition: 'all 0.12s', fontWeight: 500, letterSpacing: '0.01em',
        borderRadius: 0,
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = '#F8FAFC'; e.currentTarget.style.color = '#059669'; } }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = disabled ? '#CBD5E1' : '#374151'; }}>
      {children}
    </button>
  );
}

// ─── PolicyResultsPanel — shows OPA eval results inline in the panel ──────────
function PolicyResultsPanel({ results }) {
  if (!results || results.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 12px', color: '#9CA3AF', fontSize: 13 }}>
        <div style={{ fontSize: 24, marginBottom: 6 }}>🛡</div>
        No policy results yet. Run a plan to evaluate governance rules.
      </div>
    );
  }

  const passed  = results.filter(r => r.passed);
  const failed  = results.filter(r => !r.passed);
  const blocked = failed.filter(r => r.policy?.blocks_plan);

  const SEV_COLOR = { CRITICAL: '#DC2626', HIGH: '#D97706', MEDIUM: '#2563EB', LOW: '#6B7280' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        {blocked.length > 0 && (
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', fontWeight: 700 }}>
            🚫 {blocked.length} blocking violation{blocked.length > 1 ? 's' : ''}
          </span>
        )}
        {failed.length > 0 && (
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E', fontWeight: 600 }}>
            ⚠ {failed.length} violation{failed.length > 1 ? 's' : ''}
          </span>
        )}
        {passed.length > 0 && (
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#F0FDF4', border: '1px solid #A7F3D0', color: '#065F46', fontWeight: 600 }}>
            ✅ {passed.length} passed
          </span>
        )}
      </div>

      {/* Failed policies first */}
      {failed.map((r, i) => (
        <div key={i} style={{
          borderRadius: 8, padding: '10px 12px',
          background: r.policy?.blocks_plan ? '#FEF2F2' : '#FFFBEB',
          border: `1px solid ${r.policy?.blocks_plan ? '#FECACA' : '#FDE68A'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#111827' }}>
              {r.policy?.blocks_plan ? '🚫' : '⚠'} {r.policy?.name}
            </span>
            {r.policy?.severity && (
              <span style={{ fontSize: 10, color: SEV_COLOR[r.policy.severity] || '#374151', fontWeight: 700, background: '#FFF', border: `1px solid ${SEV_COLOR[r.policy.severity]}30`, borderRadius: 4, padding: '1px 5px' }}>
                {r.policy.severity}
              </span>
            )}
            {r.policy?.blocks_plan && (
              <span style={{ fontSize: 10, background: '#DC2626', color: '#FFF', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>BLOCKED PLAN</span>
            )}
          </div>
          {r.violations?.map((v, j) => (
            <div key={j} style={{ fontSize: 12, color: '#374151', marginTop: 6, paddingLeft: 8, borderLeft: '2px solid #FECACA', lineHeight: 1.5 }}>
              {v}
            </div>
          ))}
          {r.error && (
            <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>Eval error: {r.error}</div>
          )}
        </div>
      ))}

      {/* Passed policies (collapsed by default) */}
      {passed.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 11, color: '#9CA3AF', cursor: 'pointer', padding: '4px 0' }}>
            ✅ Show {passed.length} passing {passed.length === 1 ? 'policy' : 'policies'}
          </summary>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {passed.map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: '#065F46', background: '#F0FDF4', border: '1px solid #A7F3D0', borderRadius: 6, padding: '6px 10px' }}>
                ✅ {r.policy?.name} <span style={{ color: '#9CA3AF' }}>({r.policy?.severity})</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// --- Main Builder -------------------------------------------------------------
export default function Builder() {
  const { projectId: _rawProjectId } = useParams();
  // Coerce the literal string "undefined" / "null" (JS interpolation artifacts) to
  // a proper JS undefined so all downstream guards (`!projectId`, `{projectId && …}`)
  // behave correctly even when the URL contains those strings.
  const projectId = (_rawProjectId && _rawProjectId !== 'undefined' && _rawProjectId !== 'null')
    ? _rawProjectId
    : undefined;
  const nav           = useNavigate();
  const { toasts, show } = useToast();
  const { c } = useTheme();
  const showRef = useRef(show);
  showRef.current = show;

  // -- Core state --------------------------------------------------------------
  const [project, setProject]     = useState(null);
  const [services, setServices]   = useState([]);
  const [resources, setResources] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [fullHCL, setFullHCL]     = useState('');
  const [splitFiles, setSplitFiles] = useState({});
  const [variables, setVariables] = useState({});
  const [outputs, setOutputs]     = useState({});

  // -- UI state -----------------------------------------------------------------
  const [viewMode, setViewMode]     = useState('code');
  const [showPresets, setShowPresets] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(() => localStorage.getItem('tfgen.advancedMode') === 'true');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [codeFlash, setCodeFlash] = useState(false);       // sync-flash for right panel
  const [centerWidth, setCenterWidth] = useState(320);     // resizable center panel (px)
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(null);
  const resizeStartW = useRef(null);
  // FE-08: tracks whether the user has ever manually dragged the center panel.
  // Once true, the auto-sizing effect no longer overrides their chosen width.
  const userResizedRef = useRef(false);

  // -- Operation state ----------------------------------------------------------
  const [saving, setSaving]           = useState(false);
  const [validResult, setValidResult] = useState(null);
  const [validType, setValidType]     = useState(null);
  const [validLoading, setValidLoading] = useState(false);
  const [showPanel, setShowPanel]     = useState(false);
  const [panelTab, setPanelTab]       = useState('output'); // 'output' | 'security' | 'cost'
  const [showArchPatterns, setShowArchPatterns] = useState(false);
  const [showIamModal, setShowIamModal]         = useState(false);
  const [showStateInspector, setShowStateInspector] = useState(false);
  const [showModuleRegistry, setShowModuleRegistry] = useState(false);
  const [showMultiEnv, setShowMultiEnv]             = useState(false);
  const [showBackendGen, setShowBackendGen]          = useState(false);
  const [showTerragrunt, setShowTerragrunt]         = useState(false);
  const [checkovResult, setCheckovResult] = useState(null);
  const [costEstimate, setCostEstimate]   = useState(null);
  const [logLines, setLogLines]           = useState([]);
  const [planDiff, setPlanDiff]           = useState(null);
  const [applyResult, setApplyResult]     = useState(null); // tracks last apply outcome
  const [policyResults, setPolicyResults] = useState(null);  // Phase 2: OPA policy eval results
  const [versions, setVersions]           = useState([]);    // Phase 2: CR version list
  // Phase 4: reorderable panel tab order persisted to localStorage
  const DEFAULT_TAB_ORDER = ['output','diff','security','cost','logs','policy','changes','apply'];
  const [tabOrder, setTabOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tfgen_panel_tab_order') || 'null') || DEFAULT_TAB_ORDER; }
    catch { return DEFAULT_TAB_ORDER; }
  });
  const [dragTabId, setDragTabId]   = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [hasCredentials, setHasCredentials] = useState(false); // whether user has AWS creds saved
  const [lastSaved, setLastSaved]         = useState(null);
  const wsRef = useRef(null);
  const mountedRef = useRef(true);

  // -- WebSocket teardown on unmount (FE-02) ------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.onmessage = null; // prevent setState on unmounted component
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // -- AWS credential check (needed to gate the Apply button) -------------------
  // We check once on mount; the Navbar already polls every 60 s and the user
  // can open Settings → AWS Credentials to connect — after which they reload
  // or navigate back and this re-fires. We expose a refresh function so the
  // Apply panel can tell the user to connect credentials if they try early.
  useEffect(() => {
    awsAPI.getCredentials()
      .then(r => setHasCredentials(!!r.data?.credentials))
      .catch(() => setHasCredentials(false));
  }, []);

  // -- Keyboard shortcuts -------------------------------------------------------
  // FE-04: Assign handler body to a ref on every render so it always captures
  // the latest state/functions. The useEffect below registers one stable
  // listener that dispatches through the ref — no stale closures, no
  // unnecessary listener re-registrations, no eslint-disable suppression needed.
  const keyHandlerRef = useRef(null);
  keyHandlerRef.current = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (projectId && !saving) handleSave(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (fullHCL && !validLoading) handleValidate(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') { e.preventDefault(); if (fullHCL && !validLoading) handleFmt(); }
    if (e.key === 'Escape') { setShowPanel(false); setShowPresets(false); }
  };
  useEffect(() => {
    const handler = (e) => keyHandlerRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []); // stable — registers once, always dispatches via fresh ref

  // -- Load services ------------------------------------------------------------
  useEffect(() => {
    templatesAPI.list()
      .then(r => setServices(r.data))
      .catch(() => showRef.current('Cannot load templates from backend', 'error'));
  }, []);

  // -- Load project -------------------------------------------------------------
  useEffect(() => {
    if (!projectId || !services.length) return;
    // Persist so the Navbar History link can navigate directly to this project's history.
    try { localStorage.setItem('tfgen.lastProjectId', projectId); } catch {}
    projectsAPI.get(projectId).then(r => {
      setProject(r.data);
      if (r.data.resources?.length) {
        const mapped = r.data.resources.map(res => {
          // Parse config/variables/outputs/lifecycle_config if they came back as strings from DB
          const parseIfString = (val, fallback = {}) => {
            if (typeof val === 'string') {
              try { return JSON.parse(val); } catch { return fallback; }
            }
            return val || fallback;
          };
          return {
            _id: Math.random().toString(36).slice(2),
            service_type: res.service_type,
            label: services.find(s => s.service_type === res.service_type)?.label || res.resource_name || res.service_type,
            schema_def: services.find(s => s.service_type === res.service_type)?.schema_def || [],
            template_body: services.find(s => s.service_type === res.service_type)?.template_body || '',
            module_body: services.find(s => s.service_type === res.service_type)?.module_body || null,
            category: services.find(s => s.service_type === res.service_type)?.category || '',
            config: parseIfString(res.config, {}), is_module: res.is_module || false,
            hcl_output: sanitizeHcl(res.hcl_output || ''),
            variables: parseIfString(res.variables, {}),
            outputs: parseIfString(res.outputs, {}),
            lifecycle_config: parseIfString(res.lifecycle_config, {}),
            position_x: res.position_x ?? 0,
            position_y: res.position_y ?? 0,
            annotations: res.annotations || '',
            module_source: res.module_source || '',
          };
        });
        setResources(mapped);
      } else if (r.data.last_hcl) {
        // No resources in DB but a saved full_hcl exists (e.g. from a prior
        // partial save or direct HCL paste). Restore it so the editor is not blank.
        setFullHCL(sanitizeHcl(r.data.last_hcl));
      }
    }).catch(() => showRef.current('Project not found', 'error'));
  }, [projectId, services]);

  // -- Rebuild HCL --------------------------------------------------------------
  const rebuildHCL = useCallback((res, vars, outs) => {
    const region      = project?.aws_region || 'us-east-1';
    const environment = project?.environment   || 'dev';
    const raw = buildFullHCL(res, region, environment, project?.backend_config || {}, vars || {}, outs || {}, project?.name || '');
    setFullHCL(sanitizeHcl(raw));
  }, [project]);

  useEffect(() => { rebuildHCL(resources, variables, outputs); }, [resources, variables, outputs, rebuildHCL]);

  // Flash the right panel whenever active resource changes
  useEffect(() => {
    if (resources.length === 0) return;
    setCodeFlash(true);
    const t = setTimeout(() => setCodeFlash(false), 500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  // -- Center panel drag-resize -------------------------------------------------
  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add('resizing-col');
    const onMove = e => {
      const dx = e.clientX - resizeStartX.current;
      const next = Math.max(260, Math.min(560, resizeStartW.current + dx));
      setCenterWidth(next);
    };
    const onUp = () => { setIsResizing(false); userResizedRef.current = true; document.body.classList.remove('resizing-col'); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-col');
    };
  }, [isResizing]);

  useEffect(() => {
    const f = buildSplitHCL(resources, project?.aws_region || 'us-east-1', project?.environment || 'dev', project?.backend_config || {}, variables, outputs, project?.name || '');
    setSplitFiles(f);
  }, [resources, project, variables, outputs]);

  // -- Handlers -----------------------------------------------------------------
  const handleApplyPreset = presetResources => {
    const env = project?.environment || 'dev';
    const currentRegion = project?.aws_region || DEFAULT_AWS_REGION;
    const newResources = presetResources.map(pr => {
      const svc = services.find(s => s.service_type === pr.service_type);
      const defaults = {};
      (svc?.schema_def || []).forEach(f => { defaults[f.id] = f.default || ''; });
      const config = { ...defaults, ...(pr.config || {}) };
      // Presets are authored against an example region (ap-south-1). Rewrite
      // the AZ suffix onto whichever region this project actually targets so
      // applying a preset outside that region doesn't silently emit an
      // availability_zone that doesn't exist (e.g. 'ap-south-1a' in a
      // us-east-1 project → invalid plan/apply).
      if (config.availability_zone) {
        const azSuffix = /([a-z])$/i.exec(config.availability_zone)?.[1];
        if (azSuffix) config.availability_zone = `${currentRegion}${azSuffix.toLowerCase()}`;
      }
      return {
        _id: Math.random().toString(36).slice(2),
        service_type: pr.service_type,
        label: pr.label || svc?.label || pr.service_type,
        schema_def: svc?.schema_def || [], template_body: svc?.template_body || '',
        module_body: svc?.module_body || null, category: svc?.category || '',
        config, is_module: false, hcl_output: svc ? generateHCL(svc.template_body || '', config, env) : '',
        wiredFrom: {}, icon: svc?.icon,
      };
    });
    const all = applyWiringToAll([...resources, ...newResources], env);
    setResources(all);
    setActiveIdx(all.length - 1);
    show(`✓ Applied preset: ${newResources.length} resources added`, 'success');
  };

  const handleAddService = svc => {
    const defaults = {};
    (svc.schema_def || []).forEach(f => { defaults[f.id] = f.default || ''; });
    const env = project?.environment || 'dev';
    const newRes = {
      _id: Math.random().toString(36).slice(2),
      service_type: svc.service_type, label: svc.label,
      schema_def: svc.schema_def, template_body: svc.template_body,
      module_body: svc.module_body, category: svc.category,
      config: defaults, is_module: false,
      hcl_output: generateHCL(svc.template_body || '', defaults, env),
      wiredFrom: {}, icon: svc.icon,
    };
    const tentative = [...resources, newRes];
    const withWiring = applyWiringToAll(tentative, env);
    setResources(withWiring);
    setActiveIdx(withWiring.length - 1);
    setValidResult(null);
  };

  const handleConfigChange = (config, hcl) => {
    const updated = resources.map((r, i) => {
      if (i !== activeIdx) return r;
      const wired = { ...(r.wiredFrom || {}) };
      for (const k of Object.keys(config)) {
        if (r.config && String(r.config[k] || '') !== String(config[k] || '')) {
          if (wired[k]) delete wired[k];
        }
      }
      return { ...r, config, hcl_output: hcl, wiredFrom: wired };
    });
    setResources(updated);
    setValidResult(null);
    // Visual sync: briefly flash the right panel to confirm code updated
    setCodeFlash(true);
    setTimeout(() => setCodeFlash(false), 500);
  };

  // BUG FIX: Module Registry "Import to Builder" previously appended the
  // generated HCL directly onto `fullHCL` as a raw string. `fullHCL` is a
  // *derived* value — the rebuildHCL effect above regenerates it from
  // `resources`/`variables`/`outputs` on every change — so the very next
  // time any resource, variable, or output changed, the manually-appended
  // module text was silently overwritten and the import appeared to have
  // "done nothing." Fix: turn the import into a real resource entry (like
  // every other block in the builder) so it flows through the normal
  // rebuild/save/undo/graph pipeline and survives future edits.
  const handleImportModule = ({ hcl, name, source, version }) => {
    if (!hcl) { show('Nothing to import', 'warning'); return; }
    let cleanHcl = sanitizeHcl(hcl);
    const base = (name || 'imported_module').replace(/[^a-z0-9_]/gi, '_').replace(/^(\d)/, '_$1') || 'imported_module';
    const existingNames = new Set(resources.map(r => (r.resource_name || r.label || '').toLowerCase()));
    let uniqueName = base;
    let n = 1;
    while (existingNames.has(uniqueName.toLowerCase())) { uniqueName = `${base}_${++n}`; }
    // If we had to rename to avoid a collision, keep the terraform block
    // identifier inside the generated HCL in sync with the new resource
    // label/name — otherwise the sidebar would show "vpc_2" while the code
    // still declares `module "vpc" { ... }`.
    if (uniqueName !== base) {
      cleanHcl = cleanHcl.replace(new RegExp(`module\\s+"${base}"\\s*{`), `module "${uniqueName}" {`);
    }

    const newResource = {
      _id: Math.random().toString(36).slice(2),
      service_type: `module:${source || uniqueName}`,
      label: uniqueName,
      resource_name: uniqueName,
      category: 'Registry Module',
      config: {},
      is_module: true,
      hcl_output: cleanHcl,
      module_source: source || '',
      version: version || '',
      wiredFrom: {},
      icon: '📦',
      position_x: 0,
      position_y: 0,
      annotations: '',
    };

    setResources([...resources, newResource]);
    setActiveIdx(resources.length); // select the newly added module
    setShowModuleRegistry(false);
    setViewMode('code');
    setCodeFlash(true);
    setTimeout(() => setCodeFlash(false), 700);
    show(`Module "${uniqueName}" imported — added to resources & visible in Code view`, 'success');
  };

  const handleToggleModule = () => {
    const r = resources[activeIdx];
    if (!r) return;
    const isModule = !r.is_module;
    const tpl = isModule ? r.module_body : r.template_body;
    const hcl = tpl ? generateHCL(tpl, r.config, project?.environment || 'dev') : r.hcl_output;
    setResources(resources.map((res, i) => i === activeIdx ? { ...res, is_module: isModule, hcl_output: hcl } : res));
  };

  const handleRemove = idx => {
    const newResources = resources.filter((_, i) => i !== idx);
    setResources(newResources);
    // Clamp to the new array bounds:
    //   - If the array is now empty, use 0 (activeResource falls back to null via resources[activeIdx] || null)
    //   - If we removed the last element, step back one position
    //   - Otherwise keep idx (which now points to what was idx+1, the natural next item)
    setActiveIdx(newResources.length === 0 ? 0 : Math.min(idx, newResources.length - 1));
    setValidResult(null);
  };

  const handleValidate = async () => {
    if (!fullHCL) return show('No HCL to validate', 'warning');
    const clean = sanitizeHcl(fullHCL);
    setValidLoading(true); setValidType('validate'); setValidResult(null);
    setShowPanel(true); setPanelTab('output');
    setCheckovResult(null); setCostEstimate(null);
    try {
      const res = await terraformAPI.validate(clean);
      setValidResult(res.data);
      if (res.data.checkov) setCheckovResult(res.data.checkov);
      if (res.data.offline) show('Terraform CLI not on server', 'warning');
      else show(res.data.valid ? '✓ Valid' : '✗ Validation failed', res.data.valid ? 'success' : 'error');
    } catch (e) {
      const msg = `Validate failed: ${e.response?.data?.error || e.message}`;
      show(msg, 'error');
      setValidResult({ valid: false, diagnostics: [], message: msg });
    } finally { setValidLoading(false); }
  };

  const handleFmt = async () => {
    if (!fullHCL) return show('No HCL to format', 'warning');
    setValidLoading(true); setValidType('fmt'); setValidResult(null);
    setShowPanel(true); setPanelTab('output');
    try {
      const res = await terraformAPI.fmt(sanitizeHcl(fullHCL));
      setValidResult(res.data);
      if (res.data.success) { setFullHCL(sanitizeHcl(res.data.formatted)); show('✓ Formatted', 'success'); }
      else show(res.data.offline ? 'Terraform CLI not available' : 'Format failed', 'warning');
    } catch (e) {
      const msg = `Format failed: ${e.response?.data?.error || e.message}`;
      show(msg, 'error'); setValidResult({ success: false, message: msg });
    } finally { setValidLoading(false); }
  };

  const handlePlan = async () => {
    if (!fullHCL) return show('No HCL to plan', 'warning');
    setValidLoading(true); setValidType('plan'); setValidResult(null);
    setShowPanel(true); setPanelTab('output'); setPlanDiff(null); setLogLines([]);
    setPolicyResults(null);
    try {
      const res = await terraformAPI.plan(sanitizeHcl(fullHCL), 'auto', projectId);
      const data = res.data;
      setValidResult(data);

      // Handle both inline result (no Redis) and async 202 response
      if (data.jobId && !data.summary && !data.resource_changes) {
        // Async path — subscribe to WS for live logs + final diff
        const ws = jobsAPI.connectWs(data.jobId);
        wsRef.current = ws;
        ws.onmessage = ev => {
          if (!mountedRef.current) return;
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'log') setLogLines(prev => [...prev.slice(-500), msg.line ?? JSON.stringify(msg)]);
            if (msg.type === 'done') {
              const r = msg.result || {};
              setValidResult(r);
              if (r.summary || r.resource_changes) setPlanDiff({ summary: r.summary, resource_changes: r.resource_changes || [] });
              if (r.checkov) setCheckovResult(r.checkov);
              show(r.success ? '✓ Plan generated' : '✗ Plan failed', r.success ? 'success' : 'error');
              setValidLoading(false);
            }
          } catch { setLogLines(prev => [...prev.slice(-500), ev.data]); }
        };
        ws.onclose = () => { wsRef.current = null; };
        show('⚙ Plan queued…', 'info');
        return; // loading stays true until WS done event
      }

      // Inline path — result is fully available now
      if (data.summary || data.resource_changes) setPlanDiff({ summary: data.summary, resource_changes: data.resource_changes || [] });
      if (data.checkov) setCheckovResult(data.checkov);
      if (data.jobId) {
        const ws = jobsAPI.connectWs(data.jobId);
        wsRef.current = ws;
        ws.onmessage = ev => {
          if (!mountedRef.current) return;
          try { const msg = JSON.parse(ev.data); if (msg.log) setLogLines(prev => [...prev.slice(-500), msg.log]); }
          catch { setLogLines(prev => [...prev.slice(-500), ev.data]); }
        };
        ws.onclose = () => { wsRef.current = null; };
      }
      show(data.success ? '✓ Plan generated' : '✗ Plan failed', data.success ? 'success' : 'error');
    } catch (e) {
      const msg = `Plan failed: ${e.response?.data?.error || e.message}`;
      show(msg, 'error');
      setValidResult({ success: false, message: msg, summary: {}, resource_changes: [] });
    } finally { setValidLoading(false); }
  };

  const handleSave = async () => {
    if (!projectId) return show('Open a project from Dashboard first', 'warning');
    if (detectSecretsInHcl(fullHCL)) { show('⚠ Possible secret/credential in HCL — remove before saving!', 'error'); return; }
    setSaving(true);
    try {
      // Ensure all resource JSON fields are plain objects before sending to the
      // backend. The backend will also defensively parse them, but sending clean
      // data avoids the "invalid input syntax for type json" Postgres error that
      // occurs when a non-JSON string reaches a JSONB column.
      const ensureObject = (val, fallback = {}) => {
        if (val === null || val === undefined) return fallback;
        if (typeof val === 'object') return val;
        if (typeof val === 'string') {
          try { return JSON.parse(val); } catch { return fallback; }
        }
        return fallback;
      };
      const res = resources.map((r) => ({
        service_type:     r.service_type,
        resource_name:    (typeof r.config === 'object' && r.config?.name) || r.label || r.service_type,
        config:           ensureObject(r.config, {}),
        is_module:        r.is_module || false,
        module_source:    r.module_source || '',
        hcl_output:       sanitizeHcl(r.hcl_output || ''),
        variables:        ensureObject(r.variables, {}),
        outputs:          ensureObject(r.outputs, {}),
        lifecycle_config: ensureObject(r.lifecycle_config, {}),
        position:         { x: r.position_x ?? r.position?.x ?? 0, y: r.position_y ?? r.position?.y ?? 0 },
        annotations:      r.annotations || '',
      }));
      await projectsAPI.saveResources(projectId, res, sanitizeHcl(fullHCL)); // BUG-005 fix: pass fullHCL so last_hcl includes provider/backend/variables blocks
      await projectsAPI.saveVersion(projectId, { full_hcl: sanitizeHcl(fullHCL), resource_count: resources.length });
      setLastSaved(new Date());
      show('✓ Project saved', 'success');
    } catch (e) {
      console.error('[handleSave]', e.response?.data || e.message);
      show(`Save failed: ${e.response?.data?.error || e.message}`, 'error');
    }
    finally { setSaving(false); }
  };

  const handleDownload = () => {
    if (!fullHCL) return show('No HCL to download', 'warning');
    const blob = new Blob([sanitizeHcl(fullHCL)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${project?.name || 'terraform'}.tf`;
    a.click(); URL.revokeObjectURL(a.href);
    show('✓ Downloaded main.tf', 'success');
  };

  const handleDownloadZip = async () => {
    if (!fullHCL) return show('No HCL to download', 'warning');
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const files = buildSplitHCL(resources, project?.aws_region || 'us-east-1', project?.environment || 'dev', project?.backend_config || {}, variables, outputs, project?.name || '');
      Object.entries(files).forEach(([name, content]) => zip.file(name, sanitizeHcl(content)));
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${project?.name || 'terraform'}-split.zip`;
      a.click(); URL.revokeObjectURL(a.href);
      show('✓ Downloaded split .tf files', 'success');
    } catch { show('Zip export failed', 'error'); }
  };

  const handleCopyHCL = () => {
    if (!fullHCL) return;
    const text = sanitizeHcl(fullHCL);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => show('HCL copied to clipboard', 'success')).catch(() => {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      show('HCL copied to clipboard', 'success');
    } catch {
      show('Copy failed - please copy manually', 'error');
    }
    document.body.removeChild(textarea);
  };

  const activeResource = resources[activeIdx] || null;
  const hclBytes = new Blob([sanitizeHcl(fullHCL || '')]).size;

  // Services that have multi-item editors and benefit from a wider config panel
  const EXPANDED_CONFIG_TYPES = new Set(['security_group', 'vpc', 'ec2', 'subnet']);
  const needsExpandedConfig = activeResource && EXPANDED_CONFIG_TYPES.has(activeResource.service_type);
  // FE-08 fix: auto-size the center panel only when the user has not manually
  // dragged it. Once userResizedRef is true we leave centerWidth alone entirely,
  // so neither the expand nor the collapse branch can override a manual resize.
  // The dependency array is correct as-is — centerWidth is intentionally excluded
  // because we read it only through userResizedRef (no suppression comment needed).
  useEffect(() => {
    if (userResizedRef.current) return;
    if (needsExpandedConfig) setCenterWidth(420);
    else setCenterWidth(320);
  }, [needsExpandedConfig]);
  const statusOk = validResult?.valid === true || validResult?.success === true;
  const statusErr = validResult?.valid === false || validResult?.success === false;

  const securityCount = checkovResult?.failed || 0;
  // All potential tabs keyed by id
  const ALL_TABS = {
    output:   { id: 'output',   label: validType === 'plan' ? '⚑ Plan' : validType === 'fmt' ? '⌥ Format' : '* Validate' },
    diff:     { id: 'diff',     label: `△ Diff (${planDiff?.resource_changes?.length || 0})`,   visible: !!planDiff },
    security: { id: 'security', label: `🛡 Security (${securityCount})`,                         visible: securityCount > 0 },
    cost:     { id: 'cost',     label: '$ Cost',                                                  visible: !!costEstimate },
    logs:     { id: 'logs',     label: '≡ Logs',                                                  visible: logLines.length > 0 },
    policy:   {
      id: 'policy',
      label: policyResults
        ? (policyResults.filter(r => !r.passed).length > 0
            ? `🚫 Policy (${policyResults.filter(r => !r.passed).length} fail)`
            : '✅ Policy')
        : '🛡 Policy',
      visible: !!policyResults,
    },
    changes:  { id: 'changes',  label: '📋 Changes',                                             visible: !!projectId },
    apply:    { id: 'apply',    label: applyResult?.success ? '✅ Applied' : applyResult ? '❌ Apply' : '▶ Apply' },
  };

  // Order tabs per user preference, filter to visible only
  const panelTabs = tabOrder
    .filter(id => ALL_TABS[id] && (ALL_TABS[id].visible !== false))
    .map(id => ALL_TABS[id]);

  // Drag-to-reorder handlers
  const onTabDragStart = (id) => setDragTabId(id);
  const onTabDragOver  = (e, id) => { e.preventDefault(); setDragOverId(id); };
  const onTabDrop      = (e, targetId) => {
    e.preventDefault();
    if (!dragTabId || dragTabId === targetId) { setDragTabId(null); setDragOverId(null); return; }
    const newOrder = [...tabOrder];
    const fromIdx  = newOrder.indexOf(dragTabId);
    const toIdx    = newOrder.indexOf(targetId);
    if (fromIdx !== -1 && toIdx !== -1) {
      newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, dragTabId);
      setTabOrder(newOrder);
      try { localStorage.setItem('tfgen_panel_tab_order', JSON.stringify(newOrder)); } catch {}
    }
    setDragTabId(null);
    setDragOverId(null);
  };

  return (
    <div style={{ height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#F7F9FC' }}>
      <ToastContainer toasts={toasts} />

      {/* -- Top Project Bar --------------------------------------------------- */}
      <div style={{
        padding: '0 16px', background: 'linear-gradient(135deg, #FFFFFF 0%, #F8FFFE 100%)', borderBottom: '1px solid #E2E8F0',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, height: 52, flexWrap: 'nowrap', overflow: 'visible', position: 'relative', zIndex: 50,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        {/* Back */}
        <button onClick={() => nav('/dashboard')}
          style={{ background: '#F1F5F9', border: '1px solid #E2E8F0', color: '#64748B', cursor: 'pointer', fontSize: 16, padding: '6px 10px', borderRadius: 8, transition: 'all 0.15s', lineHeight: 1, flexShrink: 0, fontWeight: 600 }}
          onMouseEnter={e => { e.currentTarget.style.background = '#E2E8F0'; e.currentTarget.style.color = '#1E293B'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#F1F5F9'; e.currentTarget.style.color = '#64748B'; }}
          title="Back to Dashboard">←</button>

        {/* Project info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 1 auto', minWidth: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)', border: '1.5px solid #A7F3D0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 6px rgba(5,150,105,0.1)' }}>
            <span style={{ fontSize: 15, color: '#059669', fontWeight: 800 }}>T</span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '-0.01em' }}>
              {project?.name || 'New Project'}
            </div>
            <div style={{ fontSize: 10.5, color: '#64748B', whiteSpace: 'nowrap', fontWeight: 500 }}>
              {project?.aws_region ? getAwsRegionLabel(project.aws_region) : '—'} · {project?.environment || 'dev'}
            </div>
          </div>
        </div>

        {/* Resource count badge */}
        {resources.length > 0 && (
          <div style={{ padding: '3px 10px', background: 'linear-gradient(135deg, #ECFDF5, #D1FAE5)', border: '1px solid #A7F3D0', borderRadius: 6, fontSize: 11, fontWeight: 700, color: '#059669', flexShrink: 0, fontFamily: 'JetBrains Mono, monospace', boxShadow: '0 1px 2px rgba(5,150,105,0.06)' }}>
            {resources.length} resource{resources.length !== 1 ? 's' : ''}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Action group 0: DevOps tools (collapsed into dropdown) */}
        <ToolbarDropdown label="Tools" c={c}>
          <DropdownItem onClick={() => setShowArchPatterns(true)}>Architecture Patterns</DropdownItem>
          <DropdownItem onClick={() => setShowIamModal(true)} disabled={!resources.length}>IAM Policy Generator</DropdownItem>
          <DropdownItem onClick={() => setShowStateInspector(true)}>State Inspector</DropdownItem>
          <DropdownItem onClick={() => setShowModuleRegistry(true)}>Module Registry</DropdownItem>
          <DropdownItem divider />
          <DropdownItem onClick={() => setShowMultiEnv(true)}>Multi-Environment</DropdownItem>
          <DropdownItem onClick={() => setShowBackendGen(true)}>Remote Backend</DropdownItem>
          <DropdownItem onClick={() => setShowTerragrunt(true)}>Terragrunt</DropdownItem>
        </ToolbarDropdown>

        <div style={{ width: 1, height: 22, background: '#E5E7EB', flexShrink: 0 }} />

        {/* Action group 1: Presets + Advanced */}
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <IconBtn onClick={() => setShowPresets(p => !p)} c={c} variant={showPresets ? 'success' : 'default'} title="Preset architectures">
            Presets
          </IconBtn>
          <IconBtn onClick={() => { setAdvancedMode(v => { const n = !v; localStorage.setItem('tfgen.advancedMode', n ? 'true' : 'false'); return n; }); }} c={c} variant={advancedMode ? 'success' : 'ghost'} title="Toggle advanced split-file mode">
            {advancedMode ? 'Advanced' : 'Simple'}
          </IconBtn>
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 22, background: '#E5E7EB', flexShrink: 0 }} />

        {/* Action group 2: Terraform ops */}
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          <IconBtn onClick={handleValidate} disabled={!fullHCL || validLoading} c={c} title="terraform validate (Ctrl+Enter)">
            {validLoading && validType === 'validate' ? <span className="spinner" /> : null} Validate
          </IconBtn>
          <IconBtn onClick={handlePlan} disabled={!fullHCL || validLoading} c={c} title="terraform plan">
            {validLoading && validType === 'plan' ? <span className="spinner" /> : null} Plan
          </IconBtn>
          <IconBtn
            onClick={() => { setShowPanel(true); setPanelTab('apply'); }}
            disabled={!fullHCL || !projectId}
            c={c}
            title={!projectId ? 'Save as a project first to enable Apply' : !hasCredentials ? 'Connect AWS credentials to enable Apply' : 'Open Apply panel'}
            style={{ background: '#FEF2F2', borderColor: '#FECACA', color: '#DC2626', fontWeight: 700 }}
          >
            ▶ Apply
          </IconBtn>
          <IconBtn onClick={handleFmt} disabled={!fullHCL || validLoading} c={c} title="terraform fmt (Ctrl+Shift+F)">
            {validLoading && validType === 'fmt' ? <span className="spinner" /> : null} Format
          </IconBtn>
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 22, background: '#E5E7EB', flexShrink: 0 }} />

        {/* Action group 3: Export (collapsed into dropdown) */}
        <ToolbarDropdown label="↓ Export" c={c} disabled={!fullHCL}>
          <DropdownItem onClick={handleCopyHCL} disabled={!fullHCL}>⎘ Copy to clipboard</DropdownItem>
          <DropdownItem onClick={handleDownload} disabled={!fullHCL}>↓ Download .tf</DropdownItem>
          <DropdownItem onClick={handleDownloadZip} disabled={!fullHCL}>📦 Download .zip</DropdownItem>
          {projectId && <DropdownItem onClick={() => nav(`/history/${projectId}`)}>📋 Version History</DropdownItem>}
          {projectId && <DropdownItem onClick={() => nav(`/team/${projectId}`)}>👥 Team</DropdownItem>}
        </ToolbarDropdown>

        {/* Separator */}
        <div style={{ width: 1, height: 22, background: '#E5E7EB', flexShrink: 0 }} />

        {/* Save */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {projectId && (
            <IconBtn onClick={handleSave} disabled={saving} c={c} variant="accent" title="Save project (Ctrl+S)">
              {saving ? <span className="spinner" /> : null} {saving ? 'Saving...' : 'Save'}
            </IconBtn>
          )}
        </div>
      </div>

      {/* -- Resource Tabs ----------------------------------------------------- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 16px', borderBottom: '1px solid #E2E8F0',
        background: '#FAFBFC', flexShrink: 0, overflowX: 'auto', minHeight: 40,
      }}>
        {resources.length === 0 ? (
          <span style={{ fontSize: 12, color: '#94A3B8', fontStyle: 'italic', fontWeight: 500 }}>No resources yet -- add a service from the left panel</span>
        ) : (
          resources.map((r, i) => (
            <ResTab key={r._id} resource={r} active={i === activeIdx} onSelect={() => setActiveIdx(i)} onRemove={() => handleRemove(i)} c={c} isChild={!!getParentType(r, resources)} />
          ))
        )}
      </div>

      {/* -- Main 3-column Layout ---------------------------------------------- */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>

        {/* Collapse toggle for left sidebar */}
        <button
          onClick={() => setLeftCollapsed(v => !v)}
          title={leftCollapsed ? 'Show services' : 'Hide services'}
          style={{
            position: 'absolute', left: leftCollapsed ? 0 : 360, top: '50%', transform: 'translateY(-50%)',
            zIndex: 10, width: 16, height: 36, background: '#FFFFFF', border: '1px solid #E2E8F0',
            borderRadius: leftCollapsed ? '0 6px 6px 0' : '6px 0 0 6px',
            cursor: 'pointer', color: '#64748B', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s ease', boxShadow: '0 2px 4px rgba(0,0,0,0.06)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#F1F5F9'; e.currentTarget.style.color = '#1E293B'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#FFFFFF'; e.currentTarget.style.color = '#64748B'; }}>
          {leftCollapsed ? '›' : '‹'}
        </button>

        {/* -- LEFT: Service selector or Presets ------------------------------- */}
        {!leftCollapsed && (
          <div style={{ width: 360, minWidth: 360, flexShrink: 0, borderRight: '1px solid #E2E8F0', overflow: 'hidden', display: 'flex', flexDirection: 'column', transition: 'width 0.2s ease', background: '#FFFFFF' }}>
            {showPresets ? (
              <PresetsPanel onApply={handleApplyPreset} onClose={() => setShowPresets(false)} />
            ) : (
              <ServiceSelector services={services} addedServices={resources} onAdd={handleAddService} />
            )}
          </div>
        )}

        {/* -- CENTER: Config panel -------------------------------------------- */}
        <div style={{ width: centerWidth, minWidth: 260, maxWidth: 560, flexShrink: 0, borderRight: 'none', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', transition: isResizing ? 'none' : 'width 0.2s ease', background: '#FFFFFF', position: 'relative' }}>
          <ConfigPanel
            service={activeResource}
            config={activeResource?.config || {}}
            isModule={activeResource?.is_module || false}
            onChange={handleConfigChange}
            region={project?.aws_region || 'us-east-1'}
            onToggleModule={handleToggleModule}
            allResources={resources}
          />
          {/* Drag resize handle */}
          <div
            onMouseDown={e => { e.preventDefault(); resizeStartX.current = e.clientX; resizeStartW.current = centerWidth; setIsResizing(true); }}
            title="Drag to resize"
            style={{
              position: 'absolute', top: 0, right: 0, width: 5, height: '100%',
              cursor: 'col-resize', zIndex: 5,
              background: isResizing ? 'rgba(5,150,105,0.3)' : 'transparent',
              borderRight: `1px solid ${isResizing ? '#059669' : '#E2E8F0'}`,
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(5,150,105,0.12)'; e.currentTarget.style.borderRightColor = '#059669'; }}
            onMouseLeave={e => { if (!isResizing) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderRightColor = '#E2E8F0'; } }}
          />
        </div>

        {/* -- RIGHT: Code / Graph / Vars ------------------------------------- */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0,
          outline: codeFlash ? '2px solid rgba(5,150,105,0.45)' : '2px solid transparent',
          outlineOffset: -2,
          transition: 'outline-color 0.35s ease',
          cursor: isResizing ? 'col-resize' : 'default',
          userSelect: isResizing ? 'none' : 'auto',
        }}>

          {/* View mode tabs */}
          <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #E2E8F0', background: '#F8FAFC', flexShrink: 0 }}>
            <ViewTab id="code"  label="Code"             active={viewMode === 'code'}  onClick={() => setViewMode('code')}  c={c} />
            <ViewTab id="graph" label="Graph"            active={viewMode === 'graph'} onClick={() => setViewMode('graph')} c={c} />
            <ViewTab id="vars"  label="Vars & Outputs"   active={viewMode === 'vars'}  onClick={() => setViewMode('vars')}  c={c} />
            <ViewTab id="learn" label={`Learn${activeResource ? ' - ' + (activeResource.label || '').split(' ')[0] : ''}`} active={viewMode === 'learn'} onClick={() => setViewMode('learn')} c={c} badge="✨ AI" />
            <ViewTab id="labs"  label="Labs & Interview" active={viewMode === 'labs'}  onClick={() => setViewMode('labs')}  c={c} />
            <div style={{ flex: 1 }} />
            {/* Sync pulse indicator — appears when config changes update code */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', marginRight: 4, borderRadius: 4,
              background: codeFlash ? 'rgba(5,150,105,0.1)' : 'transparent',
              transition: 'background 0.35s ease',
              opacity: codeFlash ? 1 : 0,
              fontSize: 10, fontWeight: 700, color: '#059669', letterSpacing: '0.04em',
              pointerEvents: 'none',
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: '#059669',
                animation: codeFlash ? 'pulse-dot 0.6s ease-in-out' : 'none',
              }} />
              SYNCED
            </div>
            {/* HCL size indicator */}
            {fullHCL && (
              <div style={{ padding: '4px 12px', fontSize: 11, color: '#64748B', fontFamily: 'JetBrains Mono, monospace', fontWeight: 500, background: '#F1F5F9', borderRadius: 4, margin: '0 8px' }}>
                {hclBytes} B
              </div>
            )}
            {/* Validation badge */}
            {validResult && (
              <div style={{ marginRight: 12 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 700,
                  background: statusOk ? '#ECFDF5' : statusErr ? '#FEF2F2' : '#FFFBEB',
                  color: statusOk ? '#059669' : statusErr ? '#DC2626' : '#D97706',
                  border: `1px solid ${statusOk ? '#A7F3D0' : statusErr ? '#FECACA' : '#FDE68A'}`,
                }}>
                  {statusOk ? 'Valid' : statusErr ? 'Error' : 'Pending'}
                </span>
              </div>
            )}
          </div>

          {/* -- Code view ---------------------------------------------------- */}
          {viewMode === 'code' && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

              {/* Code editor area */}
              <div style={{ flex: 1, overflow: 'auto' }}>
                {advancedMode ? (
                  <AdvancedFilesEditor files={splitFiles} onFileChange={(name, content) => {
                    const updated = { ...splitFiles, [name]: content };
                    setSplitFiles(updated);
                    const order = ['backend.tf', 'providers.tf', 'versions.tf', 'locals.tf', 'variables.tf', 'main.tf', 'outputs.tf'];
                    const combined = order.map(k => updated[k]).filter(Boolean).join('\n\n');
                    setFullHCL(sanitizeHcl(combined));
                  }} />
                ) : (
                  <CodePreview hcl={fullHCL} onHclChange={setFullHCL} />
                )}
              </div>

              {/* Lint panel */}
              <div style={{ borderTop: '1px solid #E5E7EB', flexShrink: 0 }}>
                <LintPanel hcl={fullHCL} onApplyFix={fixed => setFullHCL(sanitizeHcl(fixed))} />
              </div>

              {/* Validation output panel */}
              {showPanel && (
                <div style={{ borderTop: '1px solid #E5E7EB', background: '#FFFFFF', flexShrink: 0, maxHeight: 300, display: 'flex', flexDirection: 'column' }}>
                  {/* Panel header + tabs */}
                  <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', borderBottom: '1px solid #E5E7EB', background: '#F9FAFB', flexShrink: 0 }}>
                    <div style={{ display: 'flex', flex: 1 }}>
                      {panelTabs.map(t => (
                        <button key={t.id} onClick={() => setPanelTab(t.id)}
                          style={{
                            padding: '6px 12px', fontSize: 11, fontWeight: 600, border: 'none',
                            cursor: 'pointer', fontFamily: 'inherit',
                            background: 'transparent', color: panelTab === t.id ? '#059669' : '#9CA3AF',
                            borderBottom: panelTab === t.id ? '2px solid #059669' : '2px solid transparent',
                            transition: 'all 0.1s',
                          }}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
                      {costEstimate && <CostBadge total={costEstimate.total_monthly_usd} items={costEstimate.items} engine={costEstimate.engine} />}
                      <button onClick={() => setShowPanel(false)}
                        style={{ background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 4px' }}>×</button>
                    </div>
                  </div>

                  {/* Panel content */}
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                    {panelTab === 'output' && (
                      <div style={{ padding: 12 }}>
                        <ValidationPanel result={validResult} type={validType} loading={validLoading} />
                      </div>
                    )}
                    {panelTab === 'diff' && planDiff && (
                      <div style={{ padding: 12 }}>
                        <PlanDiffPanel planDiff={planDiff} />
                      </div>
                    )}
                    {panelTab === 'security' && checkovResult && (
                      <div style={{ padding: 12 }}>
                        <SecurityFindings findings={checkovResult.findings || []} passed={checkovResult.passed || 0} failed={checkovResult.failed || 0} engine={checkovResult.engine} />
                      </div>
                    )}
                    {panelTab === 'cost' && costEstimate && (
                      <div style={{ padding: 12 }}>
                        <CostBadge total={costEstimate.total_monthly_usd} items={costEstimate.items} engine={costEstimate.engine} expanded />
                      </div>
                    )}
                    {panelTab === 'logs' && logLines.length > 0 && (
                      <pre className="terminal-log" style={{ margin: 0, padding: '10px 14px', fontSize: 11.5, lineHeight: 1.6, background: '#F8FAFC', color: '#374151', fontFamily: 'JetBrains Mono, monospace', maxHeight: 240, overflowY: 'auto', border: '1px solid #E5E7EB', borderRadius: 6 }}>
                        {logLines.join('\n')}
                      </pre>
                    )}
                    {panelTab === 'policy' && (
                      <div style={{ padding: '12px 14px' }}>
                        <PolicyResultsPanel results={policyResults} />
                      </div>
                    )}

                    {panelTab === 'changes' && projectId && (
                      <div style={{ height: '100%', overflow: 'hidden' }}>
                        <ChangeRequestPanel
                          projectId={projectId}
                          versions={versions}
                          currentUser={null}
                        />
                      </div>
                    )}

                    {panelTab === 'apply' && (
                      <div style={{ padding: 12 }}>
                        <ApplyStatusPanel
                          hcl={fullHCL}
                          projectId={projectId}
                          runner={project?.runner_mode || 'auto'}
                          hasCredentials={hasCredentials}
                          onComplete={(result) => {
                            setApplyResult(result);
                            if (result?.success) show('✅ Apply succeeded', 'success');
                            else show('❌ Apply failed', 'error');
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- Graph view --------------------------------------------------- */}
          {viewMode === 'graph' && (
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <ResourceGraph
                key="resource-graph"
                resources={resources}
                environment={project?.environment || 'dev'}
                onSelect={setActiveIdx}
                onChange={updated => {
                  // Simply update resources — do NOT switch viewMode here.
                  // The previous setViewMode('code') + setTimeout trick caused
                  // the graph to unmount/remount on every drag end, losing node
                  // positions and breaking movement.
                  setResources(updated);
                }}
              />
            </div>
          )}

          {/* -- Vars & Outputs view ------------------------------------------ */}
          {viewMode === 'vars' && (
            <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
              <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 16, padding: '8px 12px', background: '#F9FAFB', borderRadius: 8, border: '1px solid #E5E7EB' }}>
                Variables and outputs are written to <code style={{ fontFamily: 'JetBrains Mono, monospace', color: '#059669' }}>variables.tf</code> and <code style={{ fontFamily: 'JetBrains Mono, monospace', color: '#059669' }}>outputs.tf</code> in all exports.
              </div>
              <VariablesEditor variables={variables} onChange={setVariables} />
              <hr style={{ border: 'none', borderTop: '1px solid #E5E7EB', margin: '20px 0' }} />
              <OutputsEditor outputs={outputs} onChange={setOutputs} />
            </div>
          )}

          {/* -- Learn view --------------------------------------------------- */}
          {viewMode === 'learn' && (
            // ensure flex children can shrink so inner auto-overflow scroll works
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
              <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
                <HclExplainer hcl={activeResource?.hcl_output || fullHCL} c={c} />
              </div>
            </div>
          )}

          {/* -- Labs view ---------------------------------------------------- */}
          {viewMode === 'labs' && (
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, borderRight: '1px solid #E5E7EB' }}>
                <ScenarioLabs c={c} onApplyPattern={(patternId) => {
                  setShowArchPatterns(false);
                  setViewMode('code');
                  show('Lab pattern loaded — add the services from the sidebar', 'info');
                }} />
              </div>
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <InterviewPanel resources={resources} c={c} />
              </div>
            </div>
          )}

        </div>
      </div>

      {/* -- Modals ----------------------------------------------------------- */}
      {showArchPatterns && (
        <ArchPatternPicker
          c={c}
          onClose={() => setShowArchPatterns(false)}
          onApply={(pattern) => {
            const env = project?.environment || 'dev';
            // Build fully-hydrated resources by looking up schema/template from
            // the loaded services array — same approach as handleApplyPreset so
            // ConfigPanel always receives a complete resource object (FE-03).
            const patternResources = (pattern.services || []).map((svcType, i) => {
              const svc = services.find(s => s.service_type === svcType);
              const defaults = {};
              (svc?.schema_def || []).forEach(f => { defaults[f.id] = f.default || ''; });
              return {
                _id: `${svcType}-${Date.now()}-${i}`,
                service_type: svcType,
                label: svc?.label || svcType.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()),
                schema_def:    svc?.schema_def    || [],
                template_body: svc?.template_body || '',
                module_body:   svc?.module_body   || null,
                category:      svc?.category      || '',
                config: defaults,
                is_module: false,
                hcl_output: svc ? generateHCL(svc.template_body || '', defaults, env) : '',
                wiredFrom: {},
                icon: svc?.icon,
              };
            });
            setResources(prev => {
              const existingTypes = new Set(prev.map(r => r.service_type));
              const newOnes = patternResources.filter(r => !existingTypes.has(r.service_type));
              return applyWiringToAll([...prev, ...newOnes], env);
            });
            setShowArchPatterns(false);
            show(`Loaded pattern: ${pattern.name}`, 'success');
          }}
        />
      )}
      {showIamModal && (
        <IamPolicyModal c={c} resources={resources} onClose={() => setShowIamModal(false)} />
      )}
      {showStateInspector && (
        <StateInspector c={c} resources={resources} onClose={() => setShowStateInspector(false)} />
      )}
      {showModuleRegistry && (
        <ModuleRegistry c={c}
          onImport={handleImportModule}
          onClose={() => setShowModuleRegistry(false)} />
      )}
      {showMultiEnv && (
        <MultiEnvPanel c={c} project={project}
          variables={variables}
          onClose={() => setShowMultiEnv(false)} />
      )}
      {showBackendGen && (
        <BackendGenerator c={c} project={project} onClose={() => setShowBackendGen(false)} />
      )}
      {showTerragrunt && (
        <TerragruntPanel c={c} project={project} resources={resources} onClose={() => setShowTerragrunt(false)} />
      )}

      {/* -- Status Bar ------------------------------------------------------- */}
      <div style={{
        height: 28, background: '#1E293B', borderTop: '1px solid #334155',
        display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px',
        fontSize: 11, color: '#94A3B8', flexShrink: 0, letterSpacing: '0.01em', fontWeight: 500,
      }}>
        {/* Left: status indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: validLoading ? '#F59E0B' : statusOk ? '#10B981' : statusErr ? '#EF4444' : '#64748B',
            boxShadow: validLoading ? '0 0 6px rgba(245,158,11,0.6)' : statusOk ? '0 0 6px rgba(16,185,129,0.6)' : statusErr ? '0 0 6px rgba(239,68,68,0.6)' : 'none',
            animation: validLoading ? 'pulse-dot 1s ease-in-out infinite' : 'none',
          }} />
          <span style={{ color: validLoading ? '#FCD34D' : statusOk ? '#6EE7B7' : statusErr ? '#FCA5A5' : '#94A3B8' }}>
            {validLoading ? `Running terraform ${validType}...` : statusOk ? 'Valid' : statusErr ? 'Errors found' : 'Ready'}
          </span>
        </div>

        <span style={{ color: '#475569' }}>|</span>

        {/* Resources */}
        <span style={{ color: resources.length > 0 ? '#6EE7B7' : 'inherit' }}>
          {resources.length} resource{resources.length !== 1 ? 's' : ''}
        </span>

        {fullHCL && (
          <>
            <span style={{ color: '#475569' }}>|</span>
            <span>{hclBytes.toLocaleString()} bytes</span>
            <span style={{ color: '#475569' }}>|</span>
            <span>{(fullHCL.match(/\n/g) || []).length + 1} lines</span>
          </>
        )}

        <span style={{ color: '#475569' }}>|</span>
        <span>{project?.aws_region || 'us-east-1'}</span>

        <div style={{ flex: 1 }} />

        {/* Right: last saved */}
        {lastSaved && (
          <span style={{ color: '#6EE7B7' }}>Saved {lastSaved.toLocaleTimeString()}</span>
        )}
        {!projectId && (
          <span style={{ color: '#FCD34D' }}>No project -- save from Dashboard</span>
        )}

        <span style={{ color: '#475569' }}>|</span>
        <span style={{ color: advancedMode ? '#6EE7B7' : 'inherit' }}>{advancedMode ? 'Advanced' : 'Simple'} mode</span>
      </div>
    </div>
  );
}
