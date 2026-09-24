'use strict';
/**
 * architectureSvg.js
 * ------------------------------------------------------------------------
 * Renders the normalized architecture model (architectureMapper.js) into an
 * AWS-reference-style SVG: nested boundary boxes (AWS Cloud → Region → VPC →
 * Availability Zone → Subnet) with resource pictograms and traffic arrows.
 *
 * A note on iconography: this renders clean, original pictograms in AWS's
 * well-known category color families (compute=orange, database=blue,
 * storage=green, networking=purple, security=red, ...) rather than AWS's
 * literal trademarked icon artwork, since that artwork isn't ours to
 * reproduce and isn't available to fetch at render time anyway. The
 * Draw.io export (architectureDrawio.js) references diagrams.net's own
 * bundled `mxgraph.aws4.*` shape library by name instead, which *does*
 * render the official AWS shapes — diagrams.net supplies that artwork
 * locally, we just point at it.
 *
 * Layout is a plain two-pass box packer (no external layout dependency):
 *   Pass 1 (bottom-up): every node computes its own {w,h} and assigns
 *     relX/relY to its children.
 *   Pass 2 (top-down): a tree walk turns relX/relY into absolute
 *     coordinates by accumulating each ancestor's content origin.
 * The tree is shallow and mostly non-overlapping by construction (it
 * mirrors the fixed Cloud→Region→VPC→AZ→Subnet hierarchy), so this is
 * sufficient without a general force-directed/graph layout algorithm.
 */

// ── Visual constants ────────────────────────────────────────────────────────
const NODE_W = 108, NODE_H = 86;
const GRID_GAP = 14;
const MAX_PER_ROW = 4;

const PAD = { subnet: 14, az: 14, vpc: 18, region: 18, cloud: 22 };
const HEADER = { subnet: 22, az: 24, vpc: 30, region: 30, cloud: 34 };

const CATEGORY_COLOR = {
  compute:     '#ED7100',
  networking:  '#8C4FFF',
  database:    '#3B48CC',
  storage:     '#7AA116',
  security:    '#DD344C',
  edge:        '#8C4FFF',
  integration: '#E7157B',
  client:      '#545B64',
};

const CONTAINER_STYLE = {
  cloud:   { stroke: '#232F3E', dash: '6,4',  fill: 'none',      labelColor: '#232F3E' },
  region:  { stroke: '#00A4A6', dash: '5,4',  fill: 'none',      labelColor: '#00A4A6' },
  vpc:     { stroke: '#248814', dash: '0',    fill: '#F4FBF1',   labelColor: '#248814' },
  az:      { stroke: '#7D8998', dash: '4,3',  fill: 'none',      labelColor: '#5A6673' },
  subnetPublic:  { stroke: '#147EBA', dash: '0', fill: '#EAF4FB', labelColor: '#0C5A87' },
  subnetPrivate: { stroke: '#7D8998', dash: '0', fill: '#F1F3F5', labelColor: '#4B5563' },
  bucket:  { stroke: '#B7791F', dash: '4,3',  fill: '#FFFBEB',   labelColor: '#92600F' },
  external:{ stroke: '#7D8998', dash: '3,3',  fill: 'none',      labelColor: '#5A6673' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Icon glyphs (original pictograms, not AWS trademarked artwork) ────────
// Each returns inner SVG markup for a 32x32 glyph centered at origin
// (drawn 0..32, caller translates). White stroke on the category-colored tile.
const ICONS = {
  ec2:        () => `<rect x="6" y="9" width="20" height="14" rx="1.5"/><rect x="9" y="12" width="14" height="8" rx="0.5" fill="none" stroke-width="1.4"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="2" y1="16" x2="6" y2="16"/><line x1="2" y1="20" x2="6" y2="20"/><line x1="26" y1="12" x2="30" y2="12"/><line x1="26" y1="16" x2="30" y2="16"/><line x1="26" y1="20" x2="30" y2="20"/>`,
  alb:        () => `<circle cx="16" cy="16" r="10" fill="none" stroke-width="1.6"/><path d="M9 16 L23 16 M16 9 L16 23 M11 11 L21 21 M21 11 L11 21" stroke-width="1.2"/>`,
  nat:        () => `<rect x="6" y="7" width="20" height="18" rx="2" fill="none" stroke-width="1.6"/><path d="M11 16 L21 16 M17 12 L21 16 L17 20" fill="none" stroke-width="1.6"/>`,
  igw:        () => `<circle cx="16" cy="16" r="10" fill="none" stroke-width="1.6"/><path d="M6 16 H26 M16 6 C11 10 11 22 16 26 C21 22 21 10 16 6 Z" fill="none" stroke-width="1.2"/>`,
  vpce:       () => `<rect x="8" y="8" width="16" height="16" rx="2" fill="none" stroke-width="1.6"/><circle cx="16" cy="16" r="3.4" fill="none" stroke-width="1.4"/>`,
  tgw:        () => `<circle cx="16" cy="16" r="4" fill="none" stroke-width="1.6"/><path d="M16 4 V12 M16 20 V28 M4 16 H12 M20 16 H28" stroke-width="1.4"/>`,
  eks:        () => `<path d="M16 5 L27 11 V21 L16 27 L5 21 V11 Z" fill="none" stroke-width="1.6"/><circle cx="16" cy="16" r="4" fill="none" stroke-width="1.4"/>`,
  eks_nodes:  () => `<rect x="5" y="9" width="9" height="9" rx="1" fill="none" stroke-width="1.4"/><rect x="18" y="9" width="9" height="9" rx="1" fill="none" stroke-width="1.4"/><rect x="11.5" y="17" width="9" height="9" rx="1" fill="none" stroke-width="1.4"/>`,
  ecs:        () => `<rect x="6" y="6" width="20" height="20" rx="2" fill="none" stroke-width="1.6"/><rect x="10" y="10" width="5" height="5" stroke-width="1.2"/><rect x="17" y="10" width="5" height="5" stroke-width="1.2"/><rect x="10" y="17" width="5" height="5" stroke-width="1.2"/><rect x="17" y="17" width="5" height="5" stroke-width="1.2"/>`,
  asg:        () => `<rect x="5" y="5" width="16" height="16" rx="2" fill="none" stroke-width="1.4"/><rect x="11" y="11" width="16" height="16" rx="2" fill="none" stroke-width="1.6"/>`,
  rds:        () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><path d="M6 16 C6 18.2 10.5 20 16 20 C21.5 20 26 18.2 26 16" fill="none" stroke-width="1.2"/>`,
  aurora:     () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><path d="M12 14 L16 19 L20 13" fill="none" stroke-width="1.4"/>`,
  cache:      () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><path d="M11 15 L16 11 L21 15 M11 20 L16 16 L21 20" fill="none" stroke-width="1.1"/>`,
  redshift:   () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><path d="M10 13 H22 M10 17 H22 M10 21 H22" stroke-width="1"/>`,
  docdb:      () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><path d="M16 13 C13 13 12 16 16 16 C20 16 19 19 16 19" fill="none" stroke-width="1.2"/>`,
  neptune:    () => `<ellipse cx="16" cy="9" rx="10" ry="4" fill="none" stroke-width="1.6"/><path d="M6 9 V23 C6 25.2 10.5 27 16 27 C21.5 27 26 25.2 26 23 V9" fill="none" stroke-width="1.6"/><circle cx="12" cy="16" r="1.6"/><circle cx="20" cy="16" r="1.6"/><circle cx="16" cy="20" r="1.6"/><path d="M12 16 L20 16 L16 20 Z" fill="none" stroke-width="1"/>`,
  dynamodb:   () => `<path d="M8 8 H24 L20 16 L24 24 H8 L12 16 Z" fill="none" stroke-width="1.6"/>`,
  s3:         () => `<path d="M8 9 C8 7 11.5 5.5 16 5.5 C20.5 5.5 24 7 24 9 V23 C24 25 20.5 26.5 16 26.5 C11.5 26.5 8 25 8 23 Z" fill="none" stroke-width="1.6"/><path d="M8 9 C8 11 11.5 12.5 16 12.5 C20.5 12.5 24 11 24 9" fill="none" stroke-width="1.2"/>`,
  efs:        () => `<rect x="7" y="6" width="18" height="20" rx="2" fill="none" stroke-width="1.6"/><path d="M11 11 H21 M11 16 H21 M11 21 H17" stroke-width="1.2"/>`,
  lambda:     () => `<path d="M11 6 L18 16 L11 26 M15 26 H23" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  cloudfront: () => `<circle cx="16" cy="16" r="10" fill="none" stroke-width="1.6"/><path d="M6 16 H26 M16 6 C11 10 11 22 16 26 C21 22 21 10 16 6 Z" fill="none" stroke-width="1"/><path d="M9 11 H23 M9 21 H23" stroke-width="1"/>`,
  waf:        () => `<path d="M16 5 L26 9 V16 C26 22 21.5 26.5 16 28 C10.5 26.5 6 22 6 16 V9 Z" fill="none" stroke-width="1.6"/><path d="M12 16 L15 19 L21 12" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  apigw:      () => `<rect x="6" y="12" width="8" height="8" rx="1.5" fill="none" stroke-width="1.5"/><rect x="18" y="12" width="8" height="8" rx="1.5" fill="none" stroke-width="1.5"/><path d="M14 16 H18" stroke-width="1.5"/><path d="M16 6 V12 M16 20 V26" stroke-width="1.2"/>`,
  route53:    () => `<circle cx="16" cy="16" r="10" fill="none" stroke-width="1.6"/><path d="M9 12 H23 M9 20 H23" stroke-width="1"/><ellipse cx="16" cy="16" rx="4.5" ry="10" fill="none" stroke-width="1"/>`,
  sns:        () => `<path d="M8 20 V13 C8 8.5 11.5 5 16 5 C20.5 5 24 8.5 24 13 V20" fill="none" stroke-width="1.6"/><path d="M6 20 H26 L23 25 H9 Z" fill="none" stroke-width="1.4"/>`,
  sqs:        () => `<rect x="7" y="10" width="18" height="13" rx="2" fill="none" stroke-width="1.6"/><path d="M7 11 L16 18 L25 11" fill="none" stroke-width="1.4"/>`,
  vpc:        () => `<rect x="5" y="9" width="22" height="14" rx="2" fill="none" stroke-width="1.6"/><path d="M5 13 H27 M11 9 V23 M19 9 V23" stroke-width="1"/>`,
  internet:   () => `<circle cx="16" cy="16" r="9" fill="none" stroke-width="1.6"/><path d="M7 16 H25 M16 7 C12 11 12 21 16 25 C20 21 20 11 16 7 Z" fill="none" stroke-width="1.2"/>`,
  default:    () => `<rect x="7" y="7" width="18" height="18" rx="3" fill="none" stroke-width="1.6"/>`,
};

function iconFor(kind) {
  return ICONS[kind] || ICONS.default;
}

// ── Layout primitives ───────────────────────────────────────────────────────
/** Packs fixed-size boxes into rows (grid), wrapping at maxPerRow. Mutates relX/relY on each item. */
function layoutGrid(items, { gap = GRID_GAP, maxPerRow = MAX_PER_ROW } = {}) {
  if (!items.length) return { w: 160, h: 46, empty: true };
  const perRow = Math.min(maxPerRow, items.length);
  let x = 0, y = 0, rowMaxH = 0, maxW = 0, col = 0;
  items.forEach(item => {
    item.relX = x; item.relY = y;
    rowMaxH = Math.max(rowMaxH, item.h);
    x += item.w + gap;
    col++;
    if (col >= perRow) {
      maxW = Math.max(maxW, x - gap);
      x = 0; y += rowMaxH + gap; rowMaxH = 0; col = 0;
    }
  });
  if (col !== 0) { maxW = Math.max(maxW, x - gap); y += rowMaxH; }
  else y -= gap;
  return { w: maxW, h: Math.max(y, items[0] ? items[0].h : 0) };
}

/** Stacks items vertically (column). Mutates relX/relY. */
function layoutColumn(items, { gap = 16 } = {}) {
  let y = 0;
  const w = Math.max(0, ...items.map(i => i.w));
  items.forEach(item => {
    item.relX = 0; item.relY = y;
    y += item.h + gap;
  });
  return { w, h: Math.max(0, y - gap) };
}

/** Places items side-by-side (row), top-aligned. Mutates relX/relY. */
function layoutRow(items, { gap = 20 } = {}) {
  let x = 0;
  const h = Math.max(0, ...items.map(i => i.h));
  items.forEach(item => {
    item.relX = x; item.relY = 0;
    x += item.w + gap;
  });
  return { w: Math.max(0, x - gap), h };
}

/** Rough text-width estimate (Segoe UI-ish average char width) for sizing containers to fit their label. */
function estimateTextWidth(text, fontSize) {
  return String(text).length * fontSize * 0.58;
}

/** Wraps a content box {w,h} with container padding/header, returns new {w,h} and content origin offsets.
 * `label`/`fontSize` (optional) widen the box so the header label never overflows a narrow container. */
function wrapContainer(content, kind, label, fontSize) {
  const pad = PAD[kind];
  const header = HEADER[kind];
  let w = content.w + pad * 2;
  if (label) {
    const minW = estimateTextWidth(label, fontSize || 12) + pad * 2 + 16;
    w = Math.max(w, minW);
  }
  return {
    w,
    h: content.h + header + pad * 2,
    contentDX: pad,
    contentDY: header + pad,
  };
}

// ── Tree builders ────────────────────────────────────────────────────────────
function leafFor(resourceNode) {
  return {
    kind: 'leaf',
    id: resourceNode.id,
    resource: resourceNode,
    w: NODE_W,
    h: NODE_H,
  };
}

function uncategorizedChip(item) {
  return {
    kind: 'chip',
    id: item.key,
    label: item.name,
    sub: item.type,
    w: 150,
    h: 40,
  };
}

function buildSubnetContainer(subnet, isPublic) {
  const children = subnet.resources.map(leafFor);
  const grid = layoutGrid(children);
  const label = `${isPublic ? 'Public' : 'Private'} Subnet: ${subnet.name}${subnet.cidr ? ' (' + subnet.cidr + ')' : ''}`;
  const wrapped = wrapContainer(grid, 'subnet', label, 11.5);
  return {
    kind: 'container',
    type: isPublic ? 'subnetPublic' : 'subnetPrivate',
    label: `${isPublic ? 'Public' : 'Private'} Subnet: ${subnet.name}${subnet.cidr ? ' (' + subnet.cidr + ')' : ''}`,
    w: wrapped.w, h: wrapped.h,
    contentDX: wrapped.contentDX, contentDY: wrapped.contentDY,
    children,
    empty: grid.empty,
  };
}

function buildAzContainer(az) {
  const subnetBoxes = [
    ...az.public_subnets.map(s => buildSubnetContainer(s, true)),
    ...az.private_subnets.map(s => buildSubnetContainer(s, false)),
  ];
  const col = layoutColumn(subnetBoxes, { gap: 16 });
  const azLabel = `Availability Zone: ${az.name}`;
  const wrapped = wrapContainer(col, 'az', azLabel, 11.5);
  return {
    kind: 'container',
    type: 'az',
    label: `Availability Zone: ${az.name}`,
    w: wrapped.w, h: wrapped.h,
    contentDX: wrapped.contentDX, contentDY: wrapped.contentDY,
    children: subnetBoxes,
  };
}

function buildVpcContainer(vpc) {
  const azBoxes = vpc.availability_zones.map(buildAzContainer);
  const azRow = layoutRow(azBoxes, { gap: 24 });

  const rows = [];
  let igwLeaf = null;
  if (vpc.igw) {
    igwLeaf = leafFor({ id: vpc.igw.id, kind: 'igw', category: 'networking', label: 'Internet Gateway', name: vpc.igw.label, external: false });
    rows.push(igwLeaf);
  }
  // igw row (if present) stacked above the AZ row
  let contentW = azRow.w, contentH = azRow.h;
  const children = [...azBoxes];
  if (igwLeaf) {
    igwLeaf.relX = Math.max(0, (azRow.w - igwLeaf.w) / 2);
    igwLeaf.relY = 0;
    const shiftY = igwLeaf.h + 16;
    azBoxes.forEach(b => { b.relY += shiftY; });
    contentH = azRow.h + shiftY;
    contentW = Math.max(azRow.w, igwLeaf.w);
    children.unshift(igwLeaf);
  }
  const vpcLabel = `VPC: ${vpc.name}${vpc.cidr ? ' (' + vpc.cidr + ')' : ''}`;
  const wrapped = wrapContainer({ w: contentW, h: contentH }, 'vpc', vpcLabel, 13);
  return {
    kind: 'container',
    type: 'vpc',
    label: `VPC: ${vpc.name}${vpc.cidr ? ' (' + vpc.cidr + ')' : ''}`,
    w: wrapped.w, h: wrapped.h,
    contentDX: wrapped.contentDX, contentDY: wrapped.contentDY,
    children,
  };
}

function buildRegionContainer(region) {
  const vpcBoxes = region.vpcs.map(buildVpcContainer);
  const vpcCol = layoutColumn(vpcBoxes, { gap: 24 });

  const children = [...vpcBoxes];
  let contentW = vpcCol.w, contentH = vpcCol.h;

  if (region.external_services.length) {
    const extLeaves = region.external_services.map(leafFor);
    const extGrid = layoutGrid(extLeaves, { maxPerRow: 6 });
    const extLabel = 'Managed / Global Services';
    const extW = Math.max(extGrid.w + PAD.subnet * 2, estimateTextWidth(extLabel, 11.5) + PAD.subnet * 2 + 16);
    const extBox = {
      kind: 'container', type: 'external', label: extLabel,
      w: extW, h: extGrid.h + HEADER.subnet + PAD.subnet * 2,
      contentDX: PAD.subnet, contentDY: HEADER.subnet + PAD.subnet,
      children: extLeaves,
    };
    extBox.relX = 0; extBox.relY = 0;
    vpcBoxes.forEach(b => { b.relY += extBox.h + 20; });
    contentH += extBox.h + 20;
    contentW = Math.max(contentW, extBox.w);
    children.unshift(extBox);
  }

  const regionLabel = `Region: ${region.name}`;
  const wrapped = wrapContainer({ w: contentW, h: contentH }, 'region', regionLabel, 13);
  return {
    kind: 'container',
    type: 'region',
    label: `Region: ${region.name}`,
    w: wrapped.w, h: wrapped.h,
    contentDX: wrapped.contentDX, contentDY: wrapped.contentDY,
    children,
  };
}

function buildCloudTree(model) {
  const regionBoxes = model.regions.map(buildRegionContainer);
  const regionCol = layoutColumn(regionBoxes, { gap: 26 });

  const children = [...regionBoxes];
  let contentW = regionCol.w, contentH = regionCol.h;

  if (model.uncategorized.length) {
    const chips = model.uncategorized.map(uncategorizedChip);
    const chipGrid = layoutGrid(chips, { maxPerRow: 5, gap: 10 });
    const bucketLabel = '⚠ Uncategorized Resources (not confidently placed)';
    const bucketW = Math.max(chipGrid.w + PAD.subnet * 2, estimateTextWidth(bucketLabel, 11.5) + PAD.subnet * 2 + 16);
    const bucket = {
      kind: 'container', type: 'bucket', label: bucketLabel,
      w: bucketW, h: chipGrid.h + HEADER.subnet + PAD.subnet * 2,
      contentDX: PAD.subnet, contentDY: HEADER.subnet + PAD.subnet,
      children: chips,
    };
    bucket.relX = 0; bucket.relY = 0;
    regionBoxes.forEach(b => { b.relY += bucket.h + 20; });
    contentH += bucket.h + 20;
    contentW = Math.max(contentW, bucket.w);
    children.unshift(bucket);
  }

  const wrapped = wrapContainer({ w: contentW, h: contentH }, 'cloud', 'AWS Cloud', 15);
  return {
    kind: 'container',
    type: 'cloud',
    label: 'AWS Cloud',
    w: wrapped.w, h: wrapped.h,
    contentDX: wrapped.contentDX, contentDY: wrapped.contentDY,
    children,
  };
}

// ── Absolute-position resolver (top-down) ───────────────────────────────────
function resolveAbsolute(node, originX, originY, absMap) {
  node.absX = originX + (node.relX || 0);
  node.absY = originY + (node.relY || 0);
  if (node.kind === 'leaf') {
    absMap[node.id] = { x: node.absX, y: node.absY, w: node.w, h: node.h, cx: node.absX + node.w / 2, cy: node.absY + node.h / 2 };
  } else if (node.kind === 'chip') {
    absMap[node.id] = { x: node.absX, y: node.absY, w: node.w, h: node.h, cx: node.absX + node.w / 2, cy: node.absY + node.h / 2 };
  } else if (node.kind === 'container') {
    absMap[`container:${node.label}`] = { x: node.absX, y: node.absY, w: node.w, h: node.h };
    const childOriginX = node.absX + node.contentDX;
    const childOriginY = node.absY + node.contentDY;
    (node.children || []).forEach(child => resolveAbsolute(child, childOriginX, childOriginY, absMap));
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderContainer(node) {
  const style = CONTAINER_STYLE[node.type] || CONTAINER_STYLE.region;
  let out = `<g>`;
  out += `<rect x="${node.absX}" y="${node.absY}" width="${node.w}" height="${node.h}" rx="10" `
    + `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.6" ${style.dash !== '0' ? `stroke-dasharray="${style.dash}"` : ''}/>`;
  out += `<text x="${node.absX + 12}" y="${node.absY + (node.type === 'cloud' ? 22 : 18)}" font-family="Segoe UI, Arial, sans-serif" `
    + `font-size="${node.type === 'cloud' ? 15 : node.type === 'region' || node.type === 'vpc' ? 13 : 11.5}" font-weight="700" `
    + `fill="${style.labelColor}">${esc(node.label)}</text>`;
  if (node.empty) {
    out += `<text x="${node.absX + node.w / 2}" y="${node.absY + node.h / 2 + 4}" text-anchor="middle" `
      + `font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#9CA3AF" font-style="italic">no resources</text>`;
  }
  (node.children || []).forEach(child => {
    if (child.kind === 'container') out += renderContainer(child);
    else if (child.kind === 'leaf') out += renderLeaf(child);
    else if (child.kind === 'chip') out += renderChip(child);
  });
  out += `</g>`;
  return out;
}

function wrapLabel(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    if ((cur + ' ' + w).trim().length > maxChars) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  });
  if (cur) lines.push(cur);
  return lines.slice(0, 2);
}

function renderLeaf(node) {
  const r = node.resource;
  const color = CATEGORY_COLOR[r.category] || '#7D8998';
  const iconSize = 32;
  const iconX = node.absX + (node.w - iconSize) / 2;
  const iconY = node.absY + 4;
  const lines = wrapLabel(r.name || r.label, 15);
  let out = `<g>`;
  out += `<rect x="${iconX - 5}" y="${iconY - 5}" width="${iconSize + 10}" height="${iconSize + 10}" rx="8" fill="${color}"/>`;
  out += `<g transform="translate(${iconX},${iconY})" fill="#FFFFFF" stroke="#FFFFFF">${iconFor(r.kind)()}</g>`;
  if (r.count > 1) {
    out += `<circle cx="${iconX + iconSize + 2}" cy="${iconY - 2}" r="9" fill="#232F3E"/>`;
    out += `<text x="${iconX + iconSize + 2}" y="${iconY + 1.5}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10" font-weight="700" fill="#fff">×${r.count}</text>`;
  }
  if (r.eip) {
    const bx = iconX + iconSize + 2, by = iconY + iconSize + 4;
    out += `<title>Elastic IP: ${esc(r.eip)}</title>`;
    out += `<rect x="${bx - 13}" y="${by - 7}" width="26" height="13" rx="6.5" fill="#0C5A87"/>`;
    out += `<text x="${bx}" y="${by + 3}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="8" font-weight="700" fill="#fff">EIP</text>`;
  }
  const textY = iconY + iconSize + 14;
  lines.forEach((line, idx) => {
    out += `<text x="${node.absX + node.w / 2}" y="${textY + idx * 12}" text-anchor="middle" `
      + `font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="600" fill="#232F3E">${esc(line)}</text>`;
  });
  out += `<text x="${node.absX + node.w / 2}" y="${textY + lines.length * 12 + 1}" text-anchor="middle" `
    + `font-family="Segoe UI, Arial, sans-serif" font-size="8.5" fill="#8892A0">${esc(r.label)}</text>`;
  out += `</g>`;
  return out;
}

function renderChip(node) {
  let out = `<g>`;
  out += `<rect x="${node.absX}" y="${node.absY}" width="${node.w}" height="${node.h}" rx="6" fill="#FFFFFF" stroke="#D6A85B" stroke-width="1.2"/>`;
  out += `<text x="${node.absX + node.w / 2}" y="${node.absY + 16}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="700" fill="#92600F">${esc(node.label)}</text>`;
  out += `<text x="${node.absX + node.w / 2}" y="${node.absY + 30}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="#A16207">${esc(node.sub)}</text>`;
  out += `</g>`;
  return out;
}

// Clips a ray from box center toward (dx,dy) to the box's rectangle boundary.
function clipToRect(box, dx, dy) {
  const hw = box.w / 2, hh = box.h / 2;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  const scaleX = dx !== 0 ? Math.abs(hw / dx) : Infinity;
  const scaleY = dy !== 0 ? Math.abs(hh / dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: box.cx + dx * scale, y: box.cy + dy * scale };
}

function renderEdges(connections, absMap, clientBox) {
  let out = '';
  connections.forEach((edge, idx) => {
    const fromBox = edge.from === 'internet' ? clientBox : absMap[edge.from];
    const toBox = edge.to === 'internet' ? clientBox : absMap[edge.to];
    if (!fromBox || !toBox) return; // unresolved endpoint (shouldn't normally happen)
    const dx = toBox.cx - fromBox.cx, dy = toBox.cy - fromBox.cy;
    const start = clipToRect(fromBox, dx, dy);
    const end = clipToRect(toBox, -dx, -dy);
    const dashed = edge.style === 'dashed';
    const stroke = dashed ? '#94A3B8' : '#475569';
    out += `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" `
      + `stroke="${stroke}" stroke-width="1.6" ${dashed ? 'stroke-dasharray="5,4"' : ''} marker-end="url(#arrow${dashed ? 'Dashed' : ''})" opacity="${dashed ? 0.85 : 1}"/>`;
    if (edge.label) {
      const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
      const labelW = Math.min(160, edge.label.length * 5.6 + 10);
      out += `<rect x="${(mx - labelW / 2).toFixed(1)}" y="${(my - 8).toFixed(1)}" width="${labelW.toFixed(1)}" height="15" rx="3" fill="#FFFFFF" opacity="0.92"/>`;
      out += `<text x="${mx.toFixed(1)}" y="${(my + 3.5).toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9.5" fill="${dashed ? '#64748B' : '#334155'}">${esc(edge.label)}</text>`;
    }
    void idx;
  });
  return out;
}

/**
 * Renders the full architecture model to a self-contained SVG string.
 * Returns { svg, width, height }.
 */
function renderArchitectureSvg(model) {
  const cloud = buildCloudTree(model);

  const clientLeaf = { kind: 'leaf', id: 'internet', resource: { id: 'internet', kind: 'internet', category: 'client', label: 'Client', name: model.client.label, count: 1 }, w: 130, h: 90 };

  const MARGIN = 30;
  const clientGap = 60;

  const totalW = cloud.w + MARGIN * 2;
  const totalH = clientLeaf.h + clientGap + cloud.h + MARGIN * 2;

  const absMap = {};
  clientLeaf.absX = MARGIN + (cloud.w - clientLeaf.w) / 2;
  clientLeaf.absY = MARGIN;
  absMap.internet = { x: clientLeaf.absX, y: clientLeaf.absY, w: clientLeaf.w, h: clientLeaf.h, cx: clientLeaf.absX + clientLeaf.w / 2, cy: clientLeaf.absY + clientLeaf.h / 2 };

  resolveAbsolute(cloud, MARGIN, MARGIN + clientLeaf.h + clientGap, absMap);

  // Paint order matters here: SVG elements later in the document sit on
  // top. Containers (VPC/AZ/subnet boxes) are drawn with opaque fills, so
  // edges must be painted AFTER them, not before — otherwise every
  // connection line ends up completely hidden underneath the next
  // container's background (this was silently swallowing every edge,
  // including the pre-existing NAT edge, regardless of how many
  // connections the model computed).
  let body = '';
  body += renderContainer(cloud);
  body += renderLeaf(clientLeaf);
  body += renderEdges(model.connections, absMap, absMap.internet);

  const defs = `<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 Z" fill="#475569"/>
    </marker>
    <marker id="arrowDashed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 Z" fill="#94A3B8"/>
    </marker>
  </defs>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW.toFixed(0)} ${totalH.toFixed(0)}" width="${totalW.toFixed(0)}" height="${totalH.toFixed(0)}" font-family="Segoe UI, Arial, sans-serif">`
    + `<rect x="0" y="0" width="${totalW.toFixed(0)}" height="${totalH.toFixed(0)}" fill="#FFFFFF"/>`
    + defs + body + `</svg>`;

  return { svg, width: totalW, height: totalH };
}

module.exports = { renderArchitectureSvg, buildCloudTree, resolveAbsolute, CATEGORY_COLOR };
