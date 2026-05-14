import React, { useState, useEffect } from 'react';
import { generateHCL } from '../engine/templateEngine';
import { awsAPI } from '../api/client';

const fieldStyle = {
  width: '100%', background: '#0D1117', border: '1px solid #30363D',
  borderRadius: 6, color: '#E6EDF3', padding: '8px 12px', fontSize: 13,
  fontFamily: 'JetBrains Mono, monospace', outline: 'none',
  transition: 'border-color 0.15s', boxSizing: 'border-box',
};

// ─── Module Help Content per service ─────────────────────────────────────────
const MODULE_HELP = {
  default: {
    registry: 'https://registry.terraform.io/browse/modules?provider=aws',
    what: 'Terraform modules are reusable, pre-tested infrastructure packages from the official registry.',
    how: [
      'Toggle "Use as Module" ON to switch to the module-based template.',
      'The module block auto-includes the correct source and version pin.',
      'Run terraform init to download the module from the registry.',
      'Module inputs map 1-to-1 with the fields in this panel.',
    ],
    tip: 'Modules are maintained by HashiCorp and the community — they handle edge cases like IAM permissions, security groups, and tagging for you.',
  },
  vpc: {
    source: 'terraform-aws-modules/vpc/aws',
    version: '~> 5.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest',
    what: 'The official VPC module creates a full VPC with public/private subnets, NAT gateways, route tables, and optional VPN/Direct Connect attachments in one call.',
    how: [
      'azs — list of Availability Zones (e.g. ["ap-south-1a","ap-south-1b"]).',
      'private_subnets / public_subnets — CIDR blocks for each AZ.',
      'enable_nat_gateway — creates NAT GWs for private subnet outbound traffic.',
      'single_nat_gateway — use one shared NAT GW to reduce cost in dev.',
      'The module outputs vpc_id, private_subnets, public_subnets for use in other resources.',
    ],
    tip: 'In production always use enable_nat_gateway=true with one NAT per AZ (single_nat_gateway=false). For dev/test, single_nat_gateway=true saves ~$32/month per AZ.',
  },
  ec2: {
    source: 'terraform-aws-modules/ec2-instance/aws',
    version: '~> 5.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/ec2-instance/aws/latest',
    what: 'Creates an EC2 instance with opinionated defaults: encrypted root volume, IMDSv2 enforced, correct IAM instance profile wiring.',
    how: [
      'ami — use the AMI search button to find region-specific IDs.',
      'instance_type — t3.micro is free-tier eligible; t3.medium+ for real workloads.',
      'subnet_id — reference your VPC module output: module.vpc.private_subnets[0].',
      'key_name — must already exist in the target region.',
      'The module outputs instance_id and private_ip for downstream resources.',
    ],
    tip: 'Always launch instances in private subnets behind an ALB. Only the ALB/bastion should have a public IP.',
  },
  alb: {
    source: 'terraform-aws-modules/alb/aws',
    version: '~> 9.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/alb/aws/latest',
    what: 'Creates an Application Load Balancer with listeners, target groups, and security groups. Supports HTTP→HTTPS redirect and WAF attachment.',
    how: [
      'subnets — MUST be public subnets for internet-facing ALBs.',
      'vpc_id — reference module.vpc.vpc_id.',
      'The module exposes target_group_arns for Auto Scaling Group attachment.',
      'Add an HTTPS listener with an ACM certificate for production.',
    ],
    tip: 'Always redirect HTTP → HTTPS in production. Add aws_lb_listener_rule resources to route traffic by path or host headers to different target groups.',
  },
  rds: {
    source: 'terraform-aws-modules/rds/aws',
    version: '~> 6.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/rds/aws/latest',
    what: 'Creates an RDS instance with subnet groups, parameter groups, option groups, and CloudWatch alarms pre-wired.',
    how: [
      'Place DB in private subnets — module.vpc.private_subnets.',
      'Set multi_az=true in production for automatic failover.',
      'Use db_password via Secrets Manager, never hardcode it.',
      'backup_retention_period of at least 7 days is recommended.',
      'The module outputs db_instance_endpoint for application config.',
    ],
    tip: 'Enable storage_encrypted=true and set deletion_protection=true for production databases. Use read replicas for read-heavy workloads.',
  },
  eks: {
    source: 'terraform-aws-modules/eks/aws',
    version: '~> 20.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest',
    what: 'The most popular EKS module — creates the control plane, OIDC provider, managed node groups, and core add-ons (CoreDNS, kube-proxy, VPC-CNI).',
    how: [
      'subnet_ids — private subnets for nodes, public for load balancers.',
      'eks_managed_node_groups — define multiple groups (e.g. general, spot).',
      'cluster_endpoint_public_access — disable in production, use VPN/bastion.',
      'Run: aws eks update-kubeconfig --name <cluster> --region <region> after apply.',
      'The module outputs cluster_endpoint and cluster_certificate_authority_data.',
    ],
    tip: 'Use a mix of ON_DEMAND and SPOT node groups (Karpenter or Cluster Autoscaler) for 60-80% cost savings. Always run nodes in private subnets.',
  },
  ecs_cluster: {
    source: 'terraform-aws-modules/ecs/aws',
    version: '~> 5.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/ecs/aws/latest',
    what: 'Creates an ECS cluster with Fargate and Fargate Spot capacity providers, Container Insights, and optional EC2 capacity.',
    how: [
      'Use FARGATE for production workloads — no node management needed.',
      'Use FARGATE_SPOT for non-critical/batch workloads — up to 70% cheaper.',
      'Define task definitions and services as separate resources.',
      'Connect service to an ALB target group for load balancing.',
    ],
    tip: 'ECS Fargate is simpler than EKS for teams new to containers. Move to EKS when you need advanced scheduling, custom operators, or multi-cluster setups.',
  },
  lambda: {
    source: 'terraform-aws-modules/lambda/aws',
    version: '~> 7.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest',
    what: 'Creates a Lambda function with IAM role, CloudWatch log group, optional VPC config, and Dead Letter Queue wiring.',
    how: [
      'Package your code as a zip and upload to S3, or use create_package=true.',
      'Set timeout to the worst-case execution time (max 900 seconds).',
      'Use environment variables for config; use Secrets Manager for secrets.',
      'Wire to EventBridge/SQS/API Gateway via triggers in this module.',
    ],
    tip: 'Keep Lambda packages small — cold start time scales with package size. Use Lambda Layers for shared dependencies across functions.',
  },
  s3: {
    source: 'terraform-aws-modules/s3-bucket/aws',
    version: '~> 4.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/s3-bucket/aws/latest',
    what: 'Creates an S3 bucket with versioning, encryption, lifecycle rules, access block, and optional CORS/logging pre-configured.',
    how: [
      'Always enable versioning for buckets storing application data.',
      'block_public_acls=true is the secure default — disable only for static sites.',
      'Use lifecycle rules to transition old versions to Glacier.',
      'Output bucket_id and bucket_arn for cross-resource references.',
    ],
    tip: 'Enable S3 Access Logging for audit trails. Use S3 Intelligent-Tiering for buckets with unknown or changing access patterns.',
  },
  dynamodb: {
    source: 'terraform-aws-modules/dynamodb-table/aws',
    version: '~> 4.0',
    registry: 'https://registry.terraform.io/modules/terraform-aws-modules/dynamodb-table/aws/latest',
    what: 'Creates a DynamoDB table with optional GSIs, LSIs, stream config, TTL, PITR, and auto-scaling.',
    how: [
      'Use PAY_PER_REQUEST for unpredictable traffic; PROVISIONED + auto-scaling for steady loads.',
      'Design your partition key carefully — hot partitions cause throttling.',
      'Enable point_in_time_recovery for all production tables.',
      'Use GSIs (Global Secondary Indexes) for alternate query patterns.',
    ],
    tip: 'DynamoDB is best for single-table design patterns. Read "The DynamoDB Book" by Alex DeBrie for advanced patterns like adjacency lists and sparse indexes.',
  },
};

function ModuleHelpPanel({ serviceType }) {
  const help = MODULE_HELP[serviceType] || MODULE_HELP.default;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '9px 12px', background: '#1a1040', border: '1px solid #7B42BC55',
          borderRadius: 8, cursor: 'pointer', color: '#9F6FD0', fontSize: 12, fontWeight: 600,
        }}
      >
        <span>📦 How to use this module</span>
        <span style={{ fontSize: 14 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ background: '#120D28', border: '1px solid #7B42BC33', borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 14, fontSize: 12 }}>

          {/* Source + Version */}
          {help.source && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: '#484F58', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', fontSize: 10, marginBottom: 6 }}>Module Source</div>
              <div style={{ background: '#0D1117', borderRadius: 6, padding: '8px 10px', fontFamily: 'JetBrains Mono, monospace', color: '#A5D6FF', fontSize: 11 }}>
                source  = "{help.source}"<br/>
                version = "{help.version}"
              </div>
            </div>
          )}

          {/* What it does */}
          <div style={{ color: '#8B949E', marginBottom: 12, lineHeight: 1.6 }}>
            {help.what}
          </div>

          {/* How-to steps */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: '#484F58', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', fontSize: 10, marginBottom: 6 }}>Key Inputs</div>
            {help.how.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5 }}>
                <span style={{ color: '#7B42BC', fontWeight: 700, flexShrink: 0 }}>→</span>
                <span style={{ color: '#8B949E', lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
          </div>

          {/* Pro tip */}
          <div style={{ padding: '8px 10px', background: '#1a2510', border: '1px solid #3FB95033', borderRadius: 6 }}>
            <span style={{ color: '#3FB950', fontWeight: 700 }}>💡 Tip: </span>
            <span style={{ color: '#8B949E' }}>{help.tip}</span>
          </div>

          {/* Registry link */}
          <div style={{ marginTop: 10, textAlign: 'right' }}>
            <a href={help.registry || 'https://registry.terraform.io/browse/modules?provider=aws'} target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: '#7B42BC', textDecoration: 'none' }}>
              View on Terraform Registry →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Roadmap context badge per category ──────────────────────────────────────
const ROADMAP_STEP = {
  'Compute':        { step: 'Step 4–5', label: 'EC2, Auto Scaling, ALB', color: '#818CF8' },
  'Storage':        { step: 'Step 5',   label: 'S3, EBS, EFS',           color: '#4ADE80' },
  'Networking':     { step: 'Step 3',   label: 'VPC Deep Dive',           color: '#38BDF8' },
  'Database':       { step: 'Step 6',   label: 'RDS + DynamoDB',          color: '#C084FC' },
  'IAM & Security': { step: 'Step 2',   label: 'IAM — Master First',      color: '#F87171' },
  'Monitoring':     { step: 'Step 7',   label: 'CloudWatch + CloudTrail', color: '#86EFAC' },
  'Containers':     { step: 'Step 10',  label: 'ECS + EKS + ECR',        color: '#22D3EE' },
  'CI/CD':          { step: 'Step 9',   label: 'CodePipeline + Build',    color: '#FCD34D' },
  'Admin & Ops':    { step: 'Step 9–12',label: 'SysOps Path',             color: '#A78BFA' },
};

export default function ConfigPanel({ service, config, onChange, isModule, onToggleModule, region }) {
  if (!service) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, color: '#8B949E', padding: 24 }}>
      <svg width="64" height="64" fill="none" stroke="#30363D" strokeWidth="1.5" viewBox="0 0 24 24">
        <path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V8z"/>
        <polyline points="17 3 17 8 12 8"/><line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/>
      </svg>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#E6EDF3', marginBottom: 6 }}>No Service Selected</div>
        <div style={{ fontSize: 13 }}>Click a service from the left panel to configure it</div>
      </div>
    </div>
  );

  const handleChange = (fieldId, value) => {
    const newConfig = { ...config, [fieldId]: value };
    const templateBody = isModule ? service.module_body : service.template_body;
    const hcl = templateBody ? generateHCL(templateBody, newConfig) : '';
    onChange(newConfig, hcl);
  };

  const canModule = !!service.module_body;
  const roadmap = ROADMAP_STEP[service.category];

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }} className="fade-in">

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#E6EDF3' }}>{service.label}</h2>
            <div style={{ fontSize: 11, color: '#8B949E', marginTop: 3 }}>
              {service.category} · {isModule ? 'Module Mode' : 'Resource Mode'}
            </div>
          </div>
          {canModule && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 12 }}>
              <span style={{ fontSize: 11, color: '#8B949E' }}>Module</span>
              <button onClick={onToggleModule} style={{
                width: 40, height: 22, borderRadius: 11, border: 'none',
                background: isModule ? '#7B42BC' : '#30363D',
                cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: isModule ? 20 : 2,
                  width: 18, height: 18, borderRadius: 9, background: '#fff',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                }}/>
              </button>
            </div>
          )}
        </div>

        {/* Roadmap badge */}
        {roadmap && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: roadmap.color + '14', border: `1px solid ${roadmap.color}33`, borderRadius: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: roadmap.color }}>{roadmap.step}</span>
            <span style={{ fontSize: 10, color: '#8B949E' }}>{roadmap.label}</span>
          </div>
        )}

        {/* Module active banner */}
        {isModule && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#1a1040', border: '1px solid #7B42BC44', borderRadius: 8, fontSize: 12, color: '#9F6FD0' }}>
            Using official Terraform AWS module. Source + version are auto-included in output.
          </div>
        )}
      </div>

      {/* Fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {(service.schema_def || []).map(field => (
          <div key={field.id}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#8B949E', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {field.label} {field.required && <span style={{ color: '#F85149' }}>*</span>}
            </label>
            {field.type === 'select' ? (
              <DynamicSelect field={field} region={region} value={config[field.id] ?? field.default ?? ''} onChange={val => handleChange(field.id, val)} />
            ) : field.type === 'number' ? (
              <input type="number" value={config[field.id] ?? field.default ?? ''}
                onChange={e => handleChange(field.id, e.target.value)}
                style={{ ...fieldStyle }}
                onFocus={e => e.target.style.borderColor = '#7B42BC'}
                onBlur={e => e.target.style.borderColor = '#30363D'}
              />
            ) : field.id === 'ami_id' ? (
              <AmiInput region={region} value={config[field.id] ?? field.default ?? ''} onChange={val => handleChange(field.id, val)} />
            ) : (
              <input type="text" value={config[field.id] ?? field.default ?? ''}
                onChange={e => handleChange(field.id, e.target.value)}
                placeholder={field.placeholder || field.default || ''}
                style={{ ...fieldStyle }}
                onFocus={e => e.target.style.borderColor = '#7B42BC'}
                onBlur={e => e.target.style.borderColor = '#30363D'}
              />
            )}
          </div>
        ))}
      </div>

      {/* Module Help Panel — shown when module mode is ON and module exists */}
      {isModule && canModule && (
        <ModuleHelpPanel serviceType={service.service_type} />
      )}

      {/* Module available hint — shown when NOT in module mode but module exists */}
      {!isModule && canModule && (
        <div style={{ marginTop: 16, padding: '8px 10px', background: '#1a1040', border: '1px solid #7B42BC33', borderRadius: 7, fontSize: 11, color: '#7B42BC66', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>📦</span>
          <span>An official Terraform module is available for this service — toggle <strong style={{ color: '#9F6FD0' }}>Module</strong> to use it.</span>
        </div>
      )}
    </div>
  );
}

// ─── DynamicSelect ────────────────────────────────────────────────────────────
function DynamicSelect({ field, value, onChange, region }) {
  const [opts, setOpts] = useState(field.options || []);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (field.id !== 'instance_type' && field.id !== 'availability_zone') return;
      setLoading(true);
      try {
        const r = field.id === 'availability_zone'
          ? await awsAPI.availabilityZones(region || 'ap-south-1')
          : await awsAPI.instanceTypes(region || 'ap-south-1');
        if (!mounted) return;
        const data = field.id === 'availability_zone'
          ? r.data?.zones || []
          : r.data?.instance_types || [];
        setOpts(Array.from(new Set([...data, ...(field.options || [])])));
      } catch (_) {
        // silently fall back to static list
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [field.id, region]);

  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...fieldStyle }}>
      {loading
        ? <option disabled>Loading…</option>
        : opts.map(opt => <option key={opt} value={opt}>{opt}</option>)
      }
    </select>
  );
}

// ─── AmiInput ─────────────────────────────────────────────────────────────────
function AmiInput({ region, value, onChange }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useState('');

  // Reset when region changes
  useEffect(() => { setQ(''); setList([]); setSource(''); }, [region]);

  // Load curated list whenever the dropdown opens
  useEffect(() => {
    if (!open) return;
    fetchAmis('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, region]);

  async function fetchAmis(term) {
    setSearching(true);
    try {
      const r = await awsAPI.amis(region || 'ap-south-1', term);
      setList(r.data?.images || []);
      setSource(r.data?.source || '');
    } catch (_) {
      setList([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="ami-… or click to search"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        style={{ ...fieldStyle }}
        onMouseEnter={e => e.target.style.borderColor = '#7B42BC'}
        onMouseLeave={e => e.target.style.borderColor = '#30363D'}
      />
      {open && (
        <div style={{
          position: 'absolute', right: 0, left: 0, top: 'calc(100% + 4px)',
          background: '#161B22', border: '1px solid #30363D', borderRadius: 8,
          zIndex: 50, maxHeight: 300, overflow: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          {/* Search bar */}
          <div style={{ padding: 8, display: 'flex', gap: 6, borderBottom: '1px solid #30363D', position: 'sticky', top: 0, background: '#161B22', zIndex: 1 }}>
            <input
              placeholder="Search by name (e.g. ubuntu, amazon linux…)"
              value={q}
              onChange={e => setQ(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fetchAmis(q); } }}
              style={{ ...fieldStyle, margin: 0, flex: 1, fontSize: 12 }}
            />
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => fetchAmis(q)}
              style={{ padding: '6px 10px', background: '#7B42BC', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
            >
              {searching ? '…' : 'Search'}
            </button>
          </div>

          {/* Source tag */}
          {source && (
            <div style={{ padding: '4px 10px', fontSize: 10, color: '#484F58', borderBottom: '1px solid #21262D' }}>
              {source === 'aws' ? '🟢 Live from AWS API' : '📋 Curated list — connect AWS credentials for live results'}
            </div>
          )}

          {/* Results */}
          <div>
            {searching && <div style={{ padding: 12, color: '#8B949E', fontSize: 12, textAlign: 'center' }}>Searching AMIs…</div>}
            {!searching && list.length === 0 && (
              <div style={{ padding: 12, color: '#8B949E', fontSize: 12, textAlign: 'center' }}>No AMIs found — try a different search term</div>
            )}
            {list.map(img => (
              <div
                key={img.id}
                onMouseDown={e => { e.preventDefault(); onChange(img.id); setOpen(false); }}
                style={{ padding: '9px 12px', borderBottom: '1px solid #21262D', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#21262D'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ fontSize: 12, color: '#E6EDF3', fontWeight: 500 }}>
                  {img.name}
                </div>
                <div style={{ fontSize: 11, color: '#8B949E', marginTop: 2, display: 'flex', gap: 8 }}>
                  <code style={{ color: '#A5D6FF' }}>{img.id}</code>
                  {img.desc && <span>· {img.desc.substring(0, 60)}{img.desc.length > 60 ? '…' : ''}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
