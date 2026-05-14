# TFGen — Terraform AWS Script Generator

> A full-stack visual tool for generating production-ready Terraform HCL for AWS,  
> aligned with the **AWS Cloud Learning Roadmap** (DevOps + SysOps paths).

## UI Preview

![TFGen Builder UI](docs/ui-preview.svg)

The Builder has three panels:
- **Left** — 34 AWS services in 9 colour-coded categories (search + MOD badges)
- **Centre** — config fields with roadmap step badge, AMI search, module help guide
- **Right** — live syntax-highlighted `main.tf` output + inline validate / fmt results

---

## Services included

| Category | Services |
|---|---|
| **Compute** | EC2, Auto Scaling Group, ALB, Lambda |
| **Storage** | S3, EBS Volume, EFS |
| **Networking** | VPC, Subnet, Security Group, Internet Gateway, NAT Gateway, Route Table, Route 53, CloudFront |
| **Database** | RDS, DynamoDB, ElastiCache |
| **IAM & Security** | IAM Role, IAM User, IAM Policy, IAM Group, KMS Key, Secrets Manager |
| **Monitoring** | CloudWatch Alarm, CloudWatch Log Group, SNS Topic, SQS Queue, EventBridge Rule |
| **Containers** | EKS Cluster, ECS Cluster, ECR Repository |
| **CI/CD** | CodePipeline, CodeBuild, CodeDeploy, API Gateway |
| **Admin & Ops** | SSM Parameter Store, AWS Backup, CloudTrail, GuardDuty, WAF, AWS Budget, Config Rule, Transit Gateway |

Services with a **MOD** badge support official Terraform Registry module mode with built-in guidance.

---

## Local Installation (no Docker)

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | https://nodejs.org |
| PostgreSQL | ≥ 13 | https://www.postgresql.org/download |
| Terraform CLI | ≥ 1.5 | See below |
| Git | any | https://git-scm.com |

---

### Step 1 — Install Terraform CLI (required for fmt + validate)

**Ubuntu / Debian:**
```bash
wget -O- https://apt.releases.hashicorp.com/gpg | \
  sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg

echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" | \
  sudo tee /etc/apt/sources.list.d/hashicorp.list

sudo apt update && sudo apt install -y terraform
terraform version   # should print v1.x.x
```

**macOS (Homebrew):**
```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
terraform version
```

**Windows:**
Download the installer from https://developer.hashicorp.com/terraform/install and add to PATH.

---

### Step 2 — Set up PostgreSQL

```bash
# Connect as the postgres superuser
sudo -u postgres psql

# Inside psql — run these four lines:
CREATE USER tfgen WITH PASSWORD 'tfgen123';
CREATE DATABASE terraform_generator OWNER tfgen;
GRANT ALL PRIVILEGES ON DATABASE terraform_generator TO tfgen;
\q
```

Apply the schema and seed data:
```bash
# From the project root
psql -U tfgen -h localhost -d terraform_generator -f database/schema.sql
psql -U tfgen -h localhost -d terraform_generator -f database/seed.sql

# You should see "INSERT 0 1" repeated for each service template
```

Verify the seed loaded:
```bash
psql -U tfgen -h localhost -d terraform_generator \
  -c "SELECT service_type, label, category FROM templates ORDER BY category, label;"
# Should list all 34 services
```

---

### Step 3 — Configure and start the Backend

```bash
cd backend
npm install

# Copy the example env file and edit it
cp .env.example .env
```

Edit `backend/.env`:
```env
PORT=4000
HOST=0.0.0.0
DATABASE_URL=postgresql://tfgen:tfgen123@localhost:5432/terraform_generator

# Allow requests from your frontend (change IP if running on a server)
CORS_ORIGIN=http://localhost:3000

# Optional — enables live AMI search from AWS API
# AWS_ACCESS_KEY_ID=AKIA...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=ap-south-1
```

Start the backend:
```bash
npm start          # production
# or
npm run dev        # auto-reload with nodemon (dev only)
```

You should see:
```
✅ Backend running on http://0.0.0.0:4000
   CORS origin: http://localhost:3000
   DB: ✓ configured
```

Verify the API is working:
```bash
curl http://localhost:4000/api/health
# {"status":"ok","time":"..."}

curl http://localhost:4000/api/templates | python3 -m json.tool | head -30
# Should list all 34 templates
```

---

### Step 4 — Configure and start the Frontend

```bash
cd frontend
npm install

# Edit the API URL — must match where your backend is running
```

Edit `frontend/.env`:
```env
# Local dev (both on same machine):
REACT_APP_API_URL=http://localhost:4000

# If backend is on a different server/IP:
# REACT_APP_API_URL=http://192.168.1.100:4000
```

Start the dev server:
```bash
npm start
# Opens http://localhost:3000 automatically
```

---

### Step 5 — Open the app

Go to **http://localhost:3000** in your browser.

1. Click **New Project** on the Dashboard
2. Enter a name, pick **Mumbai (ap-south-1)**, set environment to **dev**
3. Click **Create & Open** → you land in the Builder
4. Click any service from the left panel (e.g. VPC) to start configuring

---

### Running on a remote server

If the app runs on a server (not localhost), update these two values:

`backend/.env`:
```env
CORS_ORIGIN=http://<SERVER_IP>:3000
```

`frontend/.env`:
```env
REACT_APP_API_URL=http://<SERVER_IP>:4000
```

Then rebuild the frontend after changing the env:
```bash
cd frontend && npm run build
# Serve the build folder with any static server:
npx serve -s build -l 3000
```

---

### Firewall — open required ports

```bash
# Ubuntu/ufw
sudo ufw allow 3000   # frontend
sudo ufw allow 4000   # backend API
sudo ufw reload
```

---

### terraform fmt and terraform validate

Both features require the Terraform CLI on the **backend server** (Step 1).

- **fmt** — runs instantly, no providers needed, purely syntactic.
- **validate** — downloads the AWS provider on first run (~60 MB).  
  It is cached at `/tmp/tfgen-plugin-cache` and reused on every future call — subsequent validate runs are fast.

---

### AMI Search

- The dropdown opens on click with a **curated list** for your project region — works without AWS credentials.
- Type a keyword (e.g. `ubuntu`, `amazon linux`) and press **Search**.
- With AWS credentials in `backend/.env`, results come **live from the AWS API**.

---

### Module mode

Toggle **Module** on any service with a **MOD** badge. A help panel expands with:
- Official Terraform Registry `source` and `version`
- Key input descriptions for that module
- A production tip
- Direct link to the registry page

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot reach backend` on Dashboard | Check backend is running on port 4000; check `REACT_APP_API_URL` in `frontend/.env` |
| `CORS error` in browser console | Set `CORS_ORIGIN=http://<your-frontend-origin>` in `backend/.env` and restart backend |
| `relation "templates" does not exist` | Re-run `psql ... -f database/schema.sql` then `database/seed.sql` |
| Validate says "Terraform CLI not found" | Install Terraform CLI on the machine running the backend (Step 1) |
| AMI search shows "No AMIs found" | Normal without AWS credentials — curated list is shown. Add `AWS_ACCESS_KEY_ID` etc. to `backend/.env` for live results |
| Port 5432 refused | PostgreSQL not running — `sudo systemctl start postgresql` |

---

## AWS Roadmap alignment

| Roadmap Step | Services to practise |
|---|---|
| Step 2 — IAM first | IAM Role, User, Policy, Group, KMS Key |
| Step 3 — VPC deep dive | VPC, Subnet, Security Group, IGW, NAT Gateway, Route Table |
| Step 4–5 — Compute + Storage | EC2, Auto Scaling, ALB, S3, EBS, EFS |
| Step 6 — Databases | RDS, DynamoDB, ElastiCache |
| Step 7 — Monitoring | CloudWatch Alarm, Log Group, SNS, SQS, EventBridge |
| Step 9 DevOps — CI/CD | CodePipeline, CodeBuild, CodeDeploy, API Gateway |
| Step 10 DevOps — Containers | ECS, EKS, ECR |
| Step 11 — Serverless | Lambda, EventBridge |
| Step 12 — Security | Secrets Manager, KMS, WAF |
| Admin path — Ops | SSM, Backup, CloudTrail, GuardDuty, Config, Budget, Transit GW |
