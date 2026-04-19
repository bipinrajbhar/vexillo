import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VexilloStack } from '../lib/vexillo-stack';

const app = new cdk.App();

// Deploy primary (us-east-1) with:   cdk deploy
// Deploy secondary (eu-west-1) with: cdk deploy --context region=eu-west-1
const region = (app.node.tryGetContext('region') as string | undefined) ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const PRIMARY_REGION = 'us-east-1';
const isPrimary = region === PRIMARY_REGION;

new VexilloStack(app, 'VexilloStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  isPrimary,
  description: `Vexillo — feature-flag service (Hono API + Vite SPA on AWS) [${isPrimary ? 'primary' : 'secondary'}: ${region}]`,
});
