# AWS Services Overview

> High-level reference for the Vexillo feature-flag service deployment.
> Infrastructure is defined as code in `infra/lib/vexillo-stack.ts` using **AWS CDK v2**.

---

## Services at a Glance

| Service | Role |
|---|---|
| **CloudFront** | Global CDN. Serves the SPA and proxies all `/api/*` traffic to the ALB. Enforces HTTPS, applies security response headers (CSP, HSTS, X-Frame-Options), and caches the flag snapshot endpoint for 5 minutes. Restricted to `PriceClass_100` (US, Canada, Europe). |
| **S3** | Hosts the compiled Vite SPA. Bucket is fully private; CloudFront accesses it via Origin Access Control (OAC). |
| **Application Load Balancer** | Public-facing load balancer that routes HTTP traffic from CloudFront to the ECS Fargate tasks. |
| **ECS Fargate** | Runs the Hono API as a containerized workload. Cluster: `vexillo`. Service: `vexillo-api`. Auto-scales 2–4 tasks based on CPU utilization (target 65%). Uses a Spot mix — 1 on-demand task always running, remaining tasks on Fargate Spot (up to 70% cheaper). Container stop timeout is 120 s to allow SSE connections to drain on interruption. No EC2 instances to manage. |
| **ECR** | Private Docker image registry (`vexillo-api`). CI/CD pushes images here on every merge to `main`. Lifecycle policy retains the last 10 images. |
| **RDS (PostgreSQL 16)** | Primary datastore. Instance class `t4g.micro`, deployed in an isolated (no-internet) subnet. Storage encrypted at rest. Automated backups retained for 7 days. Provisioned in the primary region (`us-east-1`) only. |
| **VPC** | Dedicated VPC spanning 2 Availability Zones. Public subnets for ECS tasks and ALB; isolated subnets for RDS. No NAT Gateway — ECS tasks reach ECR and SSM directly via public IPs and security groups. |
| **SSM Parameter Store** | Stores all application configuration and secrets. Plain strings (URLs, allowed origins, admin emails) are `String` type; sensitive values (database URL, auth secret, API keys, cross-region shared secret) are `SecureString`. ECS injects these as environment variables at task startup. |
| **Secrets Manager** | Holds the auto-generated RDS master credentials (`/vexillo/rds-credentials`). Used by ECS tasks at runtime to authenticate with the database. |
| **IAM** | Two ECS roles: an *execution role* (pulls images from ECR, reads SSM parameters, writes CloudWatch logs) and a *task role* (reads RDS credentials from Secrets Manager at runtime). A separate `vexillo-deploy` IAM user with a minimal policy handles CI/CD. |
| **CloudWatch Logs** | Captures all ECS container logs to log group `/vexillo/api`. Retention: 7 days. Only errors are logged — no per-request access logs. |
| **CloudFormation** | CDK synthesizes and deploys all resources as a single stack (`VexilloStack`) per region. |

---

## Architecture Topology

```
Internet
  │
  ▼
CloudFront (global edge)
  ├── default  →  S3 (SPA assets, OAC)
  ├── /api/sdk/flags          →  ALB  →  ECS Fargate  (5-min CloudFront cache)
  ├── /api/sdk/flags/stream   →  ALB  →  ECS Fargate  (no cache, SSE passthrough)
  └── /api/*                  →  ALB  →  ECS Fargate  (no cache)
                                              │
                                              ├── SSM Parameter Store  (env vars at startup)
                                              ├── Secrets Manager      (RDS credentials)
                                              └── RDS PostgreSQL       (isolated subnet)
```

---

## Multi-Region

- **Primary region (`us-east-1`):** Full stack — CloudFront, S3, ALB, ECS, RDS.
- **Secondary regions (`eu-west-1`, etc.):** CloudFront, S3, ALB, ECS only. No RDS; ECS tasks connect to the primary RDS cross-region via `DATABASE_URL`. On a flag change, the primary fans out a signed `POST /internal/flag-change` to each secondary ALB.

---

## CI/CD Pipeline

Managed by GitHub Actions (`.github/workflows/deploy.yml`). On push to `main`:

1. Builds the API Docker image and pushes it to **ECR**.
2. Registers a new ECS task definition revision (same config, new image tag) and calls `ecs update-service`.
3. Builds the Vite SPA, syncs static assets to **S3**, and creates a **CloudFront** cache invalidation.

The deploy IAM user has the minimum permissions needed: ECR push, ECS service update, S3 sync, and CloudFront invalidation.

---

## Security Highlights

- RDS is in an isolated subnet with no internet route; only ECS tasks can reach port 5432 via security group rules.
- All secrets are in SSM Parameter Store (`SecureString`) or Secrets Manager — no plaintext credentials in environment variables or Docker images.
- CloudFront enforces TLS 1.2+ and adds a strict Content Security Policy, HSTS, and `X-Frame-Options: DENY` to every SPA response.
- ECS tasks have no NAT Gateway; outbound traffic to AWS APIs (ECR, SSM, CloudWatch) uses VPC endpoints implicitly via public IPs within the VPC.
- CI/CD uses a dedicated IAM user with a least-privilege inline policy (`infra/iam-deploy-policy.json`).
