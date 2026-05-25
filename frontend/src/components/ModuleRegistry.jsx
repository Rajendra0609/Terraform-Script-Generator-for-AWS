import React, { useState, useEffect, useCallback } from 'react';
import API from '../api/client';

const PROVIDER_ICONS = { aws:'🟠', google:'🔵', azurerm:'🔷', kubernetes:'☸', helm:'⎈' };

export default function ModuleRegistry({ c, onImport, onClose }) {
  const [q, setQ]               = useState('');
  const [provider, setProvider] = useState('aws');
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selVersion, setSelVersion] = useState('');
  const [inputs, setInputs]     = useState({});
  const [moduleName, setModuleName] = useState('');
  const [generatedHCL, setGeneratedHCL] = useState('');
  const [generating, setGenerating] = useState(false);
  const [offline, setOffline]   = useState(false);
  const [step, setStep]         = useState('search'); // search | configure | preview

  const search = useCallback(async (query) => {
    setLoading(true);
    try {
      const r = await API.get(`/api/registry/search?q=${encodeURIComponent(query)}&provider=${provider}&limit=20`);
      setResults(r.data.modules||[]);
      setOffline(r.data.offline||false);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, [provider]);

  useEffect(() => { search(''); }, []);// eslint-disable-line

  const selectModule = async (mod) => {
    setSelected(mod);
    setModuleName(mod.name.replace(/-/g,'_'));
    setStep('configure');
    // Load template inputs
    try {
      const r = await API.get(`/api/registry/module/${mod.namespace}/${mod.name}/${mod.provider}`);
      const template = r.data.input_template || [];
      const defaults = {};
      template.forEach(v => { defaults[v.key] = v.default || ''; });
      setInputs(defaults);
    } catch { setInputs({}); }
    // Load versions
    try {
      const vr = await API.get(`/api/registry/module/${mod.namespace}/${mod.name}/${mod.provider}/versions`);
      const vlist = vr.data.modules?.[0]?.versions?.map(v=>v.version) || [mod.latest||'latest'];
      setVersions(vlist);
      setSelVersion(vlist[0]||mod.latest||'latest');
    } catch { setVersions([mod.latest||'latest']); setSelVersion(mod.latest||'latest'); }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await API.post('/api/registry/import', { module: selected, version: selVersion, inputs, module_name: moduleName });
      setGeneratedHCL(r.data.hcl||'');
      setStep('preview');
    } catch(e) { alert(e.response?.data?.error||e.message); }
    finally { setGenerating(false); }
  };

  const S = {
    overlay: { position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center' },
    modal: { background:c.bg,border:`1px solid ${c.bd}`,borderRadius:16,width:980,maxWidth:'96vw',maxHeight:'90vh',display:'flex',flexDirection:'column',boxShadow:'0 32px 80px rgba(0,0,0,0.7)' },
    hdr: { padding:'16px 20px',borderBottom:`1px solid ${c.bd}`,display:'flex',alignItems:'center',gap:12,background:c.bg2,borderRadius:'16px 16px 0 0',flexShrink:0 },
    body: { flex:1,overflow:'hidden',display:'flex' },
    card: (sel) => ({ background:sel?c.accent+'10':c.bg2,border:`1.5px solid ${sel?c.accent:c.bd}`,borderRadius:12,padding:'14px 16px',cursor:'pointer',transition:'all .15s',display:'flex',flexDirection:'column',gap:8 }),
    inp: { width:'100%',background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'8px 12px',color:c.fg,fontSize:12,outline:'none',fontFamily:'JetBrains Mono,monospace',boxSizing:'border-box',transition:'border-color .15s' },
    btn: (v) => ({ padding:'8px 20px',borderRadius:9,border:'none',background:v==='accent'?'linear-gradient(135deg,#00D4A1,#0098FF)':c.bg3,color:v==='accent'?'#001A0F':c.fg2,fontWeight:700,fontSize:13,cursor:'pointer' }),
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.hdr}>
          <div style={{fontSize:22}}>📚</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:c.fg}}>Terraform Module Registry</div>
            <div style={{fontSize:11,color:c.fg3}}>
              {offline?'🔴 Offline — showing curated modules':'🟢 Live from registry.terraform.io'} · Browse & import into builder
            </div>
          </div>
          {step!=='search'&&<button onClick={()=>setStep('search')} style={{padding:'5px 12px',borderRadius:7,border:`1px solid ${c.bd}`,background:'transparent',color:c.fg3,fontSize:12,cursor:'pointer'}}>← Back</button>}
          <button onClick={onClose} style={{background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:22,lineHeight:1,padding:4}}>×</button>
        </div>

        <div style={S.body}>
          {/* SEARCH */}
          {step==='search' && (
            <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
              <div style={{padding:'14px 16px',borderBottom:`1px solid ${c.bd}`,background:c.bg2,display:'flex',gap:10,flexShrink:0}}>
                <div style={{position:'relative',flex:1}}>
                  <span style={{position:'absolute',left:12,top:'50%',transform:'translateY(-50%)',color:c.fg3}}>🔍</span>
                  <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search(q)} placeholder="Search modules (e.g. vpc, eks, rds)…"
                    style={{...S.inp,paddingLeft:36}} onFocus={e=>e.target.style.borderColor=c.accent} onBlur={e=>e.target.style.borderColor=c.bd} />
                </div>
                <select value={provider} onChange={e=>setProvider(e.target.value)} style={{background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'8px 10px',color:c.fg,fontSize:12,outline:'none'}}>
                  {Object.keys(PROVIDER_ICONS).map(p=><option key={p} value={p}>{PROVIDER_ICONS[p]} {p}</option>)}
                </select>
                <button onClick={()=>search(q)} style={S.btn('accent')}>Search</button>
              </div>
              <div style={{flex:1,overflow:'auto',padding:16,display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:10,alignContent:'start'}}>
                {loading&&[1,2,3,4,5,6].map(i=><div key={i} style={{height:120,borderRadius:12,background:'linear-gradient(90deg,#10141C 25%,#161B26 50%,#10141C 75%)',backgroundSize:'200% 100%',animation:'shimmer 1.6s infinite'}} />)}
                {!loading&&results.map((mod,i)=>(
                  <div key={i} style={S.card(false)} onClick={()=>selectModule(mod)}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor=c.accent+'60';e.currentTarget.style.transform='translateY(-1px)'}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=c.bd;e.currentTarget.style.transform='none'}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:20}}>{PROVIDER_ICONS[mod.provider]||'📦'}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,color:c.fg,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{mod.namespace}/{mod.name}</div>
                        <div style={{fontSize:10,color:c.fg3}}>{mod.provider} · v{mod.latest}</div>
                      </div>
                      {mod.verified&&<span style={{fontSize:9,padding:'2px 6px',borderRadius:99,background:'rgba(0,212,161,.12)',border:'1px solid rgba(0,212,161,.25)',color:'#00D4A1',fontWeight:700}}>✓ VERIFIED</span>}
                    </div>
                    <p style={{fontSize:12,color:c.fg2,margin:0,lineHeight:1.5,overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical'}}>{mod.description}</p>
                    <div style={{fontSize:11,color:c.fg3}}>{(mod.downloads/1e6).toFixed(1)}M downloads</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CONFIGURE */}
          {step==='configure' && selected && (
            <div style={{flex:1,display:'flex',overflow:'hidden'}}>
              {/* Inputs */}
              <div style={{flex:1,overflow:'auto',padding:20,display:'flex',flexDirection:'column',gap:14}}>
                <div style={{background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:12,padding:'14px 16px'}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
                    <span style={{fontSize:22}}>{PROVIDER_ICONS[selected.provider]||'📦'}</span>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:c.fg}}>{selected.namespace}/{selected.name}</div>
                      <div style={{fontSize:11,color:c.fg3}}>{selected.provider}</div>
                    </div>
                    <div style={{flex:1}} />
                    <select value={selVersion} onChange={e=>setSelVersion(e.target.value)}
                      style={{background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:7,padding:'5px 10px',color:c.fg,fontSize:12,outline:'none'}}>
                      {versions.map(v=><option key={v}>{v}</option>)}
                    </select>
                  </div>
                  <p style={{fontSize:12,color:c.fg2,margin:0,lineHeight:1.55}}>{selected.description}</p>
                </div>

                <div>
                  <label style={{fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',display:'block',marginBottom:6}}>Module Block Name</label>
                  <input value={moduleName} onChange={e=>setModuleName(e.target.value.replace(/[^a-z0-9_]/gi,'_'))}
                    style={S.inp} placeholder="e.g. main_vpc" onFocus={e=>e.target.style.borderColor=c.accent} onBlur={e=>e.target.style.borderColor=c.bd} />
                </div>

                {Object.keys(inputs).length>0&&(
                  <div style={{display:'flex',flexDirection:'column',gap:10}}>
                    <div style={{fontSize:12,fontWeight:700,color:c.fg}}>Input Variables</div>
                    {Object.entries(inputs).map(([k,v])=>(
                      <div key={k}>
                        <label style={{fontSize:11,fontWeight:600,color:c.fg3,display:'block',marginBottom:4}}>{k}</label>
                        <input value={v} onChange={e=>setInputs(prev=>({...prev,[k]:e.target.value}))}
                          style={S.inp} placeholder={`Enter ${k}`} onFocus={e=>e.target.style.borderColor=c.accent} onBlur={e=>e.target.style.borderColor=c.bd} />
                      </div>
                    ))}
                  </div>
                )}

                <button onClick={generate} disabled={generating} style={{...S.btn('accent'),width:'100%',padding:'11px'}}>
                  {generating?'⏳ Generating…':'⚡ Generate HCL Module Block'}
                </button>
              </div>
            </div>
          )}

          {/* PREVIEW */}
          {step==='preview' && (
            <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
              <div style={{padding:'12px 16px',borderBottom:`1px solid ${c.bd}`,background:c.bg2,display:'flex',gap:8,flexShrink:0}}>
                <span style={{fontSize:13,fontWeight:600,color:c.fg,flex:1}}>Generated module block — ready to import</span>
                <button onClick={()=>navigator.clipboard.writeText(generatedHCL)} style={{...S.btn('default'),padding:'6px 14px',fontSize:12}}>📋 Copy</button>
                <button onClick={()=>onImport(generatedHCL)} style={S.btn('accent')}>⚡ Import to Builder</button>
              </div>
              <pre style={{flex:1,overflow:'auto',margin:0,padding:'16px 20px',fontFamily:'JetBrains Mono,monospace',fontSize:12.5,lineHeight:1.7,color:c.fg2,background:c.bg}}>
                {generatedHCL}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
