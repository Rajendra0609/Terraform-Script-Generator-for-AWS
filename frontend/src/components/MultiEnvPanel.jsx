import React, { useState } from 'react';
import API from '../api/client';

const ENVS = ['dev','staging','prod'];
const ENV_COLORS = { dev:'#10B981', staging:'#F59E0B', prod:'#EF4444' };

export default function MultiEnvPanel({ c, project, variables = [], onClose }) {
  const [activeEnvs, setActiveEnvs] = useState(['dev','staging','prod']);
  const [customVars, setCustomVars] = useState({ dev:{}, staging:{}, prod:{} });
  const [extraVars, setExtraVars]   = useState([]); // [{name,type,description,dev,staging,prod}]
  const [files, setFiles]           = useState(null);
  const [activeFile, setActiveFile] = useState('');
  const [loading, setLoading]       = useState(false);
  const [copied, setCopied]         = useState('');
  const [tab, setTab]               = useState('vars'); // vars | files

  const addVar = () => setExtraVars(v=>[...v,{name:'',type:'string',description:'',dev:'',staging:'',prod:''}]);
  const removeVar = idx => setExtraVars(v=>v.filter((_,i)=>i!==idx));
  const updateVar = (idx, field, val) => setExtraVars(v=>v.map((vr,i)=>i===idx?{...vr,[field]:val}:vr));

  const generate = async () => {
    setLoading(true);
    try {
      const r = await API.post('/api/envconfig/tfvars', {
        project_name: project?.name||'my-project',
        aws_region: project?.aws_region||'ap-south-1',
        environments: activeEnvs,
        custom_vars: customVars,
        variables: extraVars.filter(v=>v.name.trim()),
      });
      setFiles(r.data.files||{});
      setActiveFile(Object.keys(r.data.files||{})[0]||'');
      setTab('files');
    } catch(e) { alert(e.response?.data?.error||e.message); }
    finally { setLoading(false); }
  };

  const downloadAll = async () => {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      Object.entries(files||{}).forEach(([n,c])=>zip.file(n,c));
      const blob = await zip.generateAsync({type:'blob'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `${project?.name||'terraform'}-tfvars.zip`; a.click(); URL.revokeObjectURL(a.href);
    } catch { alert('Download failed'); }
  };

  const copy = async (name) => {
    await navigator.clipboard.writeText(files[name]||'');
    setCopied(name); setTimeout(()=>setCopied(''),2000);
  };

  const S = {
    overlay: { position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center' },
    modal: { background:c.bg,border:`1px solid ${c.bd}`,borderRadius:16,width:1000,maxWidth:'96vw',maxHeight:'90vh',display:'flex',flexDirection:'column',boxShadow:'0 32px 80px rgba(0,0,0,0.7)' },
    hdr: { padding:'16px 20px',borderBottom:`1px solid ${c.bd}`,display:'flex',alignItems:'center',gap:12,background:c.bg2,borderRadius:'16px 16px 0 0',flexShrink:0 },
    chip: (a,col) => ({ padding:'5px 13px',borderRadius:20,fontSize:12,fontWeight:600,cursor:'pointer',border:`1px solid ${a?(col||c.accent):c.bd}`,background:a?(col||c.accent)+'18':'transparent',color:a?(col||c.accent):c.fg3 }),
    inp: { background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:7,padding:'6px 10px',color:c.fg,fontSize:12,outline:'none',fontFamily:'inherit' },
    tabBtn: (a) => ({ padding:'8px 14px',fontSize:12,fontWeight:600,border:'none',cursor:'pointer',background:'transparent',color:a?c.accent:c.fg3,borderBottom:`2px solid ${a?c.accent:'transparent'}`,transition:'all .15s' }),
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={S.modal}>
        <div style={S.hdr}>
          <div style={{fontSize:22}}>⚙</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:c.fg}}>Multi-Environment Config</div>
            <div style={{fontSize:11,color:c.fg3}}>Generate separate .tfvars files for dev / staging / prod</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:22,lineHeight:1,padding:4}}>×</button>
        </div>

        {/* Tabs */}
        <div style={{display:'flex',borderBottom:`1px solid ${c.bd}`,background:c.bg2,flexShrink:0}}>
          <button style={S.tabBtn(tab==='vars')} onClick={()=>setTab('vars')}>⚙ Configure</button>
          {files&&<button style={S.tabBtn(tab==='files')} onClick={()=>setTab('files')}>📄 Generated Files</button>}
        </div>

        <div style={{flex:1,overflow:'auto',padding:20,display:'flex',flexDirection:'column',gap:16}}>
          {tab==='vars'&&(
            <>
              {/* Environment selector */}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',marginBottom:8}}>Select Environments</div>
                <div style={{display:'flex',gap:8}}>
                  {ENVS.map(env=>(
                    <button key={env} onClick={()=>setActiveEnvs(prev=>prev.includes(env)?prev.filter(e=>e!==env):[...prev,env])}
                      style={S.chip(activeEnvs.includes(env),ENV_COLORS[env])}>
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              {/* Per-env overrides */}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',marginBottom:10}}>Environment-Specific Overrides</div>
                <div style={{background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:12,overflow:'hidden'}}>
                  <div style={{display:'grid',gridTemplateColumns:`180px ${activeEnvs.map(()=>'1fr').join(' ')}`,background:c.bg3,borderBottom:`1px solid ${c.bd}`}}>
                    <div style={{padding:'8px 12px',fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase'}}>Variable</div>
                    {activeEnvs.map(env=><div key={env} style={{padding:'8px 12px',fontSize:11,fontWeight:700,color:ENV_COLORS[env],textTransform:'uppercase'}}>{env}</div>)}
                  </div>
                  {[
                    {key:'instance_type',label:'Instance Type',default:{dev:'t3.micro',staging:'t3.small',prod:'t3.medium'}},
                    {key:'db_instance_class',label:'DB Instance Class',default:{dev:'db.t3.micro',staging:'db.t3.small',prod:'db.t3.medium'}},
                    {key:'min_capacity',label:'Min Capacity',default:{dev:'1',staging:'1',prod:'2'}},
                    {key:'max_capacity',label:'Max Capacity',default:{dev:'2',staging:'4',prod:'10'}},
                    {key:'multi_az',label:'Multi-AZ RDS',default:{dev:'false',staging:'false',prod:'true'}},
                    {key:'deletion_protection',label:'Deletion Protection',default:{dev:'false',staging:'true',prod:'true'}},
                    {key:'log_retention_days',label:'Log Retention Days',default:{dev:'7',staging:'14',prod:'90'}},
                  ].map(row=>(
                    <div key={row.key} style={{display:'grid',gridTemplateColumns:`180px ${activeEnvs.map(()=>'1fr').join(' ')}`,borderBottom:`1px solid ${c.bd}`}}>
                      <div style={{padding:'8px 12px',fontSize:12,color:c.fg2,display:'flex',alignItems:'center'}}>{row.label}</div>
                      {activeEnvs.map(env=>(
                        <div key={env} style={{padding:'6px 8px',display:'flex',alignItems:'center'}}>
                          <input value={(customVars[env]?.[row.key] ?? row.default[env]) || ''}
                            onChange={e=>setCustomVars(prev=>({...prev,[env]:{...prev[env],[row.key]:e.target.value}}))}
                            style={{...S.inp,width:'100%',borderColor:customVars[env]?.[row.key]?ENV_COLORS[env]+'60':c.bd}}
                            placeholder={row.default[env]||''} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* Custom variables */}
              <div>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em'}}>Custom Variables ({extraVars.length})</div>
                  <button onClick={addVar} style={{padding:'5px 12px',borderRadius:7,border:`1px solid ${c.bd}`,background:'transparent',color:c.accent,fontSize:12,fontWeight:600,cursor:'pointer'}}>+ Add Variable</button>
                </div>
                {extraVars.map((v,i)=>(
                  <div key={i} style={{background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:10,padding:12,marginBottom:8}}>
                    <div style={{display:'grid',gridTemplateColumns:`1fr 100px ${activeEnvs.map(()=>'1fr').join(' ')} 30px`,gap:8,alignItems:'center'}}>
                      <input value={v.name} onChange={e=>updateVar(i,'name',e.target.value)} placeholder="variable_name" style={{...S.inp,fontFamily:'JetBrains Mono,monospace'}} />
                      <select value={v.type} onChange={e=>updateVar(i,'type',e.target.value)} style={{...S.inp,appearance:'none'}}>
                        {['string','number','bool','list(string)','map(string)'].map(t=><option key={t}>{t}</option>)}
                      </select>
                      {activeEnvs.map(env=>(
                        <input key={env} value={v[env]||''} onChange={e=>updateVar(i,env,e.target.value)}
                          placeholder={env} style={{...S.inp,borderColor:v[env]?ENV_COLORS[env]+'60':c.bd}} />
                      ))}
                      <button onClick={()=>removeVar(i)} style={{background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:16,padding:0}}>×</button>
                    </div>
                  </div>
                ))}
              </div>

              <button onClick={generate} disabled={loading||activeEnvs.length===0}
                style={{padding:'12px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#00D4A1,#0098FF)',color:'#001A0F',fontWeight:800,fontSize:14,cursor:loading?'wait':'pointer',opacity:activeEnvs.length===0?.5:1}}>
                {loading?'⏳ Generating…':'⚡ Generate .tfvars Files'}
              </button>
            </>
          )}

          {tab==='files'&&files&&(
            <div style={{display:'flex',gap:0,flex:1,minHeight:0,height:'100%'}}>
              {/* File list */}
              <div style={{width:200,flexShrink:0,borderRight:`1px solid ${c.bd}`,display:'flex',flexDirection:'column',gap:2,padding:8}}>
                {Object.keys(files).map(name=>(
                  <button key={name} onClick={()=>setActiveFile(name)}
                    style={{padding:'8px 10px',borderRadius:7,border:`1px solid ${activeFile===name?c.accent:c.bd}`,background:activeFile===name?c.accent+'12':'transparent',color:activeFile===name?c.accent:c.fg2,fontSize:11,fontWeight:600,cursor:'pointer',textAlign:'left',fontFamily:'JetBrains Mono,monospace'}}>
                    {name.endsWith('.tfvars')&&<span style={{color:ENV_COLORS[name.split('.')[0]]||c.accent}}>●</span>} {name}
                  </button>
                ))}
                <div style={{flex:1}} />
                <button onClick={downloadAll} style={{padding:'8px',borderRadius:8,border:'none',background:'linear-gradient(135deg,#00D4A1,#0098FF)',color:'#001A0F',fontWeight:700,fontSize:12,cursor:'pointer',marginTop:8}}>
                  ↓ Download All (.zip)
                </button>
              </div>
              {/* File content */}
              <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
                <div style={{padding:'8px 14px',borderBottom:`1px solid ${c.bd}`,background:c.bg2,display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
                  <span style={{fontSize:12,fontWeight:600,color:c.fg,fontFamily:'JetBrains Mono,monospace'}}>{activeFile}</span>
                  <button onClick={()=>copy(activeFile)} style={{padding:'4px 12px',borderRadius:6,border:`1px solid ${c.bd}`,background:'transparent',color:c.fg3,fontSize:11,cursor:'pointer'}}>
                    {copied===activeFile?'✓ Copied':'📋 Copy'}
                  </button>
                </div>
                <pre style={{flex:1,overflow:'auto',margin:0,padding:'14px 18px',fontFamily:'JetBrains Mono,monospace',fontSize:12,lineHeight:1.7,color:c.fg2,background:c.bg}}>
                  {files[activeFile]||''}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
