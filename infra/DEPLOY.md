# Deploying Vexillo to AWS

## Architecture

```
CloudFront (HTTPS)
├── /api/sdk/flags  ──► ALB ──► ECS Fargate (30s cache)
├── /api/*          ──► ALB ──► ECS Fargate (no cache)  ← includes /api/docs, /api/openapi.json
└── /*              ──► S3  ──► Vite SPA    (1y cache for assets, no-cache for index.html)
```

| Service | Purpose |
|---------|---------|
| CloudFront | CDN entry point, TLS, cache policies, security headers |
| ALB | Routes `/api/*` to the API container |
| ECS Fargate | Runs the Hono API (256 CPU, 512 MB), public subnet with public IP |
| ECR | Stores Docker images (last 10 kept) |
| RDS PostgreSQL 16 | Managed database (t4g.micro, isolated subnet) |
| S3 | Hosts the Vite SPA build |
| SSM Parameter Store | API runtime secrets injected at container start |
| Secrets Manager | RDS credentials (auto-managed by RDS) |
| VPC | 2 AZs, no NAT gateway, public + isolated subnets |

---

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html) v2 (`npm i -g aws-cdk`)
- [Node.js](https://nodejs.org) ≥ 20
- [pnpm](https://pnpm.io) ≥ 10
- [Bun](https://bun.sh) ≥ 1.x
- [GitHub CLI](https://cli.github.com) (`gh`) for setting Actions secrets
- An AWS account with sufficient IAM permissions (see [IAM policy](#iam-policy))

---

## Okta Setup

Each organisation authenticates users through its own Okta application. You need to create one Okta app per organisation before users can sign in.

### Create an Okta OIDC application

1. Sign in to your Okta admin console (e.g. `https://your-org-admin.okta.com`)
2. Go to **Applications → Applications → Create App Integration**
3. Choose **OIDC – OpenID Connect**, then **Web Application**
4. Configure the app:
   - **App integration name**: anything descriptive (e.g. `Vexillo`)
   - **Grant types**: ensure **Authorization Code** is checked
   - **Sign-in redirect URIs**: add **both** of the following (one for local dev, one for production):
     ```
     http://localhost:3000/api/auth/org-oauth/callback
     https://<your-cloudfront-url>/api/auth/org-oauth/callback
     ```
     To find your CloudFront URL:
     ```sh
     aws cloudformation describe-stacks --stack-name VexilloStack \
       --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' \
       --output text
     ```
   - **Assignments**: set to the users or groups that should have access
5. Save. Note the **Client ID** and **Client Secret** — you'll need them when seeding the organisation.

### Issuer URL

Use the authorization server issuer, not the org domain. The default authorization server URL is:

```
https://<your-okta-domain>/oauth2/default
```

For example: `https://acme.okta.com/oauth2/default`

Do **not** use just `https://acme.okta.com` — the discovery endpoint (`/.well-known/openid-configuration`) won't resolve correctly without the `/oauth2/default` path.

### Authorization Server Access Policy

Okta requires two separate policies to complete sign-in:

1. **Authentication Policy** — controls who can sign in (configured on the app)
2. **Authorization Server Access Policy** — controls which apps can get OAuth tokens

Without an Access Policy rule, sign-in fails with `no_matching_policy` even if the user authenticated successfully.

**Set up the Access Policy:**

1. Go to **Security → API → Authorization Servers → default → Access Policies**
2. Click **Add New Access Policy**, name it (e.g. `Vexillo App`), set **Assign to** → **All clients**, save
3. Click into the policy → **Add Rule**:
   - **Rule name**: `Allow Authorization Code`
   - **Grant type**: ✅ Authorization Code
   - **User is**: Any user assigned the app
   - **Scopes**: Any scopes
4. Click **Create rule**

### Authentication Policy

1. Go to **Security → Authentication Policies → Add a Policy**, name it (e.g. `Vexillo Access`)
2. Click **Add Rule**:
   - **User's user type**: Any user type
   - **User's group membership**: Any group
   - **User is**: Any user
   - **Risk**: Any
3. Save the rule, then go to your app → **Sign On tab → User authentication → Edit** and assign this policy

---

## First-Time Setup

### Prerequisites

See [Prerequisites](#prerequisites) above.

### 1. Run setup

```sh
cd infra
./setup.sh
```

The script prompts for your super-admin email(s) and optionally seeds the first organisation,
then runs unattended — no further input required. It handles:

- Creating the OKTA_SECRET_KEY SSM placeholder (required before `cdk deploy`)
- `cdk bootstrap` + `cdk deploy` (~10 min on first run)
- Fetching the RDS password and writing all SSM secrets
- Creating the `vexillo-deploy` IAM user and attaching the deploy policy
- Setting all 8 GitHub Actions secrets automatically

**SSM parameters written:**

| Parameter | Description |
|-----------|-------------|
| `/vexillo/DATABASE_URL` | PostgreSQL connection string (with `sslmode=require`) |
| `/vexillo/BETTER_AUTH_SECRET` | 32-byte hex session secret |
| `/vexillo/BETTER_AUTH_URL` | CloudFront distribution URL |
| `/vexillo/BETTER_AUTH_TRUSTED_ORIGINS` | CloudFront distribution URL |
| `/vexillo/OKTA_SECRET_KEY` | 32-byte hex AES-256-GCM key for Okta secrets |
| `/vexillo/SUPER_ADMIN_EMAILS` | Comma-separated super-admin emails |

### 2. Trigger the first deployment

```sh
git push origin main
```

GitHub Actions will build and push the API image to ECR, run database migrations inside the
container, update the ECS service, build the Vite SPA, upload it to S3, and invalidate
CloudFront.

Monitor progress: `gh run watch`

### 3. Verify

```sh
CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name VexilloStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' --output text)
curl "$CLOUDFRONT_URL/api/health"  # → {"status":"ok"}
```

Note: this only works after step 2 (first real deployment). Before that, the Python
placeholder container returns 404 for `/api/health`.

### Seeding an organisation

RDS is in a private isolated subnet — not reachable from your local machine. Run the seed
script via ECS Exec from inside the running API container (after the first deployment):

```sh
TASK_ARN=$(aws ecs list-tasks --cluster vexillo --service-name vexillo-api --query 'taskArns[0]' --output text)

aws ecs execute-command --cluster vexillo --task "$TASK_ARN" --container web --interactive --command "bun run apps/api/scripts/seed-org.ts 'Acme Corp' acme https://acme.okta.com/oauth2/default <clientId> <clientSecret>"
```

The environment variables (`DATABASE_URL`, `OKTA_SECRET_KEY`) are already injected into the
container from SSM — no need to pass them manually. The script is idempotent — safe to re-run.

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

**Tear down:**

```sh
cd infra
./teardown.sh
```

RDS must be deleted before the VPC subnets can be removed, so `teardown.sh` handles the full sequence: deletes RDS and waits for it to finish, runs `cdk destroy`, then removes ECR, S3, SSM parameters, and the IAM deploy user.

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
