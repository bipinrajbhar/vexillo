#!/bin/bash
set -eo pipefail

echo ""
echo "Vexillo — secrets setup"
echo "========================"
echo "This script reads CDK stack outputs and fills in SSM parameters."
echo ""

# ── Check AWS CLI is configured ──────────────────────────────────────────────
if ! aws sts get-caller-identity &>/dev/null; then
  echo "Error: AWS CLI is not configured. Run 'aws configure' first."
  exit 1
fi

# ── Read CDK stack outputs ───────────────────────────────────────────────────
echo "Reading CDK stack outputs..."
CLOUDFRONT_URL=$(aws cloudformation describe-stacks \
  --stack-name VexilloStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' \
  --output text)

RDS_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name VexilloStack \
  --query 'Stacks[0].Outputs[?OutputKey==`RdsEndpoint`].OutputValue' \
  --output text)

if [ -z "$CLOUDFRONT_URL" ] || [ -z "$RDS_ENDPOINT" ]; then
  echo "Error: VexilloStack outputs not found. Run 'cdk deploy' first."
  exit 1
fi

echo "  CloudFront URL : $CLOUDFRONT_URL"
echo "  RDS Endpoint   : $RDS_ENDPOINT"
echo ""

# ── Get RDS password from Secrets Manager ────────────────────────────────────
echo "Fetching auto-generated RDS password from Secrets Manager..."
RDS_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id /vexillo/rds-credentials \
  --query 'SecretString' \
  --output text)
RDS_PASSWORD=$(echo "$RDS_SECRET" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")
DATABASE_URL="postgresql://postgres:${RDS_PASSWORD}@${RDS_ENDPOINT}:5432/vexillo"
echo "  DATABASE_URL built."
echo ""

# ── Generate BETTER_AUTH_SECRET and OKTA_SECRET_KEY ─────────────────────────
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
OKTA_SECRET_KEY=$(openssl rand -hex 32)

# ── Summary ──────────────────────────────────────────────────────────────────
echo "About to set the following SSM parameters:"
echo ""
echo "  /vexillo/DATABASE_URL                = postgresql://postgres:***@${RDS_ENDPOINT}:5432/vexillo"
echo "  /vexillo/BETTER_AUTH_SECRET          = (generated)"
echo "  /vexillo/BETTER_AUTH_URL             = $CLOUDFRONT_URL"
echo "  /vexillo/BETTER_AUTH_TRUSTED_ORIGINS = $CLOUDFRONT_URL"
echo "  /vexillo/OKTA_SECRET_KEY             = (generated)"
echo ""
read -rp "Proceed? (y/n) " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborted."
  exit 0
fi

# ── Write to SSM ─────────────────────────────────────────────────────────────
echo ""
echo "Writing SSM parameters..."

put() {
  aws ssm put-parameter --name "$1" --value "$2" --type String --overwrite > /dev/null
  echo "  ✓ $1"
}

put /vexillo/DATABASE_URL                "$DATABASE_URL"
put /vexillo/BETTER_AUTH_SECRET          "$BETTER_AUTH_SECRET"
put /vexillo/BETTER_AUTH_URL             "$CLOUDFRONT_URL"
put /vexillo/BETTER_AUTH_TRUSTED_ORIGINS "$CLOUDFRONT_URL"
put /vexillo/OKTA_SECRET_KEY             "$OKTA_SECRET_KEY"

echo ""
echo "All secrets set."
echo ""
echo "Next steps:"
echo "  1. Add these GitHub Actions secrets:"
echo "     AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION"
echo "     DATABASE_URL = $DATABASE_URL"
echo ""
echo "     Run: gh secret set DATABASE_URL --body \"$DATABASE_URL\""
echo ""
echo "  3. Push to main to trigger the first real deployment."
echo ""
