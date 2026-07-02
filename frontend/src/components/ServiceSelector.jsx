import React, { useState, useMemo } from 'react';
import { useTheme } from '../contexts/ThemeContext';

const CATEGORY_META = {
  'Compute':          { color: '#818CF8', icon: '*',  short: 'Compute' },
  'Storage':          { color: '#34D399', icon: '◧',  short: 'Storage' },
  'Networking':       { color: '#38BDF8', icon: '*',  short: 'Network' },
  'Database':         { color: '#C084FC', icon: '+',  short: 'Database' },
  'IAM & Security':   { color: '#FB7185', icon: '+',  short: 'Security' },
  'Monitoring':       { color: '#86EFAC', icon: '◉',  short: 'Monitor' },
  'Containers':       { color: '#22D3EE', icon: '*',  short: 'Container' },
  'CI/CD':            { color: '#FCD34D', icon: '⇢',  short: 'CI/CD' },
  'Admin & Ops':      { color: '#A78BFA', icon: '*',  short: 'Admin' },
  'Analytics':        { color: '#F97316', icon: '▶',  short: 'Analytics' },
  'App Integration':  { color: '#14B8A6', icon: '⇄',  short: 'AppInteg' },
  'Machine Learning': { color: '#EC4899', icon: '⬡',  short: 'ML / AI' },
};

const CATEGORY_ORDER = [
  'Compute','Storage','Networking','Database',
  'IAM & Security','Monitoring','Containers','CI/CD','Admin & Ops',
  'Analytics','App Integration','Machine Learning',
];

export default function ServiceSelector({ services, addedServices, onAdd }) {
  const { c } = useTheme();
  const [search, setSearch]       = useState('');
  const [activeCategory, setActiveCategory] = useState('All');

  const addedIds = useMemo(() => new Set(addedServices.map(s => s.service_type)), [addedServices]);

  const filtered = useMemo(() => {
    let list = services;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.label.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.service_type.toLowerCase().includes(q)
      );
    }
    if (activeCategory !== 'All') {
      list = list.filter(s => s.category === activeCategory);
    }
    return list;
  }, [services, search, activeCategory]);

  const categories = useMemo(() => {
    const present = new Set(services.map(s => s.category));
    return CATEGORY_ORDER.filter(c => present.has(c));
  }, [services]);

  const grouped = useMemo(() => {
    if (activeCategory !== 'All' || search.trim()) return null;
    const map = {};
    CATEGORY_ORDER.forEach(cat => {
      const items = filtered.filter(s => s.category === cat);
      if (items.length) map[cat] = items;
    });
    return map;
  }, [filtered, activeCategory, search]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: c.bg }}>

      {/* Header */}
      <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${c.bd}`, flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: c.fg, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 18, height: 18, borderRadius: 4, background: c.accent + '15', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: c.accent, fontWeight: 800 }}>A</span>
          AWS Services
        </div>
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: c.fg3, fontSize: 12, pointerEvents: 'none', fontWeight: 600 }}>S</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search services..."
            style={{
              width: '100%', background: c.bg2, border: `1.5px solid ${c.bd}`, borderRadius: 8,
              color: c.fg, padding: '8px 10px 8px 32px', fontSize: 12.5, outline: 'none',
              fontFamily: 'inherit', boxSizing: 'border-box', transition: 'all 0.18s',
              boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.04)',
            }}
            onFocus={e => { e.target.style.borderColor = c.accent; e.target.style.background = c.bg3; }}
            onBlur={e => { e.target.style.borderColor = c.bd; e.target.style.background = c.bg2; }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: c.fg3, cursor: 'pointer', fontSize: 16, padding: 0, transition: 'color 0.1s' }}
              onMouseEnter={e => e.currentTarget.style.color = c.fg}
              onMouseLeave={e => e.currentTarget.style.color = c.fg3}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Category tabs */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${c.bd}`, flexShrink: 0, display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: '100px', overflowY: 'auto' }}>
        {['All', ...categories].map(cat => {
          const meta = CATEGORY_META[cat];
          const isActive = activeCategory === cat;
          return (
            <button key={cat} onClick={() => setActiveCategory(cat)}
              style={{
                padding: '4px 10px', borderRadius: 6, border: isActive ? `1.5px solid ${meta?.color || c.accent}` : `1px solid ${c.bd}`,
                background: isActive ? (meta?.color || c.accent) + '15' : 'transparent',
                color: isActive ? (meta?.color || c.accent) : c.fg3,
                fontSize: 11, fontWeight: 700, cursor: 'pointer', transition: 'all 0.12s',
                fontFamily: 'inherit', whiteSpace: 'nowrap', boxSizing: 'border-box',
              }}>
              {meta?.short || cat}
            </button>
          );
        })}
      </div>

      {/* Service list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px' }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: c.fg3 }}>
            <div style={{ fontSize: 24, marginBottom: 10, opacity: 0.5 }}>--</div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>No services match</div>
            <div style={{ fontSize: 11, color: c.fg3, marginTop: 4 }}>{search}</div>
          </div>
        )}

        {grouped ? (
          Object.entries(grouped).map(([cat, items]) => {
            const meta = CATEGORY_META[cat] || { color: c.accent, icon: '*' };
            return (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 6px', marginBottom: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, flexShrink: 0, boxShadow: `0 0 8px ${meta.color}40` }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: meta.color, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {cat}
                  </span>
                  <span style={{ fontSize: 9, color: c.fg3, marginLeft: 'auto', fontWeight: 600, background: c.bg2, padding: '1px 6px', borderRadius: 3 }}>{items.length}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 2 }}>
                  {items.map(svc => (
                    <ServiceCard key={svc.service_type} svc={svc} meta={meta} added={addedIds.has(svc.service_type)} onAdd={onAdd} c={c} />
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 2 }}>
            {filtered.map(svc => {
              const meta = CATEGORY_META[svc.category] || { color: c.accent };
              return (
                <ServiceCard key={svc.service_type} svc={svc} meta={meta} added={addedIds.has(svc.service_type)} onAdd={onAdd} c={c} />
              );
            })}
          </div>
        )}
      </div>

      {/* Footer count */}
      <div style={{ padding: '10px 16px', borderTop: `1px solid ${c.bd}`, fontSize: 11, color: c.fg3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, background: c.bg2 }}>
        <span>{services.length} services</span>
        <span style={{ color: c.accent, background: c.accent + '12', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>{addedIds.size} added</span>
      </div>
    </div>
  );
}

function ServiceCard({ svc, meta, added, onAdd, c }) {
  const [hover, setHover] = useState(false);
  const rawIcon = svc.icon || '';
  let iconText = null;
  if (typeof rawIcon === 'string' && rawIcon) {
    const parts = rawIcon.split(/[_\s-]+/).filter(Boolean);
    if (parts.length > 1) iconText = parts.map(p => p[0]).join('').slice(0, 3).toUpperCase();
    else iconText = (rawIcon.length > 3 ? rawIcon.slice(0, 3) : rawIcon).toUpperCase();
  }

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => !added && onAdd(svc)}
      disabled={added}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        position: 'relative',
        padding: '10px 12px', borderRadius: 10, cursor: added ? 'not-allowed' : 'pointer',
        minHeight: 56,
        border: added ? `1.5px solid ${meta.color}30` : `1px solid ${hover ? meta.color + '40' : c.bd}`,
        background: added ? meta.color + '08' : hover ? meta.color + '06' : 'transparent',
        transition: 'all 0.15s ease-out',
        borderLeft: `3.5px solid ${added ? meta.color : hover ? meta.color : 'transparent'}`,
        boxSizing: 'border-box', overflow: 'hidden', width: '100%',
        boxShadow: added ? `0 2px 8px ${meta.color}10` : hover ? `0 2px 8px rgba(0,0,0,0.04)` : 'none',
        fontFamily: 'inherit', textAlign: 'left',
        transform: hover && !added ? 'translateX(2px)' : 'none',
      }}>
      {/* Icon */}
      <div style={{
        flex: '0 0 34px', minWidth: 34, width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(135deg, ${meta.color}12, ${meta.color}20)`, color: meta.color, fontWeight: 800,
        border: `1px solid ${meta.color}20`, overflow: 'hidden', boxSizing: 'border-box', padding: '0 4px', position: 'relative', zIndex: 0,
      }}>
        {iconText ? (
          <span style={{ display: 'inline-block', width: '100%', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', fontWeight: 800 }}>{iconText}</span>
        ) : (
          <ServiceIcon type={svc.service_type} color={meta.color} />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: added ? meta.color : c.fg,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          wordBreak: 'normal', lineHeight: 1.35,
          letterSpacing: '-0.01em',
        }}>
          {svc.label}
        </div>
        <div style={{
          fontSize: 10, color: c.fg3, fontWeight: 500,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {svc.service_type}
        </div>
      </div>

      {/* Status / action */}
      {added ? (
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: meta.color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${meta.color}35`, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: meta.color, fontWeight: 800 }}>OK</span>
        </div>
      ) : hover ? (
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: meta.color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${meta.color}30` }}>
          <span style={{ fontSize: 14, color: meta.color, lineHeight: 1, fontWeight: 800 }}>+</span>
        </div>
      ) : null}
    </button>
  );
}

function ServiceIcon({ type, color }) {
  const icons = {
    // ── Compute (original) ────────────────────────────────────────────────────
    ec2: 'EC2', auto_scaling_group: 'ASG', alb: 'ALB', lambda: 'λ',
    launch_template: 'LT', elastic_beanstalk: 'EB', spot_fleet: 'SPOT',
    // Compute (new v9)
    key_pair: 'KEY', image_builder_pipeline: 'IMGB', apprunner_service: 'APPR',
    batch_compute_environment: 'BTCH', lambda_layer_version: 'LLYR',
    lambda_function_url: 'LURL', lambda_event_source_mapping: 'LESM',

    // ── Storage (original) ────────────────────────────────────────────────────
    s3: 'S3', ebs_volume: 'EBS', efs: 'EFS', fsx: 'FSX', datasync_task: 'SYNC',
    // Storage (new v9)
    s3_bucket_policy: 'S3P', transfer_server: 'SFTP',
    backup_vault: 'BKPV', storage_gateway: 'SGW',

    // ── Networking (original) ─────────────────────────────────────────────────
    vpc: 'VPC', subnet: 'SUB', security_group: 'SG', internet_gateway: 'IGW',
    nat_gateway: 'NAT', route_table: 'RT', route53_zone: 'R53', cloudfront: 'CDN',
    vpc_peering: 'PEER', elastic_ip: 'EIP', network_acl: 'NACL', vpc_endpoint: 'VPCE',
    customer_gateway: 'CGW', vpn_connection: 'VPN', direct_connect_gateway: 'DX',
    network_load_balancer: 'NLB', vpc_flow_logs: 'FLOW', global_accelerator: 'GA',
    network_firewall: 'NFW',
    // Networking (new v9)
    route53_record: 'DNS', route53_resolver_endpoint: 'RDNS',
    route53_resolver_rule: 'RRULE', route53_traffic_policy: 'R53TP',
    alb_target_group: 'TG', alb_listener: 'LSTN', alb_listener_rule: 'LRULE',
    gateway_load_balancer: 'GWLB', vpc_ipam: 'IPAM', vpc_ipam_pool: 'IPAMP',

    // ── Database (original) ───────────────────────────────────────────────────
    rds: 'RDS', dynamodb: 'DDB', elasticache: 'EC', aurora_cluster: 'AUR',
    redshift_cluster: 'RS', opensearch_domain: 'ES', documentdb_cluster: 'DOC',
    rds_proxy: 'PRXY', timestream_database: 'TS',
    // Database (new v9)
    db_subnet_group: 'DBSN', db_parameter_group: 'DBPG',
    dynamodb_global_table: 'DDGT', dax_cluster: 'DAX',
    neptune_cluster: 'NEPT', memorydb_cluster: 'MMDB', keyspaces_table: 'KSPC',

    // ── IAM & Security (original) ─────────────────────────────────────────────
    iam_role: 'IAM', iam_user: 'USR', iam_policy: 'POL', iam_group: 'GRP',
    kms_key: 'KMS', secrets_manager: 'SEC', acm_certificate: 'ACM',
    security_hub: 'SHUB', macie: 'MAC', inspector2: 'INSP', iam_oidc_provider: 'OIDC',
    // IAM & Security (new v9)
    iam_access_analyzer: 'AA', shield_protection: 'SHLD', fms_policy: 'FMS',
    ssoadmin_instance: 'SSO', ram_resource_share: 'RAM',
    directory_service_directory: 'AD', cognito_identity_pool: 'CIDP',
    acmpca_certificate_authority: 'PCA', verifiedaccess_instance: 'VA',

    // ── Monitoring (original) ─────────────────────────────────────────────────
    cloudwatch_alarm: 'CWA', cloudwatch_log_group: 'CWL', sns_topic: 'SNS',
    sqs_queue: 'SQS', eventbridge_rule: 'EVB', cloudwatch_dashboard: 'DASH',
    xray_group: 'XRAY', prometheus_workspace: 'AMP', grafana_workspace: 'AMG',
    // Monitoring (new v9)
    cloudwatch_composite_alarm: 'CWAL', synthetics_canary: 'CNRY',
    cloudwatch_metric_stream: 'CWMS', rum_app_monitor: 'RUM',
    pipes_pipe: 'PIPE', scheduler_schedule: 'SCHED',
    devopsguru_resource_collection: 'DOG', chatbot_slack_channel_configuration: 'CHAT',

    // ── Containers (original) ─────────────────────────────────────────────────
    eks: 'EKS', ecs_cluster: 'ECS', ecr_repository: 'ECR',
    ecs_task_definition: 'TASK', ecs_service: 'SVC',
    eks_node_group: 'NG', eks_fargate_profile: 'FG',
    // Containers (new v9)
    eks_addon: 'EKSAD', appmesh_mesh: 'MESH', ecr_lifecycle_policy: 'ELCP',
    ecs_capacity_provider: 'ESCP', eks_identity_provider_config: 'EIDP',
    ecrpublic_repository: 'ECRP',

    // ── CI/CD (original) ──────────────────────────────────────────────────────
    codepipeline: 'CPL', codebuild: 'CBL', codedeploy: 'CDL',
    api_gateway: 'API', codecommit: 'GIT', codeartifact: 'PKG',
    api_gateway_v2: 'HTTP', amplify_app: 'AMP',
    // CI/CD (new v9)
    codestarconnections_connection: 'CSTR', api_gateway_domain_name: 'AGWD',
    api_gateway_stage: 'AGST', appconfig_application: 'ACFG',
    cloud9_environment_ec2: 'C9', codegurureviewer_repository_association: 'CGR',
    servicecatalog_portfolio: 'SCAT',

    // ── Admin & Ops (original) ────────────────────────────────────────────────
    ssm_parameter: 'SSM', aws_backup: 'BAK', cloudtrail: 'CT',
    guardduty: 'GD', waf: 'WAF', budgets: 'BUD', config_rule: 'CFG',
    transit_gateway: 'TGW', ssm_patch_baseline: 'PTCH', ses_email_identity: 'SES',
    organizations_account: 'ORG', service_control_policy: 'SCP',
    config_conformance_pack: 'CONF', ssm_maintenance_window: 'MW',
    route53_health_check: 'HC',
    // Admin & Ops (new v9)
    cloudformation_stack: 'CFN', resourcegroups_group: 'RG',
    ce_anomaly_monitor: 'CAD', fis_experiment_template: 'FIS',
    drs_replication_configuration_template: 'DRS',

    // ── Analytics (original) ──────────────────────────────────────────────────
    kinesis_stream: 'KDS', kinesis_firehose: 'KDF', glue_job: 'GLU',
    glue_catalog_database: 'CAT', athena_workgroup: 'ATH', msk_cluster: 'MSK',
    emr_cluster: 'EMR',
    // Analytics (new v9)
    glue_crawler: 'GCRL', glue_workflow: 'GWF', lakeformation_resource: 'LFM',
    quicksight_data_set: 'QS', opensearchserverless_collection: 'OSS',
    redshift_serverless_workgroup: 'RSVR',

    // ── App Integration (original) ────────────────────────────────────────────
    step_functions: 'SFN', appsync: 'GQL', mq_broker: 'MQ',
    eventbridge_bus: 'BUS', cognito_user_pool: 'AUTH',
    // App Integration (new v9)
    ses_configuration_set: 'SESC', pinpoint_app: 'PNPT', appflow_flow: 'AFLW',
    cognito_user_pool_client: 'CUPC', cloudwatch_event_api_destination: 'APID',
    sqs_queue_redrive_policy: 'DLQ',

    // ── Machine Learning (original) ───────────────────────────────────────────
    sagemaker_notebook: 'NB', sagemaker_endpoint: 'ML', bedrock_model_invocation: 'BDK',
    // Machine Learning (new v9)
    sagemaker_domain: 'SMDO', sagemaker_pipeline: 'SMPL', sagemaker_feature_group: 'SMFS',
    rekognition_collection: 'REKG', comprehend_entity_recognizer: 'COMP',
    bedrock_custom_model: 'BRCK',
  };
  const letter = icons[type] || type.split('_').map(p => p[0]).join('').toUpperCase().slice(0, 4);
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em' }}>
      {letter}
    </span>
  );
}
