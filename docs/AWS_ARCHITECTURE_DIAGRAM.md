# AWS Architecture Diagram Generator

Generates a professional, AWS-reference-style architecture diagram directly
from Terraform HCL — either the project's own generated code, pasted HCL, or
uploaded `.tf` files. Available as a new **"AWS Diagram"** tab in the Studio
builder.

## What it does

1. **Parses** the Terraform (a dependency-free, brace-aware HCL parser —
   no HCL2 grammar library required).
2. **Maps** recognized `aws_*` resources into an architecture category
   (compute / networking / database / storage / security / edge /
   integration) and **infers topology**:
   - public vs. private subnet, by walking route table associations to an
     Internet Gateway (or NAT Gateway) — not just a hardcoded guess
   - Availability Zone grouping (synthetic `AZ-N` buckets when the AZ isn't
     a literal string, e.g. it comes from a data source)
   - resource → subnet placement, including one-hop indirection through
     `aws_db_subnet_group` / `aws_elasticache_subnet_group`
   - traffic flow: client → CloudFront/WAF/API Gateway/ALB → target
     group/ASG/ECS/EKS → database, NAT egress for private subnets, etc.
   - anything it can't confidently place is shown in an **"Uncategorized
     Resources"** bucket instead of being silently dropped or guessed at
3. **Renders** the model as:
   - an inline SVG (AWS Cloud → Region → VPC → AZ → Subnet nesting, with
     solid arrows for explicit references and dashed arrows for inferred
     "same tier/VPC" connections — the diagram is honest about which is
     which)
   - a Draw.io / diagrams.net `.drawio` file, using the **official
     `mxgraph.aws4.*`** shape names so it opens with real AWS icons (that
     artwork ships with diagrams.net itself — we only reference it by
     name, we never embed AWS's icon files)
4. **Exports** to SVG, PNG, PDF, and Draw.io — all generated client-side
   with zero new npm dependencies (PNG via `<canvas>`, PDF via a ~100-line
   hand-rolled single-page PDF that embeds a JPEG raster directly with
   `/Filter /DCTDecode`, no PDF library needed).

## Files added

```
backend/services/hclArchParser.js     Brace-aware HCL parser (no deps)
backend/services/architectureMapper.js  Resource→category mapping + topology inference
backend/services/architectureSvg.js     Box-packing layout engine + SVG renderer
backend/services/architectureDrawio.js  .drawio (mxGraph) XML exporter
backend/routes/diagram.js               POST /api/diagram/generate
frontend/src/components/ArchitectureDiagram.jsx  Studio panel (input modes, zoom/pan, export)
frontend/src/utils/svgExport.js         Client-side SVG→PNG/PDF/drawio download helpers
```

Plus small integration edits: `server.js` (route mount), `api/client.js`
(`diagramAPI`), `pages/Builder.jsx` (new "AWS Diagram" tab).

## Scoping decisions (MVP, per the original feature spec)

- **Icons**: the inline SVG preview uses original pictograms in AWS's
  well-known category colors (compute=orange, database=blue, etc.), not
  AWS's trademarked icon artwork — that's not ours to reproduce, and isn't
  fetchable at render time in this environment anyway. The Draw.io export
  is where you get pixel-accurate official AWS icons, since diagrams.net
  supplies that shape library locally.
- **Persistence**: diagrams aren't saved server-side (no new DB table) —
  generation is fast and stateless, so "regenerate on demand" was chosen
  over a `GET /api/diagrams/:id` + storage layer. This was explicitly
  "out of scope for MVP" in the spec.
- **Multi-region**: supported in the data model and mapper (provider
  aliases → region), and the renderer stacks multiple regions vertically,
  but it's lightly tested compared to the single-region path.
- **Tier-to-tier data edges** (e.g. "app talks to RDS") are drawn as
  dashed **inferred** edges when there's no explicit HCL reference tying
  them together (Terraform rarely encodes "my app calls this database" as
  an attribute) — solid edges are reserved for connections backed by an
  actual reference in the HCL (listener → target group → instance, SG
  sharing, route-table walks, etc.).

## Known limitations

- `count`/`for_each` expansion only resolves AZ names when the underlying
  list is a literal or a variable's literal default; `for_each` over
  another resource's own instances (`for_each = aws_subnet.public`,
  referencing `each.value.id`) isn't resolved — that's a deeper level of
  cross-resource evaluation than this parser attempts.
- Draw.io `mxgraph.aws4.*` stencil names are best-effort; if diagrams.net
  renames one in a future version, that specific shape falls back to a
  generic placeholder — grouping, labels, and colors are unaffected.
- Modules aren't resolved/expanded (their internal resources aren't
  visited); a module shows up only if it directly declares recognized
  resources at the root level being parsed.

## Changelog

**Fix — count/for_each expansion, AZ/public-subnet inference, parser hardening**

Testing surfaced two real gaps and one real parser bug:

1. **`count`/`for_each` weren't expanded.** A `count = 2` subnet block
   showed as one subnet, not two, and `count.index`/`each.key`/
   `each.value` were left as literal text in tags and expressions instead
   of being substituted. Now each instance is expanded into its own
   resource (`aws_subnet.public[0]`, `aws_subnet.public["us-east-1a"]`,
   etc.), with those tokens substituted per-instance — including inside
   `element(var.azs, count.index)`-style AZ expressions, which now resolve
   to the *real* AZ name when the list is a literal or a variable's
   literal default. `[*]` splat references (`aws_subnet.public[*].id`, the
   standard way to feed count-expanded subnets into an ALB) now resolve to
   every instance instead of nothing.
2. **Subnets with no route table info always fell back to "private",
   even when a NAT Gateway or an internet-facing Load Balancer was sitting
   right there.** Public/private inference now also checks: does this
   subnet host a NAT Gateway (which can only ever be public), or is it
   referenced by an internet-facing ALB's `subnets`/`subnet_mapping`? That
   alone fixes the most visually confusing symptom — a subnet named
   `public_a` rendering as "Private Subnet: public_a".
3. **When a subnet has zero AZ signal at all** (no literal, no resolvable
   expression), it now gets paired with same-tier subnets by declaration
   order — the 1st public subnet with the 1st private subnet, etc. —
   instead of every subnet landing in its own disconnected AZ box. Labeled
   "AZ-N (inferred by position)" so it reads as a best guess, not a fact.
4. **Parser bug**: several `key = value` attributes crammed onto one
   source line without a newline between them (invalid HCL, but harmless
   in real `terraform` since it just errors loudly) were silently merged
   into one garbled expression by the bare-expression scanner, quietly
   corrupting whichever attribute came first on that line. The scanner now
   also stops at the start of a new `identifier =` assignment even
   mid-line, so a malformed/compacted paste degrades gracefully instead of
   corrupting unrelated fields.

All four together were responsible for a real repro case: a hand-written
script with `count`-free, AZ-free, route-table-free subnets and an ALB
whose attributes happened to be crammed onto one line rendered every
subnet as private, in four disconnected "AZ-N (inferred)" boxes. Same
input now correctly shows two AZs with the public/private subnets paired
correctly and the ALB's subnets labeled public.
