import React, { useState, useCallback, useRef } from 'react';
import API from '../api/client';

const SEV_COLOR = { error:'#EF4444', warning:'#F59E0B', info:'#3B82F6' };
const TYPE_ICON = { untracked:'⚠', planned:'✦', tainted:'☠', deposed:'⚡' };
const SVC_ICON = { ec2:'🖥',vpc:'🌐',subnet:'🔷',rds:'🗄',s3:'🪣',lambda:'λ',alb:'⚖',iam_role:'👤',eks_cluster:'☸',dynamodb:'⚡',security_group:'🛡',nat_gateway:'🔀',internet_gateway:'🔗',cloudfront:'🌍',route53:'📡',sns:'📣',sqs:'📨',cloudwatch_alarm:'🔔',elasticache:'⚡',ecs_cluster:'🐳' };

export default function StateInspector({ c, resources = [], onClose }) {
  const [step, setStep]         = useState('upload'); // upload | results
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [result, setResult]     = useState(null);
  const [tab, setTab]           = useState('summary'); // summary | resources | drift | tags
  const [filter, setFilter]     = useState('');
  const fileRef = useRef();

  const inspect = useCallback(async (json) => {
    setLoading(true); setError('');
    try {
      const r = await API.post('/api/state/inspect', { state: json, config_resources: resources });
      setResult(r.data);
      setStep('results');
      setTab('summary');
    } catch(e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [resources]);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    if (!file.name.endsWith('.tfstate') && !file.name.endsWith('.json')) {
      return setError('Please upload a .tfstate or .json file');
    }
    try {
      const txt = await file.text();
      const json = JSON.parse(txt);
      await inspect(json);
    } catch(e) { setError(`Cannot parse file: ${e.message}`); }
  }, [inspect]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    onFile(e.dataTransfer.files[0]);
  }, [onFile]);

  const S = {
    overlay: { position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center' },
    modal: { background:c.bg,border:`1px solid ${c.bd}`,borderRadius:16,width:920,maxWidth:'96vw',maxHeight:'90vh',display:'flex',flexDirection:'column',boxShadow:'0 32px 80px rgba(0,0,0,0.7)' },
    hdr: { padding:'16px 20px',borderBottom:`1px solid ${c.bd}`,display:'flex',alignItems:'center',gap:12,background:c.bg2,borderRadius:'16px 16px 0 0' },
    body: { flex:1,overflow:'auto',padding:20 },
    chip: (a) => ({ padding:'5px 13px',borderRadius:20,fontSize:12,fontWeight:600,cursor:'pointer',border:`1px solid ${a?c.accent:c.bd}`,background:a?c.accent+'18':'transparent',color:a?c.accent:c.fg3,transition:'all .15s' }),
    card: { background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:12,padding:'16px 18px',marginBottom:10 },
    tag: (col) => ({ fontSize:11,padding:'2px 8px',borderRadius:99,background:col+'15',border:`1px solid ${col}30`,color:col,fontWeight:700 }),
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.hdr}>
          <div style={{ width:36,height:36,borderRadius:9,background:'#3B82F615',border:'1px solid #3B82F625',display:'flex',alignItems:'center',justifyContent:'center',fontSize:18 }}>🔍</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:c.fg}}>Terraform State Inspector</div>
            <div style={{fontSize:11,color:c.fg3}}>Upload terraform.tfstate → visualize resources + detect drift</div>
          </div>
          {step==='results' && <button onClick={()=>setStep('upload')} style={{padding:'5px 12px',borderRadius:7,border:`1px solid ${c.bd}`,background:'transparent',color:c.fg3,fontSize:12,cursor:'pointer'}}>↑ New File</button>}
          <button onClick={onClose} style={{background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:22,lineHeight:1,padding:4}}>×</button>
        </div>

        <div style={S.body}>
          {/* UPLOAD STEP */}
          {step==='upload' && (
            <div style={{display:'flex',flexDirection:'column',gap:16,alignItems:'center'}}>
              <div
                onDragOver={e=>{e.preventDefault();setDragging(true)}}
                onDragLeave={()=>setDragging(false)}
                onDrop={onDrop}
                onClick={()=>fileRef.current.click()}
                style={{width:'100%',maxWidth:540,minHeight:220,border:`2px dashed ${dragging?c.accent:c.bd}`,borderRadius:16,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,cursor:'pointer',background:dragging?c.accent+'06':'transparent',transition:'all .2s'}}>
                <div style={{fontSize:52}}>📄</div>
                <div style={{fontSize:15,fontWeight:700,color:c.fg}}>Drop terraform.tfstate here</div>
                <div style={{fontSize:12,color:c.fg3}}>or click to browse</div>
                <input ref={fileRef} type="file" accept=".tfstate,.json" style={{display:'none'}} onChange={e=>onFile(e.target.files[0])} />
              </div>
              {loading && <div style={{color:c.fg2,fontSize:13}}>⏳ Parsing state file…</div>}
              {error && <div style={{color:'#EF4444',fontSize:13,background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.2)',borderRadius:8,padding:'10px 16px',width:'100%',maxWidth:540}}>{error}</div>}
              <div style={{fontSize:12,color:c.fg3,maxWidth:540,lineHeight:1.65,textAlign:'center'}}>
                <strong style={{color:c.fg}}>What you get:</strong> Live resource inventory · Drift detection vs your builder config · Tag compliance · Tainted/deposed resource alerts
              </div>
            </div>
          )}

          {/* RESULTS STEP */}
          {step==='results' && result && (
            <div style={{display:'flex',flexDirection:'column',gap:16}}>
              {/* Tabs */}
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[['summary','📊 Summary'],['resources','📦 Resources'],['drift','⚡ Drift'],['tags','🏷 Tags']].map(([id,lbl])=>(
                  <button key={id} onClick={()=>setTab(id)} style={S.chip(tab===id)}>{lbl}{id==='drift'&&result.drift.length?` (${result.drift.length})`:''}{id==='tags'&&result.tag_issues.length?` (${result.tag_issues.length})`:''}</button>
                ))}
              </div>

              {/* SUMMARY TAB */}
              {tab==='summary' && (
                <div style={{display:'flex',flexDirection:'column',gap:12}}>
                  {/* Meta */}
                  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                    {[['State Version',result.state_version],['Terraform',result.terraform_version||'?'],['Serial',result.serial||'?'],['Resources',result.summary.total],['Tainted',result.summary.tainted,'#EF4444'],['Untracked',result.summary.untracked,'#F59E0B'],['Planned',result.summary.planned,'#3B82F6']].map(([k,v,col])=>(
                      <div key={k} style={{background:c.bg2,border:`1px solid ${c.bd}`,borderRadius:10,padding:'12px 16px',flex:1,minWidth:100}}>
                        <div style={{fontSize:20,fontWeight:800,color:col||c.fg}}>{v}</div>
                        <div style={{fontSize:11,color:c.fg3,fontWeight:600,textTransform:'uppercase',letterSpacing:'.06em'}}>{k}</div>
                      </div>
                    ))}
                  </div>
                  {/* By service */}
                  <div style={S.card}>
                    <div style={{fontSize:12,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',marginBottom:12}}>Resources by Service</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                      {Object.entries(result.summary.by_service||{}).sort((a,b)=>b[1]-a[1]).map(([svc,cnt])=>(
                        <div key={svc} style={{display:'flex',alignItems:'center',gap:6,background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'6px 12px'}}>
                          <span style={{fontSize:16}}>{SVC_ICON[svc]||'*'}</span>
                          <span style={{fontSize:12,color:c.fg,fontWeight:600}}>{svc}</span>
                          <span style={{fontSize:12,color:c.accent,fontWeight:700}}>{cnt}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {result.warnings?.map((w,i)=><div key={i} style={{background:'rgba(245,158,11,.08)',border:'1px solid rgba(245,158,11,.2)',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#F59E0B'}}>⚠ {w}</div>)}
                </div>
              )}

              {/* RESOURCES TAB */}
              {tab==='resources' && (
                <div>
                  <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter resources…"
                    style={{width:'100%',background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'9px 14px',color:c.fg,fontSize:13,outline:'none',marginBottom:12,boxSizing:'border-box',fontFamily:'inherit'}} />
                  <div style={{display:'flex',flexDirection:'column',gap:8}}>
                    {result.resources.filter(r=>!filter||`${r.type}.${r.name}`.includes(filter)||r.arn?.includes(filter)).map((r,i)=>(
                      <div key={i} style={{background:c.bg2,border:`1px solid ${r.tainted?'#EF4444':r.deposed?'#F59E0B':c.bd}`,borderRadius:10,padding:'12px 16px'}}>
                        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                          <span style={{fontSize:18}}>{SVC_ICON[r.service_type]||'*'}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:13,fontWeight:700,color:c.fg,fontFamily:'JetBrains Mono,monospace'}}>{r.type}.{r.name}</div>
                            {r.arn&&<div style={{fontSize:10,color:c.fg3,fontFamily:'JetBrains Mono,monospace',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.arn}</div>}
                          </div>
                          <div style={{display:'flex',gap:5}}>
                            {r.tainted&&<span style={S.tag('#EF4444')}>TAINTED</span>}
                            {r.deposed&&<span style={S.tag('#F59E0B')}>DEPOSED</span>}
                            {r.module&&<span style={S.tag('#8B5CF6')}>module</span>}
                          </div>
                        </div>
                        {Object.keys(r.key_attrs||{}).length>0&&(
                          <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                            {Object.entries(r.key_attrs).map(([k,v])=>(
                              <div key={k} style={{fontSize:11,background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:6,padding:'3px 8px'}}>
                                <span style={{color:c.fg3}}>{k}: </span><span style={{color:c.fg,fontFamily:'JetBrains Mono,monospace'}}>{String(v).slice(0,60)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* DRIFT TAB */}
              {tab==='drift' && (
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {result.drift.length===0?(
                    <div style={{textAlign:'center',padding:40,color:c.fg3}}>
                      <div style={{fontSize:36,marginBottom:12}}>✅</div>
                      <div style={{fontSize:14,fontWeight:700,color:c.fg}}>No drift detected</div>
                      <div style={{fontSize:12,marginTop:6}}>Your builder config matches the state file</div>
                    </div>
                  ):result.drift.map((d,i)=>(
                    <div key={i} style={{background:c.bg2,border:`1px solid ${SEV_COLOR[d.severity]||c.bd}30`,borderRadius:10,padding:'12px 16px',display:'flex',gap:12,alignItems:'flex-start'}}>
                      <div style={{fontSize:20,flexShrink:0}}>{TYPE_ICON[d.type]||'●'}</div>
                      <div style={{flex:1}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                          <span style={S.tag(SEV_COLOR[d.severity]||c.fg3)}>{d.type}</span>
                          <code style={{fontSize:12,color:c.accent,fontFamily:'JetBrains Mono,monospace'}}>{d.resource}</code>
                        </div>
                        <div style={{fontSize:12,color:c.fg2,lineHeight:1.6}}>{d.message}</div>
                        {d.arn&&<div style={{fontSize:10,color:c.fg3,fontFamily:'JetBrains Mono,monospace',marginTop:4}}>{d.arn}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* TAGS TAB */}
              {tab==='tags' && (
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {result.tag_issues.length===0?(
                    <div style={{textAlign:'center',padding:40,color:c.fg3}}>
                      <div style={{fontSize:36,marginBottom:12}}>🏷</div>
                      <div style={{fontSize:14,fontWeight:700,color:c.fg}}>All resources have required tags</div>
                    </div>
                  ):(
                    <>
                      <div style={{fontSize:12,color:c.fg3,background:c.bg3,borderRadius:8,padding:'8px 12px',marginBottom:4}}>
                        Required tags: <strong style={{color:c.fg}}>Name, Environment, Terraform</strong>
                      </div>
                      {result.tag_issues.map((t,i)=>(
                        <div key={i} style={{background:c.bg2,border:`1px solid rgba(245,158,11,.25)`,borderRadius:10,padding:'12px 16px',display:'flex',alignItems:'center',gap:12}}>
                          <span style={{fontSize:16}}>⚠</span>
                          <div style={{flex:1}}>
                            <code style={{fontSize:12,color:c.fg,fontFamily:'JetBrains Mono,monospace'}}>{t.resource}</code>
                            <div style={{display:'flex',gap:5,marginTop:5,flexWrap:'wrap'}}>
                              {t.missing_tags.map(tag=><span key={tag} style={S.tag('#F59E0B')}>missing: {tag}</span>)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
