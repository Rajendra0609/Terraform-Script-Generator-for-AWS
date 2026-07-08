/**
 * MultiResourcePanel — Advanced multi-item editors for:
 *   • Subnets (VPC)
 *   • EC2 Instances (multi)
 *   • Security Group Rules (inbound + outbound)
 */
import React, { useState, useEffect } from 'react';
import { awsAPI } from '../api/client';

// --- Shared helpers -----------------------------------------------------------
const uid = () => Math.random().toString(36).slice(2, 8);

const inputSt = (c) => ({
  background: c.inputBg, border: `1px solid ${c.bd}`, borderRadius: 5,
  color: c.fg, padding: '5px 8px', fontSize: 12,
  fontFamily: 'JetBrains Mono, monospace', outline: 'none',
  width: '100%', boxSizing: 'border-box', transition: 'border-color 0.15s',
});

const selectSt = (c) => ({
  ...inputSt(c), cursor: 'pointer', appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A8BA8' stroke-width='1.5' fill='none'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', paddingRight: 24,
});

function SectionHeader({ title, count, onAdd, addLabel, c }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: c.fg2, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {title} <span style={{ fontWeight: 400, color: c.fg3 }}>({count})</span>
      </span>
      <button onClick={onAdd}
        style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, background: c.accent + '1A', color: c.accent, border: `1px solid ${c.accent}44`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
        + {addLabel}
      </button>
    </div>
  );
}

function EmptySlate({ message, c }) {
  return (
    <div style={{ padding: '12px 14px', background: c.bg3, border: `1px dashed ${c.bd}`, borderRadius: 7, fontSize: 12, color: c.fg3, textAlign: 'center' }}>
      {message}
    </div>
  );
}

function FocusInput({ value, onChange, placeholder, style, c }) {
  return (
    <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      style={style || inputSt(c)}
      onFocus={e => { e.target.style.borderColor = c.accent; e.target.style.boxShadow = `0 0 0 2px ${c.accent}20`; }}
      onBlur={e => { e.target.style.borderColor = c.bd; e.target.style.boxShadow = 'none'; }}
    />
  );
}

// --- SUBNET LIST -------------------------------------------------------------
function SubnetList({ items, onChange, region, c, allResources, vpcId }) {
  const [azs, setAzs] = useState([]);
  const [azSrc, setAzSrc] = useState('');

  useEffect(() => {
    let mounted = true;
    awsAPI.availabilityZones(region || 'ap-south-1')
      .then(r => { if (!mounted) return; setAzs(r.data?.zones || []); setAzSrc(r.data?.source || 'curated'); })
      .catch(() => {});
    return () => { mounted = false; };
  }, [region]);

  // Smart subnet factory — auto-fills every field from available context so
  // clicking "+ Public Subnet" or "+ Private Subnet" produces a ready-to-use
  // entry instead of a blank form.
  //
  // Auto-fill logic:
  //   az        → cycles through loaded AZs (index = total items so far)
  //   cidr      → 10.0.{total}.0/24  (unique per position in the list)
  //   name      → "{type}-subnet-{n+1}" where n = existing subnets of that type
  //   map_public_ip → true for public, false for private
  const makeSubnet = (type = 'public') => {
    const total     = items.length;
    const typeCount = items.filter(s => s.type === type).length;
    return {
      id:           uid(),
      type,
      name:         `${type}-subnet-${typeCount + 1}`,
      cidr:         `10.0.${total}.0/24`,
      az:           azs.length ? azs[total % azs.length] : '',
      map_public_ip: type === 'public',
      tags:         '',
    };
  };

  const add       = ()          => onChange([...items, makeSubnet('public')]);
  const remove    = (idx)       => onChange(items.filter((_, i) => i !== idx));
  const update    = (idx, k, v) => onChange(items.map((s, i) => i === idx ? { ...s, [k]: v } : s));
  const duplicate = (idx)       => onChange([...items.slice(0, idx + 1), { ...items[idx], id: uid(), name: items[idx].name + '-copy' }, ...items.slice(idx + 1)]);

  const publicCount = items.filter(s => s.type === 'public').length;
  const privateCount = items.filter(s => s.type === 'private').length;

  return (
    <div>
      <SectionHeader title="Subnets" count={items.length} onAdd={add} addLabel="Add Subnet" c={c} />

      {/* Parent VPC display + auto-fill preview */}
      {vpcId && (() => {
        // Resolve a human-readable VPC name for display
        let vpcName = vpcId;
        try {
          if (allResources && typeof vpcId === 'string') {
            const m = vpcId.match(/aws_vpc\.([A-Za-z0-9_-]+)\.id/);
            if (m && m[1]) {
              const found = allResources.find(r => r.service_type === 'vpc' && (r.config?.name === m[1] || r.label === m[1]));
              if (found) vpcName = found.config?.name || found.label || vpcId;
            }
          }
        } catch (_) {}
        const nextAz   = azs.length ? azs[items.length % azs.length] : '—';
        const nextCidr = `10.0.${items.length}.0/24`;
        return (
          <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 6, background: c.bg3, border: `1px solid ${c.bd}`, fontSize: 11, color: c.fg3 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span><strong style={{ color: c.fg }}>VPC:</strong> {vpcName}</span>
              <span><strong style={{ color: c.fg }}>Next AZ:</strong> {nextAz}</span>
              <span><strong style={{ color: c.fg }}>Next CIDR:</strong> {nextCidr}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 10, color: c.fg3 }}>
              These values are auto-filled when you click + Public Subnet or + Private Subnet — edit them after if needed.
            </div>
          </div>
        );
      })()}

      {/* Bug-017/018 fix: clarify that "public" vs "private" is a routing
          convention controlled by Route Tables, not an AWS-level subnet flag.
          A subnet becomes public when its associated Route Table has a 0.0.0.0/0
          route via an Internet Gateway (IGW); private subnets route outbound
          traffic through a NAT Gateway instead. The TYPE selector below is a
          convenience label used to pre-set map_public_ip_on_launch and name
          suggestions — the actual public/private behaviour is determined by your
          Route Table associations in AWS. */}
      <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 6, background: '#EFF6FF', border: '1px solid #BFDBFE', fontSize: 11, color: '#1E40AF', lineHeight: 1.5 }}>
        💡 <strong>Public vs Private is a routing concept.</strong> A subnet is
        effectively <em>public</em> when its Route Table routes <code>0.0.0.0/0</code> through an{' '}
        <strong>Internet Gateway (IGW)</strong>. It is <em>private</em> when it routes outbound
        traffic through a <strong>NAT Gateway</strong>. The TYPE field below sets{' '}
        <code>map_public_ip_on_launch</code> and naming defaults — adjust Route Tables in your
        VPC config to control actual internet accessibility.
      </div>

      {azSrc === 'aws' && <div style={{ marginBottom: 6, fontSize: 10.5, color: '#4ade80' }}>🟢 Live AZs from AWS API</div>}
      {azSrc === 'curated' && <div style={{ marginBottom: 6, fontSize: 10.5, color: c.fg3 }}>📋 Curated AZs — connect AWS creds for live data</div>}

      {/* Quick-add bar — each button calls makeSubnet(type) which auto-fills
          az, cidr, name, and map_public_ip from current context so users get
          a ready-to-use subnet instead of an empty form. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {[{ label: '+ Public', type: 'public' }, { label: '+ Private', type: 'private' }].map(q => (
          <button key={q.type} onClick={() => onChange([...items, makeSubnet(q.type)])}
            style={{ flex: 1, padding: '4px 0', fontSize: 11, fontWeight: 600, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${q.type === 'public' ? '#38BDF844' : '#818CF844'}`, background: q.type === 'public' ? '#38BDF810' : '#818CF810', color: q.type === 'public' ? '#38BDF8' : '#818CF8' }}>
            {q.label} Subnet
          </button>
        ))}
      </div>

      {items.length === 0 && <EmptySlate message="No subnets defined — click + Add Subnet to begin" c={c} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((s, i) => {
          const isPublic = s.type === 'public';
          const accentColor = isPublic ? '#38BDF8' : '#818CF8';
          return (
            <div key={s.id} style={{ background: c.bg3, border: `1px solid ${accentColor}28`, borderRadius: 8, overflow: 'hidden' }}>
              {/* Header bar */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', background: accentColor + '0E', borderBottom: `1px solid ${accentColor}20` }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: accentColor, flex: 1 }}>
                  {isPublic ? '🌐' : '🔒'} {isPublic ? 'PUBLIC' : 'PRIVATE'} SUBNET #{i + 1}
                  {s.name && <span style={{ color: c.fg3, fontWeight: 400 }}> — {s.name}</span>}
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => duplicate(i)} title="Duplicate"
                    style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
                    onMouseEnter={e => e.currentTarget.style.color = c.accent}
                    onMouseLeave={e => e.currentTarget.style.color = c.fg3}>⎘</button>
                  <button onClick={() => remove(i)} title="Remove"
                    style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 15, padding: '0 4px', lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                    onMouseLeave={e => e.currentTarget.style.color = c.fg3}>×</button>
                </div>
              </div>

              <div style={{ padding: '10px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {/* Type */}
                <div>
                  <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>TYPE</label>
                  <select value={s.type} onChange={e => update(i, 'type', e.target.value)} style={selectSt(c)}>
                    <option value="public">public</option>
                    <option value="private">private</option>
                  </select>
                </div>
                {/* AZ */}
                <div>
                  <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>AVAILABILITY ZONE</label>
                  <select value={s.az} onChange={e => update(i, 'az', e.target.value)} style={selectSt(c)}>
                    <option value="">— select AZ —</option>
                    {azs.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                {/* CIDR */}
                <div>
                  <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>CIDR BLOCK</label>
                  <FocusInput value={s.cidr} onChange={v => update(i, 'cidr', v)} placeholder={`10.0.${i}.0/24`} c={c} />
                </div>
                {/* Name */}
                <div>
                  <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>NAME TAG</label>
                  <FocusInput value={s.name} onChange={v => update(i, 'name', v)} placeholder={`${s.type}-subnet-${i + 1}`} c={c} />
                </div>
                {/* Map public IP */}
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 11, color: c.fg3, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!s.map_public_ip} onChange={e => update(i, 'map_public_ip', e.target.checked)}
                      style={{ accentColor: accentColor, width: 13, height: 13 }} />
                    map_public_ip_on_launch
                  </label>
                  {!isPublic && <span style={{ fontSize: 10, color: c.fg3, marginLeft: 4 }}>(recommended: off for private subnets)</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 8, padding: '7px 10px', background: c.bg2, borderRadius: 6, fontSize: 10.5, color: c.fg3, fontFamily: 'JetBrains Mono, monospace', display: 'flex', gap: 16 }}>
          <span>🌐 {publicCount} public</span>
          <span>🔒 {privateCount} private</span>
          <span style={{ marginLeft: 'auto' }}>{items.length} aws_subnet resources</span>
        </div>
      )}
    </div>
  );
}

// --- EC2 INSTANCE LIST --------------------------------------------------------
const DEFAULT_EC2 = () => ({
  id: uid(), name: '', instance_type: 't3.micro', ami_id: '',
  subnet_ref: '', key_name: '', associate_public_ip: false,
  root_volume_size: 20, root_volume_type: 'gp3', monitoring: false,
  user_data: '', tags: '',
});

const VOLUME_TYPES = ['gp3', 'gp2', 'io1', 'io2', 'st1', 'sc1'];

function Ec2InstanceList({ items, onChange, region, c, allResources, vpcId }) {
  const [instanceTypes, setInstanceTypes] = useState([]);
  const [itSrc, setItSrc] = useState('');
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let mounted = true;
    awsAPI.instanceTypes(region || 'ap-south-1')
      .then(r => { if (!mounted) return; setInstanceTypes(r.data?.instance_types || []); setItSrc(r.data?.source || 'curated'); })
      .catch(() => {});
    return () => { mounted = false; };
  }, [region]);

  const add = () => { const newItem = DEFAULT_EC2(); onChange([...items, newItem]); setExpanded(e => ({ ...e, [newItem.id]: true })); };
  const remove = (idx) => onChange(items.filter((_, i) => i !== idx));
  const update = (idx, key, val) => onChange(items.map((inst, i) => i === idx ? { ...inst, [key]: val } : inst));
  const toggleExpand = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));
  // Bug-014/015/016 fix: allow duplicating an existing EC2 instance so users
  // can quickly create multiple instances sharing the same base configuration
  // (AMI, instance type, subnet, key pair, etc.). Each copy gets a new unique
  // id and a "-copy" suffix on the name so Terraform resource names stay
  // distinct. VPC-scoped fields (subnet_ref) are intentionally preserved so
  // all copies land in the same network by default.
  const duplicate = (idx) => {
    const src = items[idx];
    const copy = {
      ...src,
      id:   uid(),
      name: src.name ? `${src.name}-copy` : `instance-${items.length + 1}`,
    };
    const next = [...items.slice(0, idx + 1), copy, ...items.slice(idx + 1)];
    onChange(next);
    setExpanded(e => ({ ...e, [copy.id]: true }));
  };

  const iTypes = instanceTypes.length ? instanceTypes : ['t3.nano', 't3.micro', 't3.small', 't3.medium', 't3.large', 't3.xlarge', 't3.2xlarge', 'm5.large', 'm5.xlarge', 'c5.large', 'c5.xlarge', 'r5.large'];

  // Prepare subnet list — combine standalone subnet resources AND subnets
  // embedded inside VPC resources (stored as vpc.config.subnets_multi).
  // Bug-013 fix: VPC-embedded subnets were previously invisible to the EC2
  // subnet picker because they are not top-level resources.
  const standAloneSubnets = Array.isArray(allResources)
    ? allResources.filter(r => r.service_type === 'subnet')
    : [];

  // Lift subnets from every VPC's subnets_multi into a normalised shape that
  // matches a standalone subnet resource so the picker can treat them uniformly.
  const embeddedSubnets = [];
  if (Array.isArray(allResources)) {
    for (const r of allResources) {
      if (r.service_type !== 'vpc') continue;
      const multi = r.config?.subnets_multi;
      if (!Array.isArray(multi)) continue;
      const vpcRef = r.config?.name ? `aws_vpc.${r.config.name}.id` : r._id;
      for (const s of multi) {
        embeddedSubnets.push({
          _id: s.id || `${r._id}-${s.name || s.cidr}`,
          service_type: 'subnet',
          label: s.name || s.cidr || 'unnamed-subnet',
          config: {
            name:                    s.name   || '',
            cidr_block:              s.cidr   || '',
            availability_zone:       s.az     || '',
            vpc_id:                  vpcRef,
            // Bug-017/018 fix: carry the explicit type chosen in SubnetList so
            // the EC2 dropdown shows the correct label without falling back to
            // unreliable name-based heuristics.
            type:                    s.type   || 'public',
            map_public_ip_on_launch: s.map_public_ip !== false,
          },
          _fromVpc: r._id,
        });
      }
    }
  }

  const allSubnets = [...standAloneSubnets, ...embeddedSubnets];

  let filteredSubnets = allSubnets;
  if (vpcId) {
    try {
      const m = typeof vpcId === 'string' && vpcId.match(/aws_vpc\.([A-Za-z0-9_-]+)\.id/);
      if (m && m[1]) {
        filteredSubnets = allSubnets.filter(s => {
          const svcVpc = s.config?.vpc_id;
          if (!svcVpc) return false;
          if (svcVpc === vpcId) return true;
          return String(svcVpc).includes(m[1]);
        });
      } else {
        filteredSubnets = allSubnets.filter(s => s.config?.vpc_id === vpcId || s.config?.vpc_id === `aws_vpc.${vpcId}.id`);
      }
    } catch (_) { /* ignore */ }
  }

  return (
    <div>
      <SectionHeader title="EC2 Instances" count={items.length} onAdd={add} addLabel="Add Instance" c={c} />

      {itSrc === 'aws' && <div style={{ marginBottom: 6, fontSize: 10.5, color: '#4ade80' }}>🟢 Live instance types from AWS API</div>}

      {/* Bug-013 fix: warn when no subnets exist at all — a subnet (inside a VPC
          with an Availability Zone and CIDR) is a prerequisite for EC2 launch. */}
      {allSubnets.length === 0 && (
        <div style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 8,
          background: '#FEF3C7', border: '1px solid #F59E0B',
          fontSize: 12, color: '#92400E', lineHeight: 1.6,
        }}>
          <strong>⚠ No subnets found.</strong> A subnet is required before you can launch
          an EC2 instance inside a VPC. To fix this:
          <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
            <li>Add a <strong>VPC</strong> resource and configure its CIDR block.</li>
            <li>Inside the VPC config, use the <em>Subnets</em> section to add at least
                one subnet — specify an <strong>Availability Zone</strong> and a
                <strong> CIDR block</strong> (e.g. <code>10.0.1.0/24</code>).</li>
            <li>Return here and select that subnet from the dropdown below.</li>
          </ol>
          <div style={{ marginTop: 6, fontSize: 11, color: '#B45309' }}>
            💡 Subnets labelled <em>Public</em> route traffic through an Internet Gateway;
            subnets labelled <em>Private</em> use a NAT Gateway for outbound-only access.
            This distinction is set via <strong>Route Tables</strong>, not the subnet
            resource itself.
          </div>
        </div>
      )}

      {items.length === 0 && <EmptySlate message="No EC2 instances defined — click + Add Instance to begin" c={c} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((inst, i) => {
          const isOpen = expanded[inst.id] !== false; // default open
          return (
            <div key={inst.id} style={{ background: c.bg3, border: `1px solid ${c.bd2}`, borderRadius: 8, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', background: c.accent + '0A', borderBottom: isOpen ? `1px solid ${c.bd}` : 'none', cursor: 'pointer' }}
                onClick={() => toggleExpand(inst.id)}>
                <span style={{ fontSize: 10, fontWeight: 700, color: c.accent, flex: 1 }}>
                  🖥 INSTANCE #{i + 1}{inst.name ? ` — ${inst.name}` : ''}
                  <span style={{ marginLeft: 8, fontSize: 10, color: c.fg3, fontWeight: 400, fontFamily: 'JetBrains Mono, monospace' }}>{inst.instance_type}</span>
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: c.fg3 }}>{isOpen ? '▲' : '▼'}</span>
                  {/* Bug-014/015/016: Duplicate button mirrors the subnet pattern. Each
                      copy gets a unique id so Terraform generates separate resource
                      blocks while sharing VPC ID, subnet, AMI and other fields. */}
                  <button onClick={e => { e.stopPropagation(); duplicate(i); }} title="Duplicate instance"
                    style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 13, padding: '0 4px', lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = c.accent}
                    onMouseLeave={e => e.currentTarget.style.color = c.fg3}>⎘</button>
                  <button onClick={e => { e.stopPropagation(); remove(i); }} title="Remove"
                    style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 15, padding: '0 4px', lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                    onMouseLeave={e => e.currentTarget.style.color = c.fg3}>×</button>
                </div>
              </div>

              {isOpen && (
                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {/* Name */}
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>NAME</label>
                      <FocusInput value={inst.name} onChange={v => update(i, 'name', v)} placeholder={`web-server-${i + 1}`} c={c} />
                    </div>
                    {/* Instance type */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>INSTANCE TYPE</label>
                      <select value={inst.instance_type} onChange={e => update(i, 'instance_type', e.target.value)} style={selectSt(c)}>
                        {iTypes.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {/* AMI */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>AMI ID</label>
                      <FocusInput value={inst.ami_id} onChange={v => update(i, 'ami_id', v)} placeholder="ami-0xxxxxxxxxxxxxxxx" c={c} />
                    </div>
                    {/* Subnet ref */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>SUBNET REF</label>
                      {filteredSubnets.length > 0 ? (
                        <select value={inst.subnet_ref} onChange={e => update(i, 'subnet_ref', e.target.value)} style={selectSt(c)}>
                          <option value="">— select subnet —</option>
                          {filteredSubnets.map(s => {
                            // Bug-017/018 fix: resolve public/private label with a clear
                            // priority so the dropdown is always accurate.
                            // 1) Explicit `type` field set by SubnetList (most reliable).
                            // 2) `map_public_ip_on_launch` boolean from standalone subnets.
                            // 3) Name-based heuristic as last resort.
                            // Clarification: "public" / "private" is a routing convention
                            // (Internet Gateway vs NAT Gateway in the Route Table) — it is
                            // NOT an intrinsic AWS attribute of the subnet resource itself.
                            let type = 'unknown';
                            if (s.config?.type === 'public' || s.config?.type === 'private') {
                              type = s.config.type;
                            } else {
                              const mp = s.config?.map_public_ip_on_launch ?? s.config?.map_public_ip;
                              if (mp !== undefined) {
                                const mpStr = String(mp);
                                if (mpStr === 'true'  || mpStr === 'True'  || mpStr === '1') type = 'public';
                                if (mpStr === 'false' || mpStr === 'False' || mpStr === '0') type = 'private';
                              }
                              if (type === 'unknown') {
                                const nameLower = String(s.config?.name || s.label || '').toLowerCase();
                                if (nameLower.includes('public'))  type = 'public';
                                if (nameLower.includes('private')) type = 'private';
                              }
                            }
                            const typeLabel = type === 'public'  ? ' (public)'
                                            : type === 'private' ? ' (private)'
                                            : '';
                            const display = `${s.config?.name || s.label || s._id}${typeLabel}`;
                            const value   = s.config?.name ? `aws_subnet.${s.config.name}.id` : s._id;
                            return <option key={s._id} value={value}>{display}</option>;
                          })}
                        </select>
                      ) : (
                        <FocusInput value={inst.subnet_ref} onChange={v => update(i, 'subnet_ref', v)} placeholder="aws_subnet.public_0.id" c={c} />
                      )}
                      {/* Bug-017/018: clarify that public/private is a route-table
                          concept so users know where to change it. */}
                      <div style={{ marginTop: 4, fontSize: 10, color: c.fg3, lineHeight: 1.4 }}>
                        Public/private routing is set via the subnet's <em>Route Table</em> (IGW = public, NAT-GW = private), not the subnet resource itself.
                      </div>
                    </div>
                    {/* Key pair */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>KEY PAIR</label>
                      <FocusInput value={inst.key_name} onChange={v => update(i, 'key_name', v)} placeholder="my-key-pair" c={c} />
                    </div>
                    {/* Root volume size */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>ROOT VOL SIZE (GB)</label>
                      <input type="number" value={inst.root_volume_size} min={8} max={16384}
                        onChange={e => update(i, 'root_volume_size', e.target.value)} style={inputSt(c)}
                        onFocus={e => { e.target.style.borderColor = c.accent; }}
                        onBlur={e => { e.target.style.borderColor = c.bd; }} />
                    </div>
                    {/* Root volume type */}
                    <div>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>VOL TYPE</label>
                      <select value={inst.root_volume_type} onChange={e => update(i, 'root_volume_type', e.target.value)} style={selectSt(c)}>
                        {VOLUME_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {/* User data */}
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>USER DATA (base64 or raw script)</label>
                      <textarea value={inst.user_data} onChange={e => update(i, 'user_data', e.target.value)}
                        placeholder="#!/bin/bash&#10;yum update -y"
                        rows={3}
                        style={{ ...inputSt(c), resize: 'vertical', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
                        onFocus={e => { e.target.style.borderColor = c.accent; }}
                        onBlur={e => { e.target.style.borderColor = c.bd; }} />
                    </div>
                    {/* Flags */}
                    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 20 }}>
                      <label style={{ fontSize: 11, color: c.fg3, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!inst.associate_public_ip} onChange={e => update(i, 'associate_public_ip', e.target.checked)}
                          style={{ accentColor: c.accent, width: 13, height: 13 }} />
                        associate_public_ip_address
                      </label>
                      <label style={{ fontSize: 11, color: c.fg3, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!inst.monitoring} onChange={e => update(i, 'monitoring', e.target.checked)}
                          style={{ accentColor: c.accent, width: 13, height: 13 }} />
                        detailed_monitoring
                      </label>
                    </div>
                  </div>

                  {/* HCL preview hint */}
                  <div style={{ padding: '5px 8px', background: c.bg2, borderRadius: 5, fontSize: 10.5, color: c.fg3, fontFamily: 'JetBrains Mono, monospace' }}>
                    resource "aws_instance" "{inst.name || `instance_${i + 1}`}" {'{ ... }'}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {items.length > 1 && (
        <div style={{ marginTop: 8, padding: '7px 10px', background: c.bg2, borderRadius: 6, fontSize: 10.5, color: c.fg3 }}>
          {items.length} instances → {items.length} separate <code style={{ color: c.accent, fontFamily: 'JetBrains Mono, monospace' }}>aws_instance</code> resource blocks
        </div>
      )}
    </div>
  );
}

// --- SECURITY GROUP RULES -----------------------------------------------------
const PROTOCOL_PRESETS = [
  { label: 'HTTP',        protocol: 'tcp', from: 80,   to: 80,    cidr: '0.0.0.0/0', desc: 'HTTP traffic' },
  { label: 'HTTPS',       protocol: 'tcp', from: 443,  to: 443,   cidr: '0.0.0.0/0', desc: 'HTTPS traffic' },
  { label: 'SSH',         protocol: 'tcp', from: 22,   to: 22,    cidr: '0.0.0.0/0', desc: 'SSH access' },
  { label: 'RDP',         protocol: 'tcp', from: 3389, to: 3389,  cidr: '0.0.0.0/0', desc: 'RDP access' },
  { label: 'MySQL',       protocol: 'tcp', from: 3306, to: 3306,  cidr: '10.0.0.0/8', desc: 'MySQL/Aurora' },
  { label: 'PostgreSQL',  protocol: 'tcp', from: 5432, to: 5432,  cidr: '10.0.0.0/8', desc: 'PostgreSQL' },
  { label: 'Redis',       protocol: 'tcp', from: 6379, to: 6379,  cidr: '10.0.0.0/8', desc: 'Redis' },
  { label: 'All Traffic', protocol: '-1',  from: 0,    to: 0,     cidr: '0.0.0.0/0', desc: 'All traffic' },
];

const DEFAULT_RULE = (dir) => ({
  id: uid(),
  direction: dir,
  protocol: 'tcp',
  from_port: '',
  to_port: '',
  cidr_blocks: '0.0.0.0/0',
  source_sg: '',
  description: '',
  ipv6_cidr: '',
});

const PROTOCOLS = [
  { value: 'tcp',  label: 'TCP' },
  { value: 'udp',  label: 'UDP' },
  { value: 'icmp', label: 'ICMP' },
  { value: '-1',   label: 'All (-1)' },
];

function SGRuleRow({ rule, idx, onUpdate, onRemove, c }) {
  const isAllTraffic = rule.protocol === '-1';
  return (
    <div style={{ background: c.bg3, border: `1px solid ${rule.direction === 'ingress' ? '#38BDF820' : '#F8717120'}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: rule.direction === 'ingress' ? '#38BDF8' : '#F87171' }}>
          {rule.direction === 'ingress' ? '← INBOUND' : '→ OUTBOUND'} RULE #{idx + 1}
        </span>
        <button onClick={onRemove}
          style={{ background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 15, padding: '0 4px', lineHeight: 1 }}
          onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
          onMouseLeave={e => e.currentTarget.style.color = c.fg3}>×</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7 }}>
        {/* Protocol */}
        <div>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>PROTOCOL</label>
          <select value={rule.protocol} onChange={e => onUpdate('protocol', e.target.value)} style={selectSt(c)}>
            {PROTOCOLS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {/* From port */}
        <div>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>FROM PORT</label>
          <input type="number" value={isAllTraffic ? '0' : rule.from_port} disabled={isAllTraffic}
            onChange={e => onUpdate('from_port', e.target.value)}
            placeholder="80" min={0} max={65535}
            style={{ ...inputSt(c), opacity: isAllTraffic ? 0.4 : 1 }}
            onFocus={e => { e.target.style.borderColor = c.accent; }}
            onBlur={e => { e.target.style.borderColor = c.bd; }} />
        </div>
        {/* To port */}
        <div>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>TO PORT</label>
          <input type="number" value={isAllTraffic ? '0' : rule.to_port} disabled={isAllTraffic}
            onChange={e => onUpdate('to_port', e.target.value)}
            placeholder="80" min={0} max={65535}
            style={{ ...inputSt(c), opacity: isAllTraffic ? 0.4 : 1 }}
            onFocus={e => { e.target.style.borderColor = c.accent; }}
            onBlur={e => { e.target.style.borderColor = c.bd; }} />
        </div>
        {/* CIDR */}
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>CIDR BLOCKS <span style={{ fontWeight: 400 }}>(comma-separated, e.g. 10.0.0.0/8, 0.0.0.0/0)</span></label>
          <FocusInput value={rule.cidr_blocks} onChange={v => onUpdate('cidr_blocks', v)} placeholder="0.0.0.0/0" c={c} />
        </div>
        {/* Source SG */}
        <div style={{ gridColumn: '1 / 3' }}>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>SOURCE SG <span style={{ fontWeight: 400 }}>(optional — overrides CIDR)</span></label>
          <FocusInput value={rule.source_sg} onChange={v => onUpdate('source_sg', v)} placeholder="aws_security_group.web.id" c={c} />
        </div>
        {/* IPv6 */}
        <div>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>IPv6 CIDR</label>
          <FocusInput value={rule.ipv6_cidr} onChange={v => onUpdate('ipv6_cidr', v)} placeholder="::/0" c={c} />
        </div>
        {/* Description */}
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{ fontSize: 10, color: c.fg3, fontWeight: 600, display: 'block', marginBottom: 3 }}>DESCRIPTION</label>
          <FocusInput value={rule.description} onChange={v => onUpdate('description', v)} placeholder="Allow HTTP traffic" c={c} />
        </div>
      </div>
    </div>
  );
}

function SecurityGroupRules({ value, onChange, c }) {
  const rules = Array.isArray(value) ? value : [];
  const [activeTab, setActiveTab] = useState('ingress');

  const addRule = (dir) => onChange([...rules, DEFAULT_RULE(dir)]);
  const removeRule = (id) => onChange(rules.filter(r => r.id !== id));
  const updateRule = (id, key, val) => onChange(rules.map(r => r.id === id ? { ...r, [key]: val } : r));

  const addPreset = (preset, dir) => {
    const rule = { ...DEFAULT_RULE(dir), protocol: preset.protocol, from_port: String(preset.from), to_port: String(preset.to), cidr_blocks: preset.cidr, description: preset.desc };
    onChange([...rules, rule]);
  };

  const inbound = rules.filter(r => r.direction === 'ingress');
  const outbound = rules.filter(r => r.direction === 'egress');
  const currentDir = activeTab;
  const currentRules = activeTab === 'ingress' ? inbound : outbound;
  const tabColor = activeTab === 'ingress' ? '#38BDF8' : '#F87171';

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 10, background: c.bg3, borderRadius: 7, padding: 3, border: `1px solid ${c.bd}` }}>
        {[{ id: 'ingress', label: `← Inbound (${inbound.length})`, color: '#38BDF8' }, { id: 'egress', label: `→ Outbound (${outbound.length})`, color: '#F87171' }].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 700, border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
              background: activeTab === tab.id ? tab.color + '18' : 'transparent',
              color: activeTab === tab.id ? tab.color : c.fg3,
              boxShadow: activeTab === tab.id ? `inset 0 0 0 1px ${tab.color}40` : 'none',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Preset quick-add */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: c.fg3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
          Quick add {activeTab === 'ingress' ? 'inbound' : 'outbound'} rule
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {PROTOCOL_PRESETS.map(p => (
            <button key={p.label} onClick={() => addPreset(p, currentDir)}
              style={{ padding: '3px 8px', fontSize: 10, fontWeight: 600, border: `1px solid ${tabColor}40`, background: tabColor + '10', color: tabColor, borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}
              onMouseEnter={e => e.currentTarget.style.background = tabColor + '22'}
              onMouseLeave={e => e.currentTarget.style.background = tabColor + '10'}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Add button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button onClick={() => addRule(currentDir)}
          style={{ padding: '4px 12px', fontSize: 11, fontWeight: 700, background: tabColor + '15', color: tabColor, border: `1px solid ${tabColor}44`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
          + Add {activeTab === 'ingress' ? 'Inbound' : 'Outbound'} Rule
        </button>
      </div>

      {currentRules.length === 0 && (
        <EmptySlate message={`No ${activeTab === 'ingress' ? 'inbound' : 'outbound'} rules — use presets above or click + Add`} c={c} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {currentRules.map((rule, idx) => (
          <SGRuleRow key={rule.id} rule={rule} idx={idx} c={c}
            onUpdate={(key, val) => updateRule(rule.id, key, val)}
            onRemove={() => removeRule(rule.id)} />
        ))}
      </div>

      {rules.length > 0 && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: c.bg2, borderRadius: 6, fontSize: 10.5, color: c.fg3, fontFamily: 'JetBrains Mono, monospace', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ color: '#38BDF8' }}>← {inbound.length} ingress rule{inbound.length !== 1 ? 's' : ''}</span>
          <span style={{ color: '#F87171' }}>→ {outbound.length} egress rule{outbound.length !== 1 ? 's' : ''}</span>
          <span style={{ marginLeft: 'auto' }}>HCL: {rules.length} aws_security_group_rule blocks</span>
        </div>
      )}
    </div>
  );
}

// --- Public export ------------------------------------------------------------
export default function MultiResourcePanel({ type, items, value, onChange, region, c, allResources, vpcId }) {
  if (type === 'subnets') {
    return <SubnetList items={items || []} onChange={onChange} region={region} c={c} allResources={allResources} vpcId={vpcId} />;
  }
  if (type === 'ec2_instances') {
    return <Ec2InstanceList items={items || []} onChange={onChange} region={region} c={c} allResources={allResources} vpcId={vpcId} />;
  }
  if (type === 'sg_rules') {
    return <SecurityGroupRules value={value || []} onChange={onChange} c={c} allResources={allResources} />;
  }
  return null;
}
