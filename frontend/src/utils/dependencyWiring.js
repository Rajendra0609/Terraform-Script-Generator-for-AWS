import { generateHCL } from '../engine/templateEngine';

// Detect primary terraform resource identifier from a template body.
function detectPrimaryResourceBlock(templateBody) {
  if (!templateBody) return null;
  // Try to match resource "aws_xxx" "{{name}}"
  const m = templateBody.match(/resource\s+"([^"]+)"\s+"{{name}}"/);
  if (m) return m[1];
  // Fallback: match first resource block name
  const m2 = templateBody.match(/resource\s+"([^"]+)"\s+"([^"]+)"/);
  if (m2) return m2[1];
  return null;
}

// Build a Terraform reference (e.g. aws_subnet.my_subnet.id) for a given resource
function buildReference(resource) {
  const template = resource.template_body || resource.module_body || '';
  const block = detectPrimaryResourceBlock(template) || `aws_${resource.service_type}`;
  // Use configured name when available
  const name = (resource.config && resource.config.name) || resource.label || resource._id;
  return `${block}.${name}.id`;
}

// Given a target field id, return whether it expects a list
function expectsList(fieldId) {
  return /ids$|_ids$|subnet_ids|vpc_zone_identifier|target_group_arns/.test(fieldId);
}

// Heuristic mapping from field id to candidate service types
function candidateServiceTypesForField(fieldId) {
  fieldId = fieldId.toLowerCase();
  if (fieldId.includes('subnet_id') && !fieldId.includes('ids')) return ['subnet'];
  if (fieldId.includes('subnet_ids') || fieldId.includes('subnets')) return ['subnet'];
  if (fieldId.includes('vpc_id') || fieldId === 'vpc') return ['vpc'];
  if (fieldId.includes('security_group') || fieldId.includes('sg')) return ['security_group'];
  if (fieldId.includes('eip') || fieldId.includes('allocation_id')) return ['elastic_ip'];
  if (fieldId.includes('iam_role') || fieldId.includes('role_arn') || fieldId.includes('instance_profile')) return ['iam_role'];
  if (fieldId.includes('iam_policy') || fieldId.includes('policy_arn')) return ['iam_policy'];
  if (fieldId.includes('target_group') || fieldId.includes('target_group_arn')) return ['alb', 'network_load_balancer'];
  if (fieldId.includes('key_id') || fieldId.includes('kms_key')) return ['kms_key'];
  if (fieldId.includes('s3_bucket') || fieldId.includes('bucket_name') || fieldId.includes('bucket_id') || fieldId.includes('bucket_arn')) return ['s3'];
  if (fieldId.includes('sns_topic') || fieldId.includes('topic_arn')) return ['sns_topic'];
  if (fieldId.includes('sqs_queue') || fieldId.includes('queue_arn') || fieldId.includes('queue_url')) return ['sqs_queue'];
  if (fieldId.includes('lambda') || fieldId.includes('function_name') || fieldId.includes('function_arn') || fieldId.includes('lambda_arn')) return ['lambda'];
  if (fieldId.includes('cluster_arn') || fieldId.includes('cluster_name')) return ['eks', 'ecs_cluster'];
  if (fieldId.includes('db_subnet_group')) return ['subnet'];
  if (fieldId.includes('route_table') || fieldId.includes('route_table_id')) return ['route_table'];
  if (fieldId.includes('internet_gateway') || fieldId.includes('igw_id') || fieldId.includes('gateway_id')) return ['internet_gateway'];
  if (fieldId.includes('nat_gateway') || fieldId.includes('nat_id')) return ['nat_gateway'];
  if (fieldId.includes('customer_gateway') || fieldId.includes('cgw')) return ['customer_gateway'];
  if (fieldId.includes('transit_gateway')) return ['transit_gateway'];
  if (fieldId.includes('hosted_zone') || fieldId.includes('zone_id')) return ['route53_zone'];
  if (fieldId.includes('log_group') || fieldId.includes('cloudwatch')) return ['cloudwatch_log_group'];
  if (fieldId.includes('ecr') || fieldId.includes('repository_url')) return ['ecr_repository'];
  if (fieldId.includes('task_definition')) return ['ecs_task_definition'];
  if (fieldId.includes('secret_arn') || fieldId.includes('secret')) return ['secrets_manager'];
  if (fieldId.includes('kinesis') || fieldId.includes('stream_arn')) return ['kinesis_stream'];
  if (fieldId.includes('certificate') || fieldId.includes('acm_arn')) return ['acm_certificate'];
  if (fieldId.includes('peer_vpc')) return ['vpc'];
  if (fieldId.includes('user_pool') && !fieldId.includes('client')) return ['cognito_user_pool'];
  if (fieldId.includes('user_pool_client')) return ['cognito_user_pool_client'];
  if (fieldId.includes('identity_pool')) return ['cognito_identity_pool'];
  if (fieldId.includes('state_machine') || fieldId.includes('sfn')) return ['step_functions'];
  // Load balancer relationships (v9)
  if (fieldId.includes('load_balancer_arn') || fieldId.includes('lb_arn')) return ['alb', 'gateway_load_balancer'];
  if (fieldId.includes('listener_arn')) return ['alb_listener'];
  if (fieldId.includes('target_group_arn') || fieldId.includes('target_group')) return ['alb_target_group'];
  // Route53 (v9)
  if (fieldId.includes('zone_id') || fieldId.includes('hosted_zone_id')) return ['route53_zone'];
  if (fieldId.includes('resolver_endpoint')) return ['route53_resolver_endpoint'];
  // IAM extended (v9)
  if (fieldId.includes('execution_role') || fieldId.includes('data_access_role')) return ['iam_role'];
  if (fieldId.includes('service_role')) return ['iam_role'];
  // Storage (v9)
  if (fieldId.includes('backup_vault')) return ['backup_vault'];
  if (fieldId.includes('firehose') || fieldId.includes('delivery_stream')) return ['kinesis_firehose'];
  // EKS (v9)
  if (fieldId.includes('cluster_name')) return ['eks', 'ecs_cluster'];
  if (fieldId.includes('addon_name') || fieldId.includes('eks_addon')) return ['eks_addon'];
  // Containers (v9)
  if (fieldId.includes('mesh_name') || fieldId.includes('appmesh')) return ['appmesh_mesh'];
  if (fieldId.includes('capacity_provider')) return ['ecs_capacity_provider'];
  if (fieldId.includes('auto_scaling_group_arn')) return ['auto_scaling_group'];
  // Database (v9)
  if (fieldId.includes('db_subnet_group') || fieldId.includes('subnet_group_name')) return ['db_subnet_group'];
  if (fieldId.includes('db_parameter_group') || fieldId.includes('parameter_group')) return ['db_parameter_group'];
  // Analytics (v9)
  if (fieldId.includes('glue') || fieldId.includes('catalog_database')) return ['glue_catalog_database'];
  if (fieldId.includes('crawler')) return ['glue_crawler'];
  // Monitoring (v9)
  if (fieldId.includes('canary')) return ['synthetics_canary'];
  if (fieldId.includes('rum') || fieldId.includes('app_monitor')) return ['rum_app_monitor'];
  if (fieldId.includes('schedule_group') || fieldId.includes('scheduler')) return ['scheduler_schedule'];
  // ML (v9)
  if (fieldId.includes('sagemaker_domain') || fieldId.includes('domain_id')) return ['sagemaker_domain'];
  if (fieldId.includes('feature_group')) return ['sagemaker_feature_group'];
  // IPAM (v9)
  if (fieldId.includes('ipam_scope') || fieldId.includes('ipam_pool')) return ['vpc_ipam_pool'];
  // broad fallback for network-related fields
  if (fieldId.includes('network') || fieldId.includes('cidr')) return ['vpc', 'subnet'];
  return ['subnet', 'vpc', 'security_group'];
}

// Auto-wire a single resource's empty config fields from existing resources
export function autoWireResource(resource, resources, environment = 'dev') {
  if (!resource || !resource.schema_def) return resource;
  const newConfig = { ...(resource.config || {}) };
  const wiredFrom = { ...(resource.wiredFrom || {}) };

  for (const field of resource.schema_def) {
    const id = field.id;
    const cur = newConfig[id];
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') continue; // skip if already set

    const candidatesTypes = candidateServiceTypesForField(id);
    let found = null;
    // find first matching resource of candidate types
    for (const t of candidatesTypes) {
      found = resources.find(r => r.service_type === t && r._id !== resource._id);
      if (found) break;
    }
    if (!found) continue;

    // build reference(s)
    if (expectsList(id)) {
      // use all matching resources of that type
      const matches = resources.filter(r => r.service_type === found.service_type && r._id !== resource._id);
      if (matches.length === 0) continue;
      const refs = matches.map(m => buildReference(m));
      newConfig[id] = refs.join(', ');
      wiredFrom[id] = { sourceId: matches.map(m => m._id), sourceLabel: matches.map(m => (m.config && m.config.name) || m.label), sourceType: found.service_type };
    } else {
      newConfig[id] = buildReference(found);
      wiredFrom[id] = { sourceId: found._id, sourceLabel: (found.config && found.config.name) || found.label, sourceType: found.service_type };
    }
  }

  const updated = { ...resource, config: newConfig, wiredFrom };
  // regenerate hcl_output if template present
  if (resource.template_body) {
    updated.hcl_output = generateHCL(resource.template_body, newConfig, environment);
  }
  return updated;
}

// Apply wiring across all resources (for new additions or after edits)
export function applyWiringToAll(resources, environment = 'dev') {
  // process in order: prefer earlier resources as providers
  const updated = resources.map(r => ({ ...r }));
  for (let i = 0; i < updated.length; i++) {
    updated[i] = autoWireResource(updated[i], updated, environment);
  }
  return updated;
}

/**
 * Compute graph edges from `wiredFrom` metadata.
 * Returns [{fromId, toId, fieldId, label}] — fromId provides a ref to toId.
 */
export function computeEdges(resources) {
  const edges = [];
  for (const r of resources) {
    if (!r.wiredFrom) continue;
    for (const [fieldId, wire] of Object.entries(r.wiredFrom)) {
      const sourceIds = Array.isArray(wire.sourceId) ? wire.sourceId : [wire.sourceId];
      for (const sid of sourceIds) {
        // Edge goes FROM the dependency TO the dependent resource
        edges.push({ fromId: sid, toId: r._id, fieldId, label: fieldId });
      }
    }
  }
  return edges;
}

/**
 * Manually connect two resources by wiring fromId → toId on fieldId.
 * Updates toResource's config with the reference and marks wiredFrom.
 * Returns a new resources array with the updated resource.
 */
export function connectByEdge(resources, fromId, toId, fieldId, environment = 'dev') {
  const from = resources.find(r => r._id === fromId);
  const to   = resources.find(r => r._id === toId);
  if (!from || !to) return resources;

  const ref = buildReference(from);
  const newConfig = { ...(to.config || {}), [fieldId]: expectsList(fieldId)
    ? [to.config?.[fieldId], ref].filter(Boolean).join(', ')
    : ref };
  const newWiredFrom = { ...(to.wiredFrom || {}), [fieldId]: {
    sourceId: fromId, sourceLabel: (from.config?.name) || from.label, sourceType: from.service_type,
  } };

  const updatedTo = { ...to, config: newConfig, wiredFrom: newWiredFrom };
  if (to.template_body) {
    updatedTo.hcl_output = generateHCL(to.template_body, newConfig, environment);
  }
  return resources.map(r => r._id === toId ? updatedTo : r);
}

/**
 * Remove a wired edge: disconnect fromId → toId on fieldId.
 * Clears the config field and wiredFrom entry.
 */
export function disconnectEdge(resources, fromId, toId, fieldId, environment = 'dev') {
  const to = resources.find(r => r._id === toId);
  if (!to) return resources;

  const newConfig    = { ...(to.config || {}), [fieldId]: '' };
  const newWiredFrom = { ...(to.wiredFrom || {}) };
  delete newWiredFrom[fieldId];

  const updatedTo = { ...to, config: newConfig, wiredFrom: newWiredFrom };
  if (to.template_body) {
    updatedTo.hcl_output = generateHCL(to.template_body, newConfig, environment);
  }
  return resources.map(r => r._id === toId ? updatedTo : r);
}
