import React, { useState } from 'react';
import API from '../api/client';

const ENVS = ['dev','staging','prod','test'];
const MODULES_LIST = [
  { key:'vpc',    icon:'🌐', label:'VPC' },
  { key:'ec2',    icon:'🖥',  label:'EC2' },
  { key:'rds',    icon:'🗄',  label:'RDS' },
  { key:'alb',    icon:'⚖',  label:'ALB' },
  { key:'eks',    icon:'☸',  label:'EKS' },
  { key:'s3',     icon:'🪣',  label:'S3' },
  { key:'lambda', icon:'λ',   label:'Lambda' },
];

export default function TerragruntPanel({ c, project, resources = [], onClose }) {
  const [form, setForm] = useState({
    project_name:  project?.name || 'my-project',
    aws_region:    project?.aws_region || 'ap-south-1',
    aws_account_id:'ACCOUNT_ID',
    environments:  ['dev','staging','prod'],
    modules:       [...new Set(resources.map(r => r.service_type || r.serviceType).filter(k => MODULES_LIST.find(m => m.key === k)))].slice(0,5),
    tf_version:    '1.7.0',
  });
  const [files, setFiles]       = useState(null);
  const [activeFile, setActiveFile] = useState('');
  const [loading, setLoading]   = useState(false);
  const [copied, setCopied]     = useState('');
  const [tab, setTab]           = useState('config');

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const toggleEnv = env => set('environments', form.environments.includes(env) ? form.environments.filter(e => e !== env) : [...form.environments, env]);
  const toggleMod = mod => set('modules', form.modules.includes(mod) ? form.modules.filter(m => m !== mod) : [...form.modules, mod]);

  const generate = async () => {
    setLoading(true);
    try {
      const r = await API.post('/api/envconfig/terragrunt', form);
      setFiles(r.data.files || {});
      setActiveFile('terragrunt.hcl');
      setTab('files');
    } catch (e) { alert(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  const downloadAll = async () => {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      Object.entries(files || {}).forEach(([n, c]) => {
        const parts = n.split('/');
        if (parts.length > 1) { const folder = zip.folder(parts.slice(0, -1).join('/')); folder.file(parts[parts.length - 1], c); }
        else zip.file(n, c);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `${form.project_name}-terragrunt.zip`; a.click(); URL.revokeObjectURL(a.href);
    } catch { alert('Download failed'); }
  };

  const copy = async (name) => {
    await navigator.clipboard.writeText(files[name] || '');
    setCopied(name); setTimeout(() => setCopied(''), 2000);
  };

  const REGIONS = ['ap-south-1','us-east-1','us-west-2','eu-west-1','eu-central-1','ap-southeast-1','ap-northeast-1'];
  const ENV_COLORS = { dev:'#10B981', staging:'#F59E0B', prod:'#EF4444', test:'#3B82F6' };

  const S = {
    overlay: { position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center' },
    modal: { background:c.bg,border:`1px solid ${c.bd}`,borderRadius:16,width:1060,maxWidth:'97vw',maxHeight:'92vh',display:'flex',flexDirection:'column',boxShadow:'0 32px 80px rgba(0,0,0,0.7)' },
    hdr: { padding:'16px 20px',borderBottom:`1px solid ${c.bd}`,display:'flex',alignItems:'center',gap:12,background:c.bg2,borderRadius:'16px 16px 0 0',flexShrink:0 },
    inp: { width:'100%',background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'9px 12px',color:c.fg,fontSize:13,outline:'none',fontFamily:'inherit',boxSizing:'border-box' },
    label: { fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',display:'block',marginBottom:6 },
    chip: (a, col) => ({ padding:'5px 13px',borderRadius:20,fontSize:12,fontWeight:600,cursor:'pointer',border:`1px solid ${a?(col||c.accent):c.bd}`,background:a?(col||c.accent)+'18':'transparent',color:a?(col||c.accent):c.fg3,transition:'all .15s' }),
    tabBtn: (a) => ({ padding:'9px 16px',fontSize:12,fontWeight:600,border:'none',cursor:'pointer',background:'transparent',color:a?c.accent:c.fg3,borderBottom:`2px solid ${a?c.accent:'transparent'}`,transition:'all .15s' }),
  };

  const fileList = Object.keys(files || {}).sort();
  const fileTree = {};
  fileList.forEach(f => {
    const parts = f.split('/');
    if (parts.length === 1) { if (!fileTree['root']) fileTree['root'] = []; fileTree['root'].push(f); }
    else { const dir = parts[0]; if (!fileTree[dir]) fileTree[dir] = []; fileTree[dir].push(f); }
  });

  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.hdr}>
          <div style={{ width:36,height:36,borderRadius:9,background:'rgba(139,92,246,.15)',border:'1px solid rgba(139,92,246,.25)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18 }}>🔱</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15,fontWeight:700,color:c.fg }}>Terragrunt Generator</div>
            <div style={{ fontSize:11,color:c.fg3 }}>Generate production-ready terragrunt.hcl project structure — DRY, multi-env, remote state</div>
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:22,lineHeight:1,padding:4 }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex',borderBottom:`1px solid ${c.bd}`,background:c.bg2,flexShrink:0 }}>
          <button style={S.tabBtn(tab==='config')} onClick={() => setTab('config')}>⚙ Configure</button>
          {files && <button style={S.tabBtn(tab==='files')} onClick={() => setTab('files')}>📁 Generated Files ({fileList.length})</button>}
          <button style={S.tabBtn(tab==='guide')} onClick={() => setTab('guide')}>📖 Guide</button>
        </div>

        <div style={{ flex:1,overflow:'hidden',display:'flex' }}>
          {/* CONFIG TAB */}
          {tab === 'config' && (
            <div style={{ flex:1,overflow:'auto',padding:24,display:'flex',flexDirection:'column',gap:20 }}>
              {/* Info card */}
              <div style={{ background:'rgba(139,92,246,.06)',border:'1px solid rgba(139,92,246,.2)',borderRadius:12,padding:'14px 18px' }}>
                <div style={{ fontSize:13,fontWeight:700,color:'#8B5CF6',marginBottom:8 }}>What Terragrunt gives you</div>
                <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:8 }}>
                  {[
                    ['DRY backend config','One S3 remote_state block shared across all modules — no copy-paste'],
                    ['Per-module state isolation','Each module gets its own .tfstate key automatically'],
                    ['Dependency management','run-all respects module dependencies (VPC before EC2, etc.)'],
                    ['Environment parity','Same module code, different inputs per env — no duplication'],
                  ].map(([t,d]) => (
                    <div key={t} style={{ display:'flex',gap:8,alignItems:'flex-start' }}>
                      <span style={{ color:'#8B5CF6',fontWeight:700,flexShrink:0 }}>→</span>
                      <div><div style={{ fontSize:12,fontWeight:700,color:c.fg }}>{t}</div><div style={{ fontSize:11,color:c.fg3,lineHeight:1.5 }}>{d}</div></div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:16 }}>
                <div>
                  <label style={S.label}>Project Name</label>
                  <input value={form.project_name} onChange={e => set('project_name', e.target.value)} style={S.inp}
                    onFocus={e => e.target.style.borderColor=c.accent} onBlur={e => e.target.style.borderColor=c.bd} />
                </div>
                <div>
                  <label style={S.label}>AWS Account ID</label>
                  <input value={form.aws_account_id} onChange={e => set('aws_account_id', e.target.value)} placeholder="123456789012" style={S.inp}
                    onFocus={e => e.target.style.borderColor=c.accent} onBlur={e => e.target.style.borderColor=c.bd} />
                </div>
                <div>
                  <label style={S.label}>Primary Region</label>
                  <select value={form.aws_region} onChange={e => set('aws_region', e.target.value)} style={S.inp}>
                    {REGIONS.map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Terraform Version</label>
                  <input value={form.tf_version} onChange={e => set('tf_version', e.target.value)} style={S.inp}
                    onFocus={e => e.target.style.borderColor=c.accent} onBlur={e => e.target.style.borderColor=c.bd} />
                </div>
              </div>

              <div>
                <label style={S.label}>Environments</label>
                <div style={{ display:'flex',gap:8 }}>
                  {ENVS.map(env => (
                    <button key={env} onClick={() => toggleEnv(env)} style={S.chip(form.environments.includes(env), ENV_COLORS[env])}>
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={S.label}>Modules to include</label>
                <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
                  {MODULES_LIST.map(m => (
                    <button key={m.key} onClick={() => toggleMod(m.key)} style={{ ...S.chip(form.modules.includes(m.key)), display:'flex',alignItems:'center',gap:6 }}>
                      <span>{m.icon}</span> {m.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:11,color:c.fg3,marginTop:6 }}>
                  Auto-detected from your builder: {resources.map(r => r.service_type).filter(Boolean).join(', ') || 'none'}
                </div>
              </div>

              <button onClick={generate} disabled={loading || form.environments.length === 0 || form.modules.length === 0}
                style={{ padding:'13px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#8B5CF6,#3B82F6)',color:'white',fontWeight:800,fontSize:14,cursor:loading?'wait':'pointer',opacity:(form.environments.length===0||form.modules.length===0)?.5:1,letterSpacing:'-.01em' }}>
                {loading ? '⏳ Generating…' : '🔱 Generate Terragrunt Project'}
              </button>
            </div>
          )}

          {/* FILES TAB */}
          {tab === 'files' && files && (
            <div style={{ flex:1,display:'flex',overflow:'hidden' }}>
              {/* Tree sidebar */}
              <div style={{ width:240,flexShrink:0,borderRight:`1px solid ${c.bd}`,overflow:'auto',padding:8,display:'flex',flexDirection:'column',gap:2 }}>
                <button onClick={downloadAll} style={{ padding:'9px',borderRadius:8,border:'none',background:'linear-gradient(135deg,#8B5CF6,#3B82F6)',color:'white',fontWeight:700,fontSize:12,cursor:'pointer',marginBottom:10 }}>
                  ↓ Download All (.zip)
                </button>
                {Object.entries(fileTree).map(([dir, fls]) => (
                  <div key={dir}>
                    <div style={{ fontSize:10,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',padding:'4px 8px',marginTop:4 }}>
                      {dir === 'root' ? '📁 root' : `📁 ${dir}/`}
                    </div>
                    {fls.map(f => (
                      <button key={f} onClick={() => setActiveFile(f)}
                        style={{ width:'100%',padding:'6px 8px 6px 16px',borderRadius:7,border:`1px solid ${activeFile===f?c.accent:c.bd}`,background:activeFile===f?c.accent+'12':'transparent',color:activeFile===f?c.accent:c.fg3,fontSize:11,fontWeight:activeFile===f?700:500,cursor:'pointer',textAlign:'left',fontFamily:'JetBrains Mono,monospace',display:'block',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis' }}>
                        {f.split('/').pop()}
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {/* File viewer */}
              <div style={{ flex:1,display:'flex',flexDirection:'column',overflow:'hidden' }}>
                {activeFile && (
                  <div style={{ padding:'10px 16px',borderBottom:`1px solid ${c.bd}`,background:c.bg2,display:'flex',alignItems:'center',gap:10,flexShrink:0 }}>
                    <span style={{ fontSize:13,fontWeight:600,color:c.fg,fontFamily:'JetBrains Mono,monospace',flex:1 }}>{activeFile}</span>
                    <button onClick={() => copy(activeFile)} style={{ padding:'4px 12px',borderRadius:6,border:`1px solid ${c.bd}`,background:'transparent',color:c.fg3,fontSize:11,cursor:'pointer' }}>
                      {copied === activeFile ? '✓ Copied' : '📋 Copy'}
                    </button>
                  </div>
                )}
                <pre style={{ flex:1,overflow:'auto',margin:0,padding:'16px 20px',fontFamily:'JetBrains Mono,monospace',fontSize:12,lineHeight:1.7,color:c.fg2,background:c.bg }}>
                  {activeFile ? (files[activeFile] || '') : 'Select a file from the tree'}
                </pre>
              </div>
            </div>
          )}

          {/* GUIDE TAB */}
          {tab === 'guide' && (
            <div style={{ flex:1,overflow:'auto',padding:24,display:'flex',flexDirection:'column',gap:16 }}>
              <div style={{ fontSize:15,fontWeight:700,color:c.fg }}>Getting Started with Terragrunt</div>
              {[
                { step:'1', title:'Install Terragrunt', code:'brew install terragrunt\n# or: https://terragrunt.gruntwork.io/docs/getting-started/install/', note:'Requires Terraform CLI to also be installed' },
                { step:'2', title:'Set up Remote State', code:'# First run bootstrap (creates S3 + DynamoDB)\ncd bootstrap/ && terraform apply', note:'Do this once before running any terragrunt commands' },
                { step:'3', title:'Initialize a Module', code:'cd dev/vpc/\nterragrunt init\nterragrunt plan', note:'Terragrunt auto-generates backend.tf and provider.tf' },
                { step:'4', title:'Apply All Modules (Dev)', code:'make apply-all ENV=dev\n# or:\nterragrunt run-all apply --terragrunt-working-dir dev', note:'Modules are applied in dependency order' },
                { step:'5', title:'Promote to Production', code:'make plan-all ENV=prod\nmake apply-all ENV=prod', note:'Same code, different inputs — controlled by env.hcl' },
              ].map(({ step, title, code, note }) => (
                <div key={step} style={{ background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:12,padding:'14px 18px' }}>
                  <div style={{ display:'flex',alignItems:'center',gap:10,marginBottom:10 }}>
                    <div style={{ width:28,height:28,borderRadius:8,background:'rgba(139,92,246,.15)',border:'1px solid rgba(139,92,246,.25)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:800,color:'#8B5CF6',flexShrink:0 }}>{step}</div>
                    <div style={{ fontSize:13,fontWeight:700,color:c.fg }}>{title}</div>
                  </div>
                  <pre style={{ background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'10px 14px',fontFamily:'JetBrains Mono,monospace',fontSize:12,color:c.accent,margin:'0 0 8px',overflow:'auto' }}>{code}</pre>
                  <div style={{ fontSize:11,color:c.fg3,fontStyle:'italic' }}>💡 {note}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
