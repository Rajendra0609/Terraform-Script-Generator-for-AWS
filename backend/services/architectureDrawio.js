'use strict';
/**
 * architectureDrawio.js
 * ------------------------------------------------------------------------
 * Exports the architecture model as a Draw.io / diagrams.net .drawio file
 * (mxGraph XML). This reuses the exact same box tree that architectureSvg.js
 * builds (same relX/relY packing), which conveniently maps 1:1 onto
 * mxGraph's model: a child cell's <mxGeometry x y> is relative to its
 * parent cell when `parent="<parentCellId>"` — precisely what our layout
 * already computes.
 *
 * Icons reference diagrams.net's own bundled `mxgraph.aws4.*` stencil
 * library by style name (e.g. `shape=mxgraph.aws4.resourceIcon;resIcon=
 * mxgraph.aws4.ec2;`). We never embed or ship any AWS icon artwork
 * ourselves — diagrams.net supplies it locally when the file is opened.
 * If a specific stencil name has changed across diagrams.net versions, the
 * shape degrades gracefully to a small placeholder — grouping, labels and
 * colors are unaffected either way.
 */

const { buildCloudTree } = require('./architectureSvg');

// Best-effort mapping of our `kind` → diagrams.net AWS4 resource icon name.
const RESICON = {
  ec2: 'ec2', alb: 'application_load_balancer', nat: 'nat_gateway', igw: 'internet_gateway',
  vpce: 'endpoints', tgw: 'transit_gateway', eks: 'elastic_kubernetes_service',
  eks_nodes: 'ec2', ecs: 'elastic_container_service', asg: 'auto_scaling2',
  rds: 'rds', aurora: 'aurora', cache: 'elasticache', redshift: 'redshift',
  docdb: 'documentdb', neptune: 'neptune', dynamodb: 'dynamodb', s3: 's3',
  efs: 'elastic_file_system', lambda: 'lambda', cloudfront: 'cloudfront',
  waf: 'waf', apigw: 'api_gateway', route53: 'route_53', sns: 'simple_notification_service',
  sqs: 'simple_queue_service', internet: 'users',
};

const GROUP_STYLE = {
  cloud:   'grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;fontColor=#232F3E;dashed=1;',
  region:  'grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fillColor=none;fontColor=#00A4A6;dashed=1;',
  vpc:     'grIcon=mxgraph.aws4.group_vpc2;strokeColor=#248814;fillColor=none;fontColor=#248814;dashed=0;',
  az:      'grIcon=mxgraph.aws4.group_availability_zone;strokeColor=#7D8998;fillColor=none;fontColor=#7D8998;dashed=1;',
  subnetPublic:  'grIcon=mxgraph.aws4.group_public_subnet;strokeColor=#147EBA;fillColor=#E6F2F8;fontColor=#147EBA;dashed=0;',
  subnetPrivate: 'grIcon=mxgraph.aws4.group_private_subnet;strokeColor=#7D8998;fillColor=#F2F4F7;fontColor=#7D8998;dashed=0;',
  external: 'grIcon=mxgraph.aws4.group_generic;strokeColor=#B7791F;fillColor=none;fontColor=#92600F;dashed=1;',
  bucket:   'grIcon=mxgraph.aws4.group_generic;strokeColor=#B7791F;fillColor=#FFFBEB;fontColor=#92600F;dashed=1;',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function groupCellStyle(type) {
  const g = GROUP_STYLE[type] || GROUP_STYLE.external;
  return `points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;align=left;spacingLeft=30;${g}`;
}

function resourceCellStyle(kind, color) {
  const resIcon = RESICON[kind] || 'resource';
  return `sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=${color};strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${resIcon};`;
}

function chipCellStyle() {
  return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFBEB;strokeColor=#D6A85B;fontColor=#92600F;fontSize=10;arcSize=20;';
}

/**
 * Renders the architecture model as a .drawio (mxGraph XML) document string.
 */
function renderArchitectureDrawio(model, categoryColor) {
  const cloud = buildCloudTree(model);
  cloud.relX = 0;
  cloud.relY = 0;

  let idCounter = 1;
  const nextId = () => `n${idCounter++}`;
  const cells = [];
  const resourceCellId = {}; // resource.id -> drawio cell id

  function walk(node, parentCellId) {
    const cellId = nextId();
    if (node.kind === 'container') {
      cells.push(
        `<mxCell id="${cellId}" value="${esc(node.label)}" style="${groupCellStyle(node.type)}" vertex="1" parent="${parentCellId}">`
        + `<mxGeometry x="${node.relX.toFixed(1)}" y="${node.relY.toFixed(1)}" width="${node.w.toFixed(1)}" height="${node.h.toFixed(1)}" as="geometry"/></mxCell>`
      );
      (node.children || []).forEach(child => walk(child, cellId));
    } else if (node.kind === 'leaf') {
      const r = node.resource;
      const color = categoryColor[r.category] || '#7D8998';
      cells.push(
        `<mxCell id="${cellId}" value="${esc(r.name)}${r.count > 1 ? ' (x' + r.count + ')' : ''}${r.eip ? ' [EIP: ' + esc(r.eip) + ']' : ''}" style="${resourceCellStyle(r.kind, color)}" vertex="1" parent="${parentCellId}">`
        + `<mxGeometry x="${node.relX.toFixed(1)}" y="${node.relY.toFixed(1)}" width="48" height="48" as="geometry"/></mxCell>`
      );
      resourceCellId[r.id] = cellId;
    } else if (node.kind === 'chip') {
      cells.push(
        `<mxCell id="${cellId}" value="${esc(node.label)}&#10;(${esc(node.sub)})" style="${chipCellStyle()}" vertex="1" parent="${parentCellId}">`
        + `<mxGeometry x="${node.relX.toFixed(1)}" y="${node.relY.toFixed(1)}" width="${node.w.toFixed(1)}" height="${node.h.toFixed(1)}" as="geometry"/></mxCell>`
      );
      resourceCellId[node.id] = cellId;
    }
    return cellId;
  }

  walk(cloud, '1');

  // Synthetic client/internet node, placed above the cloud container
  const clientCellId = nextId();
  cells.push(
    `<mxCell id="${clientCellId}" value="${esc(model.client.label)}" style="${resourceCellStyle('internet', '#545B64')}" vertex="1" parent="1">`
    + `<mxGeometry x="-20" y="-140" width="48" height="48" as="geometry"/></mxCell>`
  );
  resourceCellId.internet = clientCellId;

  const edgeCells = model.connections.map(edge => {
    const src = resourceCellId[edge.from];
    const tgt = resourceCellId[edge.to];
    if (!src || !tgt) return '';
    const eid = nextId();
    const dashed = edge.style === 'dashed';
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;elbow=vertical;startArrow=none;endFill=1;fontSize=10;${dashed ? 'dashed=1;strokeColor=#94A3B8;' : 'strokeColor=#475569;'}`;
    return `<mxCell id="${eid}" value="${esc(edge.label || '')}" style="${style}" edge="1" parent="1" source="${src}" target="${tgt}">`
      + `<mxGeometry relative="1" as="geometry"/></mxCell>`;
  }).filter(Boolean);

  const xml = `<mxfile host="tfgen" modified="${new Date().toISOString()}" agent="tfgen-architecture-diagram" version="21.0.0">
  <diagram name="AWS Architecture" id="tfgen-arch-diagram">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
        ${edgeCells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  return xml;
}

module.exports = { renderArchitectureDrawio };
