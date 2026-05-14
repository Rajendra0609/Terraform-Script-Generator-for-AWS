# TFGen — Completed & Remaining

## ✅ Completed in this update

- [x] terraform fmt fixed — no longer calls terraform init (purely syntactic)
- [x] terraform validate fixed — uses shared plugin cache (/tmp/tfgen-plugin-cache) so provider downloads once
- [x] AMI search fixed — opens with curated list immediately, search works without credentials, live AWS API used when credentials available
- [x] All AWS services added (34 total across 9 categories aligned to the roadmap)
- [x] Module help panel — appears when Module mode is ON, shows source, version, key inputs, pro tip, registry link
- [x] Roadmap badge in ConfigPanel — shows which learning step each service maps to
- [x] ServiceSelector — search, category grouping with accent colors, MOD badge on module-capable services
- [x] index.css — full styles (not just Tailwind directives)
- [x] README — complete quick-start for server (non-Docker) mode

## 🔲 Future ideas

- [ ] Multi-resource dependency wiring (e.g. EC2 auto-fills subnet_id from VPC)
- [ ] Terraform plan simulation (dry-run output preview)
- [ ] Export as zip (main.tf + variables.tf + outputs.tf split)
- [ ] Team/auth support (currently no login required)
- [ ] Dark/light theme toggle
