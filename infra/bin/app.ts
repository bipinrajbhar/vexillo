import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VexilloStack } from '../lib/vexillo-stack';

const app = new cdk.App();

new VexilloStack(app, 'VexilloStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Vexillo — feature-flag service (Hono API + Vite SPA on AWS)',
});
