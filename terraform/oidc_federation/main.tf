# =============================================================================
# terraform/oidc_federation/main.tf
# Phase 5 — OIDC Federation: eliminate static AWS_ACCESS_KEY_ID credentials
# =============================================================================
#
# This replaces long-lived AWS keys in:
#   • CI/CD pipelines (GitHub Actions)
#   • EKS pods running the TFGen worker (Kubernetes Service Account → IRSA)
#
# After applying:
#   1. GitHub Actions: use role ARN in workflow → no keys in secrets
#   2. EKS:            annotate ServiceAccount → pod assumes role via IRSA
#
# Prerequisites:
#   terraform init && terraform apply
#   (needs bootstrap credentials once — then they can be deleted)
#
# =============================================================================

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "github_org" {
  description = "GitHub organisation or username (e.g. my-org)"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (e.g. tfgen)"
  type        = string
}

variable "github_branch" {
  description = "Branch allowed to assume the CI role (use * for all branches)"
  type        = string
  default     = "main"
}

variable "eks_cluster_name" {
  description = "EKS cluster name (leave blank to skip IRSA)"
  type        = string
  default     = ""
}

variable "k8s_namespace" {
  description = "Kubernetes namespace for TFGen worker"
  type        = string
  default     = "tfgen"
}

variable "k8s_service_account" {
  description = "Kubernetes ServiceAccount name for TFGen worker"
  type        = string
  default     = "tfgen-worker"
}

variable "tfgen_permissions" {
  description = "Additional IAM managed policy ARNs to attach to both roles"
  type        = list(string)
  default     = []
}

provider "aws" {
  region = var.aws_region
}

# ── Data sources ──────────────────────────────────────────────────────────────
data "aws_caller_identity" "current" {}
data "aws_region"          "current" {}

# ── GitHub Actions OIDC Provider ─────────────────────────────────────────────
# Fetches the GitHub OIDC TLS thumbprint automatically so it never goes stale
data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]

  thumbprint_list = [
    data.tls_certificate.github_actions.certificates[0].sha1_fingerprint
  ]

  tags = {
    Name      = "github-actions-oidc"
    ManagedBy = "terraform"
    Project   = "tfgen"
  }
}

# ── IAM Role — GitHub Actions CI/CD ──────────────────────────────────────────
resource "aws_iam_role" "github_actions" {
  name        = "tfgen-github-actions"
  description = "Assumed by GitHub Actions via OIDC — no static keys needed"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowGitHubActionsOIDC"
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Restricts to a specific repo + branch.
            # Use "${var.github_org}/${var.github_repo}:*" to allow all events.
            "token.actions.githubusercontent.com:sub" = "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/${var.github_branch}"
          }
        }
      }
    ]
  })

  tags = {
    Name      = "tfgen-github-actions"
    ManagedBy = "terraform"
    Project   = "tfgen"
  }
}

# Inline policy granting exactly the permissions TFGen CI needs
resource "aws_iam_role_policy" "github_actions_tfgen" {
  name = "tfgen-ci-permissions"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ECR: push/pull container images
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRImagePush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:GetRepositoryPolicy",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        # Tighten this to your specific ECR repo ARNs in production
        Resource = "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/tfgen*"
      },
      # EKS: update kubeconfig + rolling deploys
      {
        Sid    = "EKSAccess"
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters",
        ]
        Resource = "*"
      },
      # S3: store Terraform state (if using S3 backend)
      {
        Sid    = "TerraformStateS3"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
        ]
        Resource = [
          "arn:aws:s3:::tfgen-terraform-state-*",
          "arn:aws:s3:::tfgen-terraform-state-*/*",
        ]
      },
      # DynamoDB: Terraform state locking
      {
        Sid    = "TerraformStateLock"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ]
        Resource = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/tfgen-terraform-locks"
      },
    ]
  })
}

# Attach any extra managed policies (e.g. ReadOnlyAccess for plan-only runs)
resource "aws_iam_role_policy_attachment" "github_actions_extra" {
  for_each   = toset(var.tfgen_permissions)
  role       = aws_iam_role.github_actions.name
  policy_arn = each.value
}

# ── IRSA: EKS Pod Identity (optional — skipped if eks_cluster_name is blank) ──
locals {
  create_irsa = var.eks_cluster_name != ""
}

data "aws_eks_cluster" "tfgen" {
  count = local.create_irsa ? 1 : 0
  name  = var.eks_cluster_name
}

resource "aws_iam_openid_connect_provider" "eks" {
  count = local.create_irsa ? 1 : 0
  url   = data.aws_eks_cluster.tfgen[0].identity[0].oidc[0].issuer

  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]

  tags = {
    Name      = "eks-oidc-${var.eks_cluster_name}"
    ManagedBy = "terraform"
    Project   = "tfgen"
  }
}

resource "aws_iam_role" "tfgen_worker" {
  count       = local.create_irsa ? 1 : 0
  name        = "tfgen-worker-irsa"
  description = "Assumed by TFGen worker pods via IRSA — no static keys in pods"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EKSIRSAAssumeRole"
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.eks[0].arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${replace(data.aws_eks_cluster.tfgen[0].identity[0].oidc[0].issuer, "https://", "")}:sub" = "system:serviceaccount:${var.k8s_namespace}:${var.k8s_service_account}"
            "${replace(data.aws_eks_cluster.tfgen[0].identity[0].oidc[0].issuer, "https://", "")}:aud" = "sts.amazonaws.com"
          }
        }
      }
    ]
  })

  tags = {
    Name      = "tfgen-worker-irsa"
    ManagedBy = "terraform"
    Project   = "tfgen"
  }
}

resource "aws_iam_role_policy" "tfgen_worker_permissions" {
  count = local.create_irsa ? 1 : 0
  name  = "tfgen-worker-permissions"
  role  = aws_iam_role.tfgen_worker[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # TFGen worker needs STS to generate short-lived tokens for customer accounts
      {
        Sid      = "STSAssumeRole"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole", "sts:GetCallerIdentity"]
        Resource = "*"
      },
      # Read secrets from Secrets Manager (DB password, etc.)
      {
        Sid    = "SecretsManager"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:tfgen/*"
      },
      # SSM Parameter Store for config
      {
        Sid    = "SSMParameters"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/tfgen/*"
      },
    ]
  })
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "github_actions_role_arn" {
  description = "ARN to use in GitHub Actions workflow: role-to-assume"
  value       = aws_iam_role.github_actions.arn
}

output "github_actions_oidc_provider_arn" {
  description = "OIDC provider ARN for GitHub Actions"
  value       = aws_iam_openid_connect_provider.github_actions.arn
}

output "tfgen_worker_role_arn" {
  description = "IRSA role ARN — annotate the K8s ServiceAccount with this"
  value       = local.create_irsa ? aws_iam_role.tfgen_worker[0].arn : "IRSA disabled (set eks_cluster_name)"
}

output "k8s_service_account_annotation" {
  description = "Annotation to add to Kubernetes ServiceAccount for IRSA"
  value       = local.create_irsa ? "eks.amazonaws.com/role-arn: ${aws_iam_role.tfgen_worker[0].arn}" : "IRSA disabled"
}
