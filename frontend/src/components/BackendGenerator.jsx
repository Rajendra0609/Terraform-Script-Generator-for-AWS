import React, { useState } from 'react';
import API from '../api/client';
import { DEFAULT_AWS_REGION } from '../utils/awsRegions';

export default function BackendGenerator({ c, project, onClose }) {
  const [form, setForm] = useState({
    project_name: project?.name||'my-project',
    aws_region: project?.aws_region || DEFAULT_AWS_REGION,
    aws_account_id: 'ACCOUNT_ID',
    environments: ['dev','staging','prod'],
    enable_encryption: true,
    enable_versioning: true,
  });
  const [files, setFiles] = useState(null);
  const [activeFile, setActiveFile] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState('');
  const [apiWarnings, setApiWarnings] = useState([]);

  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  const isAccountIdPlaceholder = !form.aws_account_id || form.aws_account_id === 'ACCOUNT_ID';

  const generate = async () => {
    setLoading(true);
    try {
      const r = await API.post('/api/envconfig/backend', form);
      setFiles(r.data.files||{});
      setActiveFile('bootstrap.tf');
      setApiWarnings(r.data.warnings||[]);
    } catch(e) { alert(e.response?.data?.error||e.message); }
    finally { setLoading(false); }
  };

  const downloadAll = async () => {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      Object.entries(files||{}).forEach(([n,content])=>zip.file(n,content));
      const blob = await zip.generateAsync({type:'blob'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download=`${form.project_name}-backend.zip`; a.click(); URL.revokeObjectURL(a.href);
    } catch { alert('Download failed'); }
  };

  const copy = async (name) => {
    await navigator.clipboard.writeText(files[name]||'');
    setCopied(name); setTimeout(()=>setCopied(''),2000);
  };

  const REGIONS = ['ap-south-1','us-east-1','us-west-2','eu-west-1','eu-central-1','ap-southeast-1','ap-northeast-1'];
  const ENVS = ['dev','staging','prod','test'];

  const S = {
    overlay: { position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(6px)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center' },
    modal: { background:c.bg,border:`1px solid ${c.bd}`,borderRadius:16,width:960,maxWidth:'96vw',maxHeight:'90vh',display:'flex',flexDirection:'column',boxShadow:'0 32px 80px rgba(0,0,0,0.7)' },
    hdr: { padding:'16px 20px',borderBottom:`1px solid ${c.bd}`,display:'flex',alignItems:'center',gap:12,background:c.bg2,borderRadius:'16px 16px 0 0',flexShrink:0 },
    inp: (w) => ({ width:w||'100%',background:c.bg3,border:`1px solid ${c.bd}`,borderRadius:8,padding:'9px 12px',color:c.fg,fontSize:13,outline:'none',fontFamily:'inherit',boxSizing:'border-box',transition:'border-color .15s' }),
    label: { fontSize:11,fontWeight:700,color:c.fg3,textTransform:'uppercase',letterSpacing:'.08em',display:'block',marginBottom:6 },
    btn: (v) => ({ padding:'9px 20px',borderRadius:9,border:'none',background:v==='accent'?'linear-gradient(135deg,#00D4A1,#0098FF)':c.bg3,color:v==='accent'?'#001A0F':c.fg2,fontWeight:700,fontSize:13,cursor:'pointer' }),
  };

  const FILE_INFO = {
    'backend.tf': { icon:'☁', desc:'Add this to your main Terraform config after bootstrap is done' },
    'bootstrap.tf': { icon:'🚀', desc:'Run once to create the S3 bucket and DynamoDB table' },
    'iam-policy.json': { icon:'🛡', desc:'Attach this policy to your Terraform execution IAM role' },
    'BACKEND_README.md': { icon:'📖', desc:'Step-by-step setup guide' },
  };

  return (
    <div style={S.overlay} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={S.modal}>
        <div style={S.hdr}>
          <div style={{fontSize:22}}>☁</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700,color:c.fg}}>Remote Backend Generator</div>
            <div style={{fontSize:11,color:c.fg3}}>Generate S3 + DynamoDB Terraform state backend with IAM policy</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:c.fg3,cursor:'pointer',fontSize:22,lineHeight:1,padding:4}}>×</button>
        </div>

        <div style={{flex:1,overflow:'hidden',display:'flex'}}>
          {/* Left: Form */}
          <div style={{width:340,flexShrink:0,borderRight:`1px solid ${c.bd}`,overflow:'auto',padding:20,display:'flex',flexDirection:'column',gap:14}}>
            {/* Architecture info */}
            <div style={{background:'rgba(0,212,161,.06)',border:'1px solid rgba(0,212,161,.15)',borderRadius:10,padding:'12px 14px'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#00D4A1',marginBottom:8}}>What gets generated</div>
              <div style={{display:'flex',flexDirection:'column',gap:5}}>
                {[['bootstrap.tf','S3 bucket + DynamoDB table + security settings'],['backend.tf','terraform backend "s3" block for your config'],['iam-policy.json','Minimum IAM policy for Terraform execution role'],['BACKEND_README.md','Step-by-step setup guide']].map(([f,d])=>(
                  <div key={f} style={{fontSize:11,color:'#8B96B0',display:'flex',gap:6}}>
                    <span style={{color:'#00D4A1',fontWeight:700,minWidth:20}}>→</span>
                    <div><code style={{color:'#E4EAF4',fontFamily:'JetBrains Mono,monospace'}}>{f}</code><br/>{d}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label style={S.label}>Project Name</label>
              <input value={form.project_name} onChange={e=>set('project_name',e.target.value)} style={S.inp()}
                onFocus={e=>e.target.style.borderColor=c.accent} onBlur={e=>e.target.style.borderColor=c.bd} />
              <div style={{fontSize:10,color:c.fg3,marginTop:4}}>State bucket: <code style={{fontFamily:'JetBrains Mono,monospace',color:c.accent}}>{form.project_name}-terraform-state</code></div>
            </div>

            <div>
              <label style={S.label}>AWS Account ID</label>
              <input value={form.aws_account_id} onChange={e=>set('aws_account_id',e.target.value)} style={{...S.inp(),borderColor:isAccountIdPlaceholder?'#f59e0b':undefined}} placeholder="123456789012"
                onFocus={e=>e.target.style.borderColor=c.accent} onBlur={e=>e.target.style.borderColor=isAccountIdPlaceholder?'#f59e0b':c.bd} />
              {isAccountIdPlaceholder && (
                <div style={{marginTop:6,padding:'6px 10px',background:'#451a03',border:'1px solid #f59e0b',borderRadius:6,fontSize:11,color:'#fbbf24',display:'flex',gap:6,alignItems:'flex-start'}}>
                  <span style={{flexShrink:0}}>⚠️</span>
                  <span><strong>Replace this placeholder</strong> before using the generated <code>iam-policy.json</code>. Leaving it as <code>ACCOUNT_ID</code> will produce a silently malformed IAM policy that grants no DynamoDB permissions.</span>
                </div>
              )}
            </div>

            <div>
              <label style={S.label}>Primary Region</label>
              <select value={form.aws_region} onChange={e=>set('aws_region',e.target.value)} style={S.inp()}>
                {REGIONS.map(r=><option key={r}>{r}</option>)}
              </select>
            </div>

            <div>
              <label style={S.label}>Environments (workspaces)</label>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {ENVS.map(env=>{
                  const on = form.environments.includes(env);
                  return <button key={env} onClick={()=>set('environments',on?form.environments.filter(e=>e!==env):[...form.environments,env])}
                    style={{padding:'5px 12px',borderRadius:20,fontSize:11,fontWeight:600,cursor:'pointer',border:`1px solid ${on?c.accent:c.bd}`,background:on?c.accent+'18':'transparent',color:on?c.accent:c.fg3}}>{env}</button>;
                })}
              </div>
            </div>

            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {[['enable_encryption','Enable S3 Encryption (AES-256)'],['enable_versioning','Enable S3 Versioning (rollback support)']].map(([k,lbl])=>(
                <label key={k} style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer'}}>
                  <div onClick={()=>set(k,!form[k])} style={{width:38,height:22,borderRadius:11,background:form[k]?'#00D4A1':'#1A2234',border:`1px solid ${form[k]?'#00D4A1':c.bd}`,position:'relative',cursor:'pointer',transition:'all .2s',flexShrink:0}}>
                    <div style={{position:'absolute',top:2,left:form[k]?18:2,width:16,height:16,borderRadius:'50%',background:'white',transition:'left .2s'}} />
                  </div>
                  <span style={{fontSize:12,color:c.fg2}}>{lbl}</span>
                </label>
              ))}
            </div>

            <button onClick={generate} disabled={loading||!form.project_name}
              style={{padding:'12px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#00D4A1,#0098FF)',color:'#001A0F',fontWeight:800,fontSize:14,cursor:loading?'wait':'pointer',opacity:!form.project_name?.5:1,marginTop:'auto'}}>
              {loading?'⏳ Generating…':'⚡ Generate Backend Config'}
            </button>
          </div>

          {/* Right: Generated files */}
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            {!files?(
              <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16,color:c.fg3}}>
                <div style={{fontSize:52,opacity:.3}}>☁</div>
                <div style={{fontSize:14,fontWeight:700,color:c.fg}}>Configure & generate to preview files</div>
                <div style={{fontSize:12,maxWidth:320,textAlign:'center',lineHeight:1.6}}>Fill in your project details on the left and click Generate. You'll get 4 ready-to-use files.</div>
              </div>
            ):(
              <>
                {/* Placeholder warnings from API */}
                {apiWarnings.length > 0 && (
                  <div style={{padding:"8px 14px",background:"#451a03",borderBottom:"1px solid #f59e0b"}}>
                    {apiWarnings.map((w,i) => (
                      <div key={i} style={{fontSize:11,color:"#fbbf24",display:"flex",gap:6,alignItems:"flex-start"}}>
                        <span style={{flexShrink:0}}>⚠️</span><span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* File tabs */}
                <div style={{display:'flex',gap:0,borderBottom:`1px solid ${c.bd}`,background:c.bg2,flexShrink:0,overflowX:'auto'}}>
                  {Object.keys(files).map(name=>(
                    <button key={name} onClick={()=>setActiveFile(name)}
                      style={{padding:'10px 14px',fontSize:11,fontWeight:600,border:'none',cursor:'pointer',background:'transparent',color:activeFile===name?c.accent:c.fg3,borderBottom:`2px solid ${activeFile===name?c.accent:'transparent'}`,whiteSpace:'nowrap',fontFamily:'JetBrains Mono,monospace'}}>
                      {(FILE_INFO[name]?.icon||'📄')} {name}
                    </button>
                  ))}
                  <div style={{flex:1}} />
                  <button onClick={downloadAll} style={{...S.btn('accent'),padding:'8px 14px',margin:'5px 8px',fontSize:11}}>↓ Download All</button>
                </div>

                {/* File info bar */}
                {activeFile&&FILE_INFO[activeFile]&&(
                  <div style={{padding:'8px 16px',background:'rgba(0,212,161,.05)',borderBottom:`1px solid rgba(0,212,161,.1)`,display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
                    <span style={{fontSize:14}}>{FILE_INFO[activeFile].icon}</span>
                    <span style={{fontSize:12,color:c.fg2,flex:1}}>{FILE_INFO[activeFile].desc}</span>
                    <button onClick={()=>copy(activeFile)} style={{padding:'4px 12px',borderRadius:6,border:`1px solid ${c.bd}`,background:'transparent',color:c.fg3,fontSize:11,cursor:'pointer'}}>
                      {copied===activeFile?'✓ Copied':'📋 Copy'}
                    </button>
                  </div>
                )}

                {/* File content */}
                <pre style={{flex:1,overflow:'auto',margin:0,padding:'16px 20px',fontFamily:'JetBrains Mono,monospace',fontSize:12,lineHeight:1.7,color:c.fg2,background:c.bg}}>
                  {files[activeFile]||''}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
