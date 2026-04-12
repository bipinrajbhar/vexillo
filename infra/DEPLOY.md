# Deploying Vexillo to AWS

## Architecture

```
CloudFront (HTTPS)
├── /api/sdk/flags  ──► ALB ──► ECS Fargate (30s cache)
├── /api/*          ──► ALB ──► ECS Fargate (no cache)
└── /*              ──► S3  ──► Vite SPA    (1y cache for assets, no-cache for index.html)
```

| Service | Purpose |
|---------|---------|
| CloudFront | CDN entry point, TLS, cache policies, security headers |
| ALB | Routes `/api/*` to the API container |
| ECS Fargate | Runs the Hono API (256 CPU, 512 MB) |
| ECR | Stores Docker images (last 10 kept) |
| RDS PostgreSQL 16 | Managed database (t4g.micro, private subnet) |
| S3 | Hosts the Vite SPA build |
| SSM Parameter Store | API runtime secrets injected at container start |
| Secrets Manager | RDS credentials (auto-managed by RDS) |
| VPC | 2 AZs, 1 NAT gateway, public/private subnets |

---

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html) v2 (`npm i -g aws-cdk`)
- [Node.js](https://nodejs.org) ≥ 20
- [pnpm](https://pnpm.io) ≥ 10
- [GitHub CLI](https://cli.github.com) (`gh`) for setting Actions secrets
- An AWS account with sufficient IAM permissions (see [IAM policy](#iam-policy))

---

## First-Time Setup

### 1. Bootstrap CDK (once per account/region)

```sh
cd infra
cdk bootstrap
```

### 2. Deploy the stack

```sh
cdk deploy
```

This creates all infrastructure: VPC, RDS, ECR, ECS cluster, ALB, S3, CloudFront, and SSM
parameter placeholders. The ECS service starts with a placeholder image until the first real
deployment.

Note the stack outputs printed at the end — you'll need them in the next steps.

### 3. Fill in secrets

```sh
./setup-secrets.sh
```

This script reads the stack outputs, fetches the auto-generated RDS password from Secrets
Manager, builds the `DATABASE_URL`, generates a `BETTER_AUTH_SECRET`, and writes everything to
SSM Parameter Store.

Then set the one remaining secret manually:

```sh
aws ssm put-parameter \
  --name /vexillo/SUPER_ADMIN_EMAILS \
  --value "you@example.com" \
  --type String
```

**All SSM parameters:**

| Parameter | Set by | Description |
|-----------|--------|-------------|
| `/vexillo/DATABASE_URL` | `setup-secrets.sh` | PostgreSQL connection string |
| `/vexillo/BETTER_AUTH_SECRET` | `setup-secrets.sh` | 32-byte hex session secret |
| `/vexillo/BETTER_AUTH_URL` | `setup-secrets.sh` | CloudFront distribution URL |
| `/vexillo/BETTER_AUTH_TRUSTED_ORIGINS` | `setup-secrets.sh` | CloudFront distribution URL |
| `/vexillo/SUPER_ADMIN_EMAILS` | Manual | Comma-separated super-admin emails |

### 4. Create a deploy IAM user

Create an IAM user for GitHub Actions using the policy in `iam-deploy-policy.json`, then generate
an access key for it.

```sh
aws iam create-user --user-name vexillo-deploy
aws iam put-user-policy \
  --user-name vexillo-deploy \
  --policy-name vexillo-deploy \
  --policy-document file://iam-deploy-policy.json
aws iam create-access-key --user-name vexillo-deploy
```

### 5. Configure GitHub Actions secrets

Replace the values below with your stack outputs and the IAM key you just created:

```sh
gh secret set AWS_ACCESS_KEY_ID        --body "<key-id>"
gh secret set AWS_SECRET_ACCESS_KEY    --body "<secret>"
gh secret set AWS_REGION               --body "us-east-1"
gh secret set ECR_REPOSITORY           --body "vexillo-api"
gh secret set ECS_CLUSTER_NAME         --body "vexillo"
gh secret set ECS_SERVICE_NAME         --body "vexillo-api"
```

Fetch the remaining values from stack outputs:

```sh
STACK=VexilloStack

gh secret set S3_BUCKET_NAME --body "$(
  aws cloudformation describe-stacks --stack-name $STACK \
    --query 'Stacks[0].Outputs[?OutputKey==`WebBucketName`].OutputValue' --output text)"

gh secret set CLOUDFRONT_DISTRIBUTION_ID --body "$(
  aws cloudformation describe-stacks --stack-name $STACK \
    --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text)"
```

### 6. Trigger the first deployment

```sh
git push origin main
```

GitHub Actions will build and push the API image to ECR, run database migrations inside the
container, update the ECS service, build the Vite SPA, upload it to S3, and invalidate
CloudFront.

### 7. Verify

```sh
CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name VexilloStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' --output text)

curl "$CLOUDFRONT_URL/api/health"  # → {"status":"ok"}
```

---

## How Deployments Work

Deployments are triggered automatically on every push to `main`, or manually via
`gh workflow run deploy.yml`.

**API changes** (`apps/api/**` or `packages/db/**`):
1. Build Docker image, push to ECR with the commit SHA tag
2. Register a new ECS task definition revision pointing to the new image
3. Update the ECS service and wait for it to stabilize
4. The container runs `drizzle-kit migrate` before starting — migrations are idempotent and run
   on every deploy, so the database is always up to date

**Web changes** (`apps/web/**`):
1. `pnpm --filter @vexillo/web build` → `apps/web/dist/`
2. Sync `dist/` to S3 with long-lived cache headers for hashed assets
3. Upload `index.html` with `no-store` headers
4. Invalidate the CloudFront distribution

**Force a redeploy without a code change:**

```sh
gh workflow run deploy.yml -f deploy_api=true   # force API redeploy
gh workflow run deploy.yml -f deploy_web=true   # force web redeploy
```

---

## Common Operations

**Tail API logs:**

```sh
aws logs tail /vexillo/api --follow
```

**Rotate secrets** (e.g. after a breach or credential rotation):

```sh
cd infra
./setup-secrets.sh   # regenerates BETTER_AUTH_SECRET, updates DATABASE_URL if needed
# Then force a redeploy so the new secrets are picked up:
gh workflow run deploy.yml -f deploy_api=true
```

**Update SUPER_ADMIN_EMAILS:**

```sh
aws ssm put-parameter \
  --name /vexillo/SUPER_ADMIN_EMAILS \
  --value "alice@example.com,bob@example.com" \
  --type String \
  --overwrite
gh workflow run deploy.yml -f deploy_api=true
```

**Check running task / image:**

```sh
aws ecs describe-services \
  --cluster vexillo --services vexillo-api \
  --query 'services[0].taskDefinition'
```

**Tear down** (RDS and S3 are retained by default):

```sh
cd infra
cdk destroy
```

---

## IAM Policy

The `iam-deploy-policy.json` file in this directory defines the minimum permissions needed by the
GitHub Actions deploy user. It covers ECR, ECS, S3, CloudFront, SSM, Secrets Manager, and
scoped IAM permissions for CDK-managed roles.

---

## Stack Outputs Reference

| Output | Description |
|--------|-------------|
| `CloudFrontUrl` | Public URL for the app |
| `AlbDnsName` | Internal ALB DNS (not used directly) |
| `EcsClusterName` | `vexillo` |
| `EcsServiceName` | `vexillo-api` |
| `EcrRepositoryUri` | ECR image registry URI |
| `WebBucketName` | S3 bucket for the Vite SPA |
| `CloudFrontDistributionId` | Used for cache invalidation |
| `RdsEndpoint` | Private RDS hostname (used in `DATABASE_URL`) |
