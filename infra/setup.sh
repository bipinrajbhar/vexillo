#!/bin/bash
set -eo pipefail

# Usage: ./setup.sh
#
# Full first-time setup in one pass:
#   1. Collects all required inputs upfront
#   2. Creates the OKTA_SECRET_KEY SSM placeholder (required before cdk deploy)
#   3. Runs cdk bootstrap + cdk deploy
#   4. Writes all SSM secrets, creates the IAM deploy user, sets GitHub Actions secrets
#   5. Optionally seeds the first organisation

STACK=VexilloStack
AWS_REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo 'us-east-1')}"

echo ""
echo "Vexillo — first-time setup"
echo "=========================="
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: '$1' is required but not installed. $2"
    exit 1
  fi
}
check_cmd aws     "Install the AWS CLI: https://aws.amazon.com/cli/"
check_cmd cdk     "Install CDK: npm i -g aws-cdk"
check_cmd bun     "Install Bun: https://bun.sh"
check_cmd openssl "Install openssl via your package manager."
check_cmd python3 "Install Python 3 via your package manager."
check_cmd gh      "Install GitHub CLI: https://cli.github.com"

if ! aws sts get-caller-identity &>/dev/null; then
  echo "Error: AWS CLI not configured. Run 'aws configure' first."
  exit 1
fi
if ! gh auth status &>/dev/null 2>&1; then
  echo "Error: GitHub CLI not authenticated. Run 'gh auth login' first."
  exit 1
fi

# ── Collect all inputs upfront (no prompts after this block) ──────────────────
echo "Collecting setup information..."
echo ""

read -rp "Super-admin email(s) (comma-separated): " SUPER_ADMIN_EMAILS
if [ -z "$SUPER_ADMIN_EMAILS" ]; then
  echo "Error: at least one super-admin email is required."
  exit 1
fi


echo ""
echo "Starting deployment..."
echo ""

# ── OKTA_SECRET_KEY placeholder ───────────────────────────────────────────────
# CDK cannot create SecureString SSM parameters, but the ECS task definition
# references this param at deploy time. Create a placeholder first; the real
# value is written further below after cdk deploy succeeds.
echo "Creating OKTA_SECRET_KEY placeholder..."
aws ssm put-parameter \
  --name /vexillo/OKTA_SECRET_KEY \
  --value "placeholder" \
  --type SecureString \
  --overwrite > /dev/null
echo "  ✓ /vexillo/OKTA_SECRET_KEY"
echo ""

# ── CDK bootstrap + deploy ────────────────────────────────────────────────────
echo "Bootstrapping CDK (safe to re-run)..."
cdk bootstrap --require-approval never
echo ""

echo "Deploying CDK stack (~10 min on first run)..."
cdk deploy --require-approval never
echo ""

# ── Stack outputs ─────────────────────────────────────────────────────────────
echo "Reading stack outputs..."
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey==\`$1\`].OutputValue" \
    --output text
}

CLOUDFRONT_URL=$(get_output CloudFrontUrl)
RDS_ENDPOINT=$(get_output RdsEndpoint)
S3_BUCKET=$(get_output WebBucketName)
CF_DIST_ID=$(get_output CloudFrontDistributionId)

if [ -z "$CLOUDFRONT_URL" ] || [ -z "$RDS_ENDPOINT" ]; then
  echo "Error: $STACK outputs not found. Did 'cdk deploy' succeed?"
  exit 1
fi
echo "  CloudFront : $CLOUDFRONT_URL"
echo "  RDS        : $RDS_ENDPOINT"
echo ""

# ── RDS credentials ───────────────────────────────────────────────────────────
echo "Fetching RDS credentials..."
RDS_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id /vexillo/rds-credentials \
  --query 'SecretString' \
  --output text)
RDS_PASSWORD=$(echo "$RDS_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")
# sslmode=require: RDS PostgreSQL enforces SSL by default — connections without
# SSL will be rejected. The postgres npm package respects this URL parameter.
DATABASE_URL="postgresql://postgres:${RDS_PASSWORD}@${RDS_ENDPOINT}:5432/vexillo?sslmode=require"
echo "  ✓ DATABASE_URL built"
echo ""

# ── Generate secrets ──────────────────────────────────────────────────────────
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
OKTA_SECRET_KEY=$(openssl rand -hex 32)

# ── Write SSM parameters ──────────────────────────────────────────────────────
echo "Writing SSM parameters..."
put() {
  local type="${3:-String}"
  aws ssm put-parameter --name "$1" --value "$2" --type "$type" --overwrite > /dev/null
  echo "  ✓ $1"
}
put /vexillo/DATABASE_URL                "$DATABASE_URL"
put /vexillo/BETTER_AUTH_SECRET          "$BETTER_AUTH_SECRET"
put /vexillo/BETTER_AUTH_URL             "$CLOUDFRONT_URL"
put /vexillo/BETTER_AUTH_TRUSTED_ORIGINS "$CLOUDFRONT_URL"
put /vexillo/OKTA_SECRET_KEY             "$OKTA_SECRET_KEY" SecureString
put /vexillo/SUPER_ADMIN_EMAILS          "$SUPER_ADMIN_EMAILS"
echo ""

# ── IAM deploy user ───────────────────────────────────────────────────────────
echo "Setting up IAM deploy user..."
if ! aws iam get-user --user-name vexillo-deploy &>/dev/null 2>&1; then
  aws iam create-user --user-name vexillo-deploy > /dev/null
  echo "  ✓ Created IAM user vexillo-deploy"
else
  echo "  IAM user vexillo-deploy already exists"
fi

POLICY_ARN="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/vexillo-deploy"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" &>/dev/null 2>&1; then
  aws iam create-policy \
    --policy-name vexillo-deploy \
    --policy-document file://iam-deploy-policy.json > /dev/null
  echo "  ✓ Created managed policy vexillo-deploy"
else
  aws iam create-policy-version \
    --policy-arn "$POLICY_ARN" \
    --policy-document file://iam-deploy-policy.json \
    --set-as-default > /dev/null
  echo "  ✓ Updated managed policy vexillo-deploy"
fi
aws iam attach-user-policy \
  --user-name vexillo-deploy \
  --policy-arn "$POLICY_ARN" > /dev/null
echo "  ✓ Attached deploy policy"

EXISTING_KEYS=$(aws iam list-access-keys --user-name vexillo-deploy \
  --query 'AccessKeyMetadata[].AccessKeyId' --output text)
for key in $EXISTING_KEYS; do
  aws iam delete-access-key --user-name vexillo-deploy --access-key-id "$key" > /dev/null
  echo "  Rotated old access key $key"
done

KEY_OUTPUT=$(aws iam create-access-key --user-name vexillo-deploy)
AWS_KEY_ID=$(echo "$KEY_OUTPUT"     | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['AccessKeyId'])")
AWS_KEY_SECRET=$(echo "$KEY_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['AccessKey']['SecretAccessKey'])")
echo "  ✓ Created access key"
echo ""

# ── GitHub Actions secrets ────────────────────────────────────────────────────
echo "Setting GitHub Actions secrets..."
gh_secret() {
  gh secret set "$1" --body "$2" > /dev/null
  echo "  ✓ $1"
}
gh_secret AWS_ACCESS_KEY_ID           "$AWS_KEY_ID"
gh_secret AWS_SECRET_ACCESS_KEY       "$AWS_KEY_SECRET"
gh_secret AWS_REGION                  "$AWS_REGION"
gh_secret ECR_REPOSITORY              "vexillo-api"
gh_secret ECS_CLUSTER_NAME            "vexillo"
gh_secret ECS_SERVICE_NAME            "vexillo-api"
gh_secret S3_BUCKET_NAME              "$S3_BUCKET"
gh_secret CLOUDFRONT_DISTRIBUTION_ID  "$CF_DIST_ID"
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Trigger the first deployment:"
echo "       git push origin main"
echo ""
echo "  2. Monitor progress:"
echo "       gh run watch"
echo ""
echo "  3. Seed your first organisation (after the first deploy):"
echo "     RDS is in a private subnet — run via ECS Exec from inside the VPC:"
echo ""
echo "       TASK_ARN=\$(aws ecs list-tasks --cluster vexillo --service-name vexillo-api --query 'taskArns[0]' --output text)"
echo "       aws ecs execute-command --cluster vexillo --task \"\$TASK_ARN\" --container web --interactive --command \"bun run apps/api/scripts/seed-org.ts 'Acme Corp' acme https://acme.okta.com/oauth2/default <clientId> <clientSecret>\""
echo ""
echo "  4. Add your super-admin email and redeploy to pick it up:"
echo "       aws ssm put-parameter --name /vexillo/SUPER_ADMIN_EMAILS --value \"you@example.com\" --type String --overwrite"
echo "       gh workflow run deploy.yml -f deploy_api=true"
echo ""
echo "  5. Sign in:"
echo "       $CLOUDFRONT_URL/org/<slug>/sign-in"
echo ""
echo "  Verify:"
echo "       curl $CLOUDFRONT_URL/api/health"
echo ""
