'use strict';
/**
 * architectureMapper.js
 * ------------------------------------------------------------------------
 * Converts the flat resource list produced by hclArchParser.js into a
 * normalized "AWS architecture model" — the same shape sketched in the
 * feature spec (AWS Cloud → Region → VPC → Availability Zone → Subnet →
 * Resource), plus an inferred connection list.
 *
 * Placement / topology inference rules implemented here (see comments
 * inline near each function for the specific signal used):
 *   - public vs private subnet: route-table walk to an Internet Gateway,
 *     or map_public_ip_on_launch=true
 *   - AZ grouping: subnet's availability_zone literal (synthetic AZ-N
 *     bucket when the value isn't a literal, e.g. a data-source lookup)
 *   - resource → subnet placement: direct subnet_id/subnet_ids fields,
 *     known nested blocks (vpc_config, network_configuration), one-hop
 *     subnet-group indirection (RDS/ElastiCache), then a generic deep scan
 *     as a last resort
 *   - connections: explicit reference chains where possible (listener →
 *     target group → attached resource, SG sharing between app/db tiers),
 *     falling back to a single labeled "inferred" edge per tier pair when
 *     no explicit reference exists — inferred edges are always marked
 *     style:'dashed' so the diagram is honest about what it actually knows
 *     vs. what it's guessing from tier co-location.
 *
 * Anything the parser can't confidently place lands in `uncategorized`
 * (spec requirement: fallback behavior for unsupported resources).
 */

const { DEFAULT_AWS_REGION } = require('../config/region');

// ── Value helpers (operate on hclArchParser value nodes) ───────────────────
const AWS_REF_RE = /\baws_[a-zA-Z0-9_]+\.[A-Za-z0-9_-]+/g;

function asString(node) {
  return node && node.type === 'string' ? node.value : null;
}
function asBool(node) {
  return node && node.type === 'bool' ? node.value : null;
}
function asNumber(node) {
  return node && node.type === 'number' ? node.value : null;
}

/** Recursively collects all `aws_type.name` references found anywhere inside a value node. */
function extractRefs(node) {
  if (!node) return [];
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'expr') {
      const matches = n.raw.match(AWS_REF_RE);
      if (matches) out.push(...matches);
    } else if (n.type === 'string') {
      const matches = n.value.match(AWS_REF_RE);
      if (matches) out.push(...matches);
    } else if (n.type === 'list') {
      (n.items || []).forEach(walk);
    } else if (n.type === 'object' || n.type === 'block') {
      Object.values(n.attrs || {}).forEach(v => {
        if (Array.isArray(v)) v.forEach(walk); else walk(v);
      });
    }
  };
  walk(node);
  return [...new Set(out)];
}

function firstRef(node) {
  const refs = extractRefs(node);
  return refs.length ? refs[0] : null;
}

/** Deep-scans an entire attrs map for references (used as a last-resort placement fallback). */
function extractRefsDeep(attrs) {
  const out = [];
  Object.values(attrs || {}).forEach(v => {
    if (Array.isArray(v)) v.forEach(n => out.push(...extractRefs(n)));
    else out.push(...extractRefs(v));
  });
  return [...new Set(out)];
}

function getTagName(attrs) {
  const tags = attrs && attrs.tags;
  if (tags && tags.type === 'object' && tags.attrs && tags.attrs.Name) {
    return asString(tags.attrs.Name);
  }
  return null;
}

function displayNameFor(resource) {
  const { attrs, name, type } = resource;
  return (
    getTagName(attrs) ||
    asString(attrs.name) ||
    asString(attrs.identifier) ||
    asString(attrs.bucket) ||
    asString(attrs.function_name) ||
    asString(attrs.cluster_name) ||
    asString(attrs.service_name) ||
    name
  );
}

/** Normalizes a possibly-repeated `route { }` nested-block attribute into an array. */
function normalizeBlockList(node) {
  if (!node) return [];
  return Array.isArray(node) ? node : [node];
}

// ── Resource → architecture category mapping table ─────────────────────────
// category drives icon color family; kind drives the pictogram; external
// resources are drawn at the region level (outside any VPC/subnet), matching
// how AWS itself draws managed/global services in reference diagrams.
const RESOURCE_MAP = {
  aws_instance:                       { category: 'compute',    kind: 'ec2',        label: 'EC2 Instance' },
  aws_eks_cluster:                    { category: 'compute',    kind: 'eks',        label: 'EKS Cluster' },
  aws_eks_node_group:                 { category: 'compute',    kind: 'eks_nodes',  label: 'EKS Node Group' },
  aws_ecs_cluster:                    { category: 'compute',    kind: 'ecs',        label: 'ECS Cluster' },
  aws_ecs_service:                    { category: 'compute',    kind: 'ecs',        label: 'ECS Service' },
  aws_autoscaling_group:              { category: 'compute',    kind: 'asg',        label: 'Auto Scaling Group' },
  aws_elastic_beanstalk_environment:  { category: 'compute',    kind: 'ec2',        label: 'Elastic Beanstalk' },
  aws_apprunner_service:              { category: 'compute',    kind: 'ec2',        label: 'App Runner' },
  aws_batch_compute_environment:      { category: 'compute',    kind: 'ec2',        label: 'Batch' },

  aws_lb:                             { category: 'networking', kind: 'alb',        label: 'Load Balancer' },
  aws_alb:                            { category: 'networking', kind: 'alb',        label: 'ALB' },
  aws_elb:                            { category: 'networking', kind: 'alb',        label: 'ELB' },

  aws_nat_gateway:                    { category: 'networking', kind: 'nat',        label: 'NAT Gateway' },
  aws_internet_gateway:               { category: 'networking', kind: 'igw',        label: 'Internet Gateway' },
  aws_vpc_endpoint:                   { category: 'networking', kind: 'vpce',       label: 'VPC Endpoint' },
  aws_transit_gateway:                { category: 'networking', kind: 'tgw',        label: 'Transit Gateway' },

  aws_db_instance:                    { category: 'database',   kind: 'rds',        label: 'RDS' },
  aws_rds_cluster:                    { category: 'database',   kind: 'aurora',     label: 'Aurora Cluster' },
  aws_elasticache_cluster:            { category: 'database',   kind: 'cache',      label: 'ElastiCache' },
  aws_elasticache_replication_group:  { category: 'database',   kind: 'cache',      label: 'ElastiCache' },
  aws_redshift_cluster:               { category: 'database',   kind: 'redshift',   label: 'Redshift' },
  aws_docdb_cluster:                  { category: 'database',   kind: 'docdb',      label: 'DocumentDB' },
  aws_neptune_cluster:                { category: 'database',   kind: 'neptune',    label: 'Neptune' },

  aws_dynamodb_table:                 { category: 'database',   kind: 'dynamodb',   label: 'DynamoDB', external: true },
  aws_s3_bucket:                      { category: 'storage',    kind: 's3',         label: 'S3 Bucket', external: true },
  aws_efs_file_system:                { category: 'storage',    kind: 'efs',        label: 'EFS' },

  aws_lambda_function:                { category: 'compute',    kind: 'lambda',     label: 'Lambda', external: true },
  aws_api_gateway_rest_api:           { category: 'networking', kind: 'apigw',      label: 'API Gateway', external: true },
  aws_apigatewayv2_api:               { category: 'networking', kind: 'apigw',      label: 'API Gateway', external: true },

  aws_cloudfront_distribution:        { category: 'edge',       kind: 'cloudfront', label: 'CloudFront', external: true },
  aws_wafv2_web_acl:                  { category: 'security',   kind: 'waf',        label: 'WAF', external: true },
  aws_route53_zone:                   { category: 'networking', kind: 'route53',    label: 'Route 53', external: true },

  aws_sns_topic:                      { category: 'integration', kind: 'sns',       label: 'SNS Topic', external: true },
  aws_sqs_queue:                      { category: 'integration', kind: 'sqs',       label: 'SQS Queue', external: true },
};

// Resource types consulted for topology inference but never drawn as their
// own node (kept out of the diagram to avoid clutter — AWS reference
// diagrams don't draw route tables/SGs/target groups as boxes either).
const SUPPORT_TYPES = new Set([
  'aws_vpc', 'aws_subnet', 'aws_route_table', 'aws_route', 'aws_route_table_association',
  'aws_security_group', 'aws_security_group_rule', 'aws_lb_target_group', 'aws_lb_listener',
  'aws_lb_listener_rule', 'aws_lb_target_group_attachment', 'aws_launch_template',
  'aws_launch_configuration', 'aws_iam_role', 'aws_iam_policy', 'aws_iam_role_policy',
  'aws_iam_role_policy_attachment', 'aws_iam_instance_profile', 'aws_db_subnet_group',
  'aws_elasticache_subnet_group', 'aws_wafv2_web_acl_association', 'aws_lambda_permission',
  'aws_apigatewayv2_integration', 'aws_apigatewayv2_route', 'aws_api_gateway_integration',
  'aws_lambda_function_url', 'aws_route53_record', 'aws_key_pair', 'aws_eip',
]);

// ── Public entry point ──────────────────────────────────────────────────────
function buildArchitectureModel(parsed) {
  const { resources, providers, parseWarnings } = parsed;
  const warnings = [...parseWarnings];

  const resourcesByKey = {};
  resources.forEach(r => { resourcesByKey[r.key] = r; });

  const vpcs = resources.filter(r => r.type === 'aws_vpc');
  const subnets = resources.filter(r => r.type === 'aws_subnet');
  const routeTables = resources.filter(r => r.type === 'aws_route_table');
  const routes = resources.filter(r => r.type === 'aws_route');
  const rtAssocs = resources.filter(r => r.type === 'aws_route_table_association');
  const igws = resources.filter(r => r.type === 'aws_internet_gateway');
  const natgws = resources.filter(r => r.type === 'aws_nat_gateway');
  const securityGroups = resources.filter(r => r.type === 'aws_security_group');

  const subnetsByKey = {};
  subnets.forEach(s => { subnetsByKey[s.key] = s; });

  // ── Region resolution ──────────────────────────────────────────────────
  const providerRegions = {};
  providers.forEach(p => {
    const region = asString(p.attrs.region) || DEFAULT_AWS_REGION;
    const alias = asString(p.attrs.alias);
    providerRegions[alias ? `${p.name}.${alias}` : p.name] = region;
  });
  const defaultRegion = providerRegions.aws || DEFAULT_AWS_REGION;
  if (!providers.some(p => p.name === 'aws')) {
    warnings.push(`No "provider \\"aws\\"" block with a region found — defaulting to ${defaultRegion}.`);
  }
  function regionForResource(resource) {
    const providerAttr = resource.attrs.provider;
    if (providerAttr && providerAttr.type === 'expr') {
      const key = providerAttr.raw.trim();
      if (providerRegions[key]) return providerRegions[key];
    }
    return defaultRegion;
  }

  // ── Public/private subnet inference (route-table walk) ─────────────────
  function routesForTable(rt) {
    if (!rt) return [];
    const inline = normalizeBlockList(rt.attrs.route).filter(r => r && r.type === 'block').map(r => r.attrs);
    const external = routes
      .filter(r => firstRef(r.attrs.route_table_id) === rt.key)
      .map(r => r.attrs);
    return [...inline, ...external];
  }
  function routeTargetsIgw(routeAttrs) {
    const ref = firstRef(routeAttrs.gateway_id);
    return !!(ref && ref.startsWith('aws_internet_gateway.'));
  }
  function routeTargetsNat(routeAttrs) {
    const ref = firstRef(routeAttrs.nat_gateway_id) || firstRef(routeAttrs.gateway_id);
    return !!(ref && ref.startsWith('aws_nat_gateway.'));
  }

  const subnetInfo = {}; // key -> { public, hasNat, reason, routeTableKey }
  subnets.forEach(subnet => {
    if (asBool(subnet.attrs.map_public_ip_on_launch) === true) {
      subnetInfo[subnet.key] = { public: true, hasNat: false, reason: 'map_public_ip_on_launch = true' };
      return;
    }
    const assoc = rtAssocs.find(a => firstRef(a.attrs.subnet_id) === subnet.key);
    const rt = assoc ? routeTables.find(r => r.key === firstRef(assoc.attrs.route_table_id)) : null;
    const tableRoutes = routesForTable(rt);
    const hasIgw = tableRoutes.some(routeTargetsIgw);
    const hasNat = tableRoutes.some(routeTargetsNat);
    if (hasIgw) {
      subnetInfo[subnet.key] = { public: true, hasNat: false, reason: 'route table has a route to an Internet Gateway' };
    } else if (hasNat) {
      subnetInfo[subnet.key] = { public: false, hasNat: true, reason: 'route table has a route to a NAT Gateway' };
    } else if (rt) {
      subnetInfo[subnet.key] = { public: false, hasNat: false, reason: 'route table has no Internet/NAT Gateway route' };
    } else {
      subnetInfo[subnet.key] = { public: false, hasNat: false, reason: 'no route table association found (defaulted to private)' };
    }
  });

  // ── AZ resolution (literal → real name, else synthetic) ─────────────────
  const azSyntheticCounter = {}; // vpcKey -> next index
  const subnetAz = {}; // subnetKey -> { name, synthetic }
  subnets.forEach(subnet => {
    const literal = asString(subnet.attrs.availability_zone);
    const vpcKey = firstRef(subnet.attrs.vpc_id) || '__default_vpc__';
    if (literal) {
      subnetAz[subnet.key] = { name: literal, synthetic: false };
    } else {
      azSyntheticCounter[vpcKey] = (azSyntheticCounter[vpcKey] || 0) + 1;
      subnetAz[subnet.key] = { name: `AZ-${azSyntheticCounter[vpcKey]} (inferred)`, synthetic: true };
      warnings.push(`Subnet "${subnet.name}" has no literal availability_zone — grouped into a synthetic AZ bucket.`);
    }
  });

  // ── VPC index ────────────────────────────────────────────────────────────
  const defaultVpcKey = vpcs.length === 1 ? vpcs[0].key : null;
  function resolveVpcKeyForSubnet(subnet) {
    return firstRef(subnet.attrs.vpc_id) || defaultVpcKey || '__unknown_vpc__';
  }

  // ── Resource → subnet placement ─────────────────────────────────────────
  const index = { subnetsByKey, resourcesByKey };
  function resolveSubnetForResource(resource) {
    if (resource.attrs.subnet_id) {
      const ref = firstRef(resource.attrs.subnet_id);
      if (ref && subnetsByKey[ref]) return { subnetKey: ref, count: 1 };
    }
    for (const field of ['subnet_ids', 'subnets', 'vpc_zone_identifier']) {
      if (resource.attrs[field]) {
        const refs = extractRefs(resource.attrs[field]).filter(r => subnetsByKey[r]);
        if (refs.length) return { subnetKey: refs[0], count: refs.length };
      }
    }
    for (const blockField of ['vpc_config', 'network_configuration']) {
      const block = resource.attrs[blockField];
      const blockObj = block && block.type === 'block' ? block : null;
      if (blockObj) {
        for (const field of ['subnet_ids', 'subnets']) {
          if (blockObj.attrs[field]) {
            const refs = extractRefs(blockObj.attrs[field]).filter(r => subnetsByKey[r]);
            if (refs.length) return { subnetKey: refs[0], count: refs.length };
          }
        }
      }
    }
    for (const field of ['db_subnet_group_name', 'subnet_group_name', 'cache_subnet_group_name']) {
      if (resource.attrs[field]) {
        const groupRef = firstRef(resource.attrs[field]);
        const group = groupRef && resourcesByKey[groupRef];
        if (group && group.attrs.subnet_ids) {
          const refs = extractRefs(group.attrs.subnet_ids).filter(r => subnetsByKey[r]);
          if (refs.length) return { subnetKey: refs[0], count: refs.length };
        }
      }
    }
    const deepRefs = extractRefsDeep(resource.attrs).filter(r => subnetsByKey[r]);
    if (deepRefs.length) return { subnetKey: deepRefs[0], count: deepRefs.length };
    return null;
  }

  // ── Build region → vpc → az → subnet tree ───────────────────────────────
  const regionsByName = {};
  function getRegion(name) {
    if (!regionsByName[name]) {
      regionsByName[name] = { name, external_services: [], vpcs: [] };
    }
    return regionsByName[name];
  }
  const vpcsByKey = {};
  vpcs.forEach(vpc => {
    const region = regionForResource(vpc);
    const r = getRegion(region);
    const entry = {
      key: vpc.key,
      name: displayNameFor(vpc),
      cidr: asString(vpc.attrs.cidr_block) || '',
      region,
      azMap: {}, // azName -> { name, synthetic, public_subnets:[], private_subnets:[] }
      igw: null,
    };
    r.vpcs.push(entry);
    vpcsByKey[vpc.key] = entry;
  });
  // Handle subnets whose VPC couldn't be resolved to a parsed aws_vpc block
  // (e.g. referencing a data source or variable) — synthesize a container
  // VPC so the diagram still renders sensibly instead of dropping resources.
  function ensureVpcEntry(vpcKey) {
    if (vpcsByKey[vpcKey]) return vpcsByKey[vpcKey];
    const region = defaultRegion;
    const r = getRegion(region);
    const entry = { key: vpcKey, name: vpcKey === '__unknown_vpc__' ? 'Unresolved VPC' : vpcKey, cidr: '', region, azMap: {}, igw: null };
    r.vpcs.push(entry);
    vpcsByKey[vpcKey] = entry;
    return entry;
  }

  igws.forEach(igw => {
    const vpcKey = firstRef(igw.attrs.vpc_id) || defaultVpcKey;
    if (vpcKey) {
      const entry = ensureVpcEntry(vpcKey);
      entry.igw = { id: igw.key, label: displayNameFor(igw) };
    }
  });

  function getAzBucket(vpcEntry, subnetKey) {
    const az = subnetAz[subnetKey] || { name: 'AZ-1 (inferred)', synthetic: true };
    if (!vpcEntry.azMap[az.name]) {
      vpcEntry.azMap[az.name] = { name: az.name, synthetic: az.synthetic, public_subnets: [], private_subnets: [] };
    }
    return vpcEntry.azMap[az.name];
  }

  const subnetBuckets = {}; // subnetKey -> { list, subnetEntry }
  subnets.forEach(subnet => {
    const vpcKey = resolveVpcKeyForSubnet(subnet);
    const vpcEntry = ensureVpcEntry(vpcKey);
    const azBucket = getAzBucket(vpcEntry, subnet.key);
    const info = subnetInfo[subnet.key];
    const subnetEntry = {
      key: subnet.key,
      name: displayNameFor(subnet),
      cidr: asString(subnet.attrs.cidr_block) || '',
      public: info.public,
      hasNat: info.hasNat,
      reason: info.reason,
      resources: [],
    };
    (info.public ? azBucket.public_subnets : azBucket.private_subnets).push(subnetEntry);
    subnetBuckets[subnet.key] = subnetEntry;
  });

  // ── Map + place every non-support resource ──────────────────────────────
  const nodesById = {}; // resource.key -> node (for edge resolution)
  const uncategorized = [];
  let mappedCount = 0;

  resources.forEach(resource => {
    if (SUPPORT_TYPES.has(resource.type)) return;
    if (['aws_vpc', 'aws_subnet', 'aws_internet_gateway', 'aws_nat_gateway'].includes(resource.type)) return; // drawn structurally, not as generic nodes
    const mapping = RESOURCE_MAP[resource.type];
    if (!mapping) {
      uncategorized.push({ key: resource.key, type: resource.type, name: resource.name });
      return;
    }
    mappedCount++;
    const node = {
      id: resource.key,
      type: resource.type,
      category: mapping.category,
      kind: mapping.kind,
      label: mapping.label,
      name: displayNameFor(resource),
      external: !!mapping.external,
      count: 1,
    };
    nodesById[resource.key] = node;

    if (mapping.external) {
      const region = regionForResource(resource);
      getRegion(region).external_services.push(node);
      return;
    }

    const placement = resolveSubnetForResource(resource);
    if (placement && subnetBuckets[placement.subnetKey]) {
      node.count = placement.count || 1;
      subnetBuckets[placement.subnetKey].resources.push(node);
    } else {
      // Couldn't confidently place inside a subnet — surface it but don't
      // silently drop it: attach at VPC level via uncategorized-with-context.
      node.placementWarning = true;
      uncategorized.push({ key: resource.key, type: resource.type, name: resource.name, note: 'AWS resource recognized but no subnet placement could be inferred from its attributes.' });
      warnings.push(`Could not infer subnet placement for ${resource.key} — listed under Uncategorized.`);
    }
  });

  // NAT gateways: drawn as their own structural node inside the public
  // subnet they were provisioned in (common pattern), tracked separately so
  // private-subnet "outbound via NAT" edges can find them.
  const natNodeBySubnet = {};
  natgws.forEach(nat => {
    const subnetRef = firstRef(nat.attrs.subnet_id);
    const node = { id: nat.key, type: 'aws_nat_gateway', category: 'networking', kind: 'nat', label: 'NAT Gateway', name: displayNameFor(nat), external: false, count: 1 };
    nodesById[nat.key] = node;
    if (subnetRef && subnetBuckets[subnetRef]) {
      subnetBuckets[subnetRef].resources.push(node);
      natNodeBySubnet[subnetRef] = node;
    } else {
      uncategorized.push({ key: nat.key, type: nat.type, name: nat.name, note: 'NAT Gateway subnet could not be resolved.' });
    }
  });

  // ── Connections ──────────────────────────────────────────────────────────
  const connections = [];
  const seenEdges = new Set();
  function addEdge(from, to, label, style = 'solid') {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    connections.push({ from, to, label, style });
  }

  const CLIENT = 'internet';

  const cloudfronts = resources.filter(r => r.type === 'aws_cloudfront_distribution');
  const wafs = resources.filter(r => r.type === 'aws_wafv2_web_acl');
  const apigws = resources.filter(r => r.type === 'aws_api_gateway_rest_api' || r.type === 'aws_apigatewayv2_api');
  const lambdas = resources.filter(r => r.type === 'aws_lambda_function');
  const albs = resources.filter(r => ['aws_lb', 'aws_alb', 'aws_elb'].includes(r.type));
  const wafAssocs = resources.filter(r => r.type === 'aws_wafv2_web_acl_association');

  cloudfronts.forEach(cf => addEdge(CLIENT, cf.key, 'HTTPS'));
  if (!cloudfronts.length && apigws.length) {
    apigws.forEach(a => addEdge(CLIENT, a.key, 'HTTPS'));
  }
  if (!cloudfronts.length && !apigws.length && albs.length) {
    albs.forEach(alb => {
      const internal = asBool(alb.attrs.internal);
      if (internal !== true) addEdge(CLIENT, alb.key, 'HTTPS');
    });
  }

  // CloudFront origins → ALB / S3
  cloudfronts.forEach(cf => {
    normalizeBlockList(cf.attrs.origin).filter(o => o && o.type === 'block').forEach(origin => {
      const ref = firstRef(origin.attrs.domain_name);
      if (ref) addEdge(cf.key, ref, 'origin');
    });
  });

  // WAF associations (explicit) → whichever resource it protects
  wafAssocs.forEach(assoc => {
    const waf = firstRef(assoc.attrs.web_acl_arn);
    const target = firstRef(assoc.attrs.resource_arn);
    if (waf && target) addEdge(target, waf, 'WAF inspection');
  });
  // Fallback: single CloudFront + single WAF and no explicit association found → assume paired
  if (wafs.length === 1 && cloudfronts.length === 1 && !wafAssocs.length) {
    addEdge(cloudfronts[0].key, wafs[0].key, 'WAF inspection (inferred)', 'dashed');
  }

  // Listener → target group → attached compute
  const listeners = resources.filter(r => r.type === 'aws_lb_listener');
  const targetGroups = resources.filter(r => r.type === 'aws_lb_target_group');
  const tgAttachments = resources.filter(r => r.type === 'aws_lb_target_group_attachment');
  listeners.forEach(listener => {
    const albRef = firstRef(listener.attrs.load_balancer_arn);
    const defaultAction = listener.attrs.default_action;
    const actions = normalizeBlockList(defaultAction).filter(a => a && a.type === 'block');
    actions.forEach(action => {
      const tgRef = firstRef(action.attrs.target_group_arn);
      if (!albRef || !tgRef) return;
      // resources whose target_group_arns list includes this TG
      resources.forEach(r => {
        if (r.attrs.target_group_arns && extractRefs(r.attrs.target_group_arns).includes(tgRef) && nodesById[r.key]) {
          addEdge(albRef, r.key, 'HTTP');
        }
      });
      tgAttachments.forEach(att => {
        if (firstRef(att.attrs.target_group_arn) === tgRef) {
          const targetRef = firstRef(att.attrs.target_id);
          if (targetRef && nodesById[targetRef]) addEdge(albRef, targetRef, 'HTTP');
        }
      });
      // ECS service load_balancer block referencing this TG
      resources.filter(r => r.type === 'aws_ecs_service').forEach(svc => {
        normalizeBlockList(svc.attrs.load_balancer).filter(b => b && b.type === 'block').forEach(b => {
          if (firstRef(b.attrs.target_group_arn) === tgRef && nodesById[svc.key]) addEdge(albRef, svc.key, 'HTTP');
        });
      });
    });
  });
  // If a TG exists but we found no listener/attachment chain, still connect
  // its ALB (via aws_lb reference elsewhere is unavailable) — skipped: TGs
  // are useless without a listener, so no edge is added (nothing to infer).
  void targetGroups;

  // Private-subnet resources → NAT Gateway (outbound egress)
  Object.values(subnetBuckets).forEach(subnetEntry => {
    if (!subnetEntry.public && subnetEntry.hasNat) {
      const azVpc = Object.values(vpcsByKey).find(v => Object.values(v.azMap).some(az => az.private_subnets.includes(subnetEntry)));
      if (!azVpc) return;
      const az = Object.values(azVpc.azMap).find(a => a.private_subnets.includes(subnetEntry));
      const natInSameVpc = Object.entries(natNodeBySubnet).find(([subnetKey]) => {
        const pubSubnet = Object.values(azVpc.azMap).flatMap(a => a.public_subnets).find(s => s.key === subnetKey);
        return !!pubSubnet;
      });
      if (natInSameVpc) {
        const natNode = natInSameVpc[1];
        subnetEntry.resources.forEach(res => addEdge(res.id, natNode.id, 'Outbound (NAT)', 'dashed'));
      }
      void az;
    }
  });

  // Security-group sharing → app tier to database tier
  const sgUsedBy = {}; // sgKey -> [resourceKey]
  resources.forEach(r => {
    for (const field of ['security_groups', 'vpc_security_group_ids', 'security_group_ids']) {
      if (r.attrs[field]) {
        extractRefs(r.attrs[field]).forEach(sgRef => {
          if (!sgUsedBy[sgRef]) sgUsedBy[sgRef] = [];
          sgUsedBy[sgRef].push(r.key);
        });
      }
    }
  });
  const dbNodeKeys = Object.entries(nodesById).filter(([, n]) => n.category === 'database').map(([k]) => k);
  const computeNodeKeys = Object.entries(nodesById).filter(([, n]) => n.category === 'compute' && !n.external).map(([k]) => k);
  let explicitDbEdgeFound = new Set();
  dbNodeKeys.forEach(dbKey => {
    const dbResource = resourcesByKey[dbKey];
    const dbSgs = [];
    for (const field of ['security_groups', 'vpc_security_group_ids', 'security_group_ids']) {
      if (dbResource.attrs[field]) dbSgs.push(...extractRefs(dbResource.attrs[field]));
    }
    dbSgs.forEach(sgKey => {
      (sgUsedBy[sgKey] || []).forEach(userKey => {
        if (computeNodeKeys.includes(userKey)) {
          addEdge(userKey, dbKey, 'DB access (shared security group)');
          explicitDbEdgeFound.add(dbKey);
        }
      });
    });
  });
  // Fallback: one representative compute node → each unconnected DB node, same VPC tier hint
  dbNodeKeys.filter(k => !explicitDbEdgeFound.has(k)).forEach(dbKey => {
    if (computeNodeKeys.length) addEdge(computeNodeKeys[0], dbKey, 'Data access (inferred — same VPC)', 'dashed');
  });

  // External storage/data services (S3, DynamoDB) — representative compute edge
  const externalDataKeys = Object.entries(nodesById).filter(([, n]) => n.external && ['storage', 'database'].includes(n.category)).map(([k]) => k);
  externalDataKeys.forEach(k => {
    if (computeNodeKeys.length) addEdge(computeNodeKeys[0], k, 'Data access (inferred)', 'dashed');
    else if (lambdas.length) addEdge(lambdas[0].key, k, 'Data access (inferred)', 'dashed');
  });

  // API Gateway → Lambda
  apigws.forEach(a => {
    lambdas.forEach(l => addEdge(a.key, l.key, 'invoke (inferred)', 'dashed'));
  });
  // Lambda Function URL → direct client access
  resources.filter(r => r.type === 'aws_lambda_function_url').forEach(fu => {
    const fnRef = firstRef(fu.attrs.function_name);
    if (fnRef && nodesById[fnRef]) addEdge(CLIENT, fnRef, 'HTTPS (Function URL)');
  });

  // ── Assemble final region tree (convert azMap → sorted array) ───────────
  const regions = Object.values(regionsByName).map(region => ({
    name: region.name,
    external_services: region.external_services,
    vpcs: region.vpcs.map(v => ({
      key: v.key,
      name: v.name,
      cidr: v.cidr,
      igw: v.igw,
      availability_zones: Object.values(v.azMap).sort((a, b) => a.name.localeCompare(b.name)),
    })),
  }));

  const stats = {
    total_resources: resources.length,
    mapped_resources: mappedCount,
    uncategorized_resources: uncategorized.length,
    vpc_count: vpcs.length,
    subnet_count: subnets.length,
    connection_count: connections.length,
  };

  return {
    cloud: 'AWS',
    client: { id: CLIENT, label: 'Internet / Users' },
    regions,
    uncategorized,
    connections,
    warnings,
    stats,
  };
}

module.exports = { buildArchitectureModel, _internal: { extractRefs, firstRef, displayNameFor, RESOURCE_MAP } };
