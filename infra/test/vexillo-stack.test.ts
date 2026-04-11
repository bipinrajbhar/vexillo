import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VexilloStack } from '../lib/vexillo-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new VexilloStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  template = Template.fromStack(stack);
});

describe('VPC', () => {
  it('creates a VPC with public and private subnets', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs × 2 subnet types = 4 subnets
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  it('has exactly one NAT gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });
});

describe('RDS', () => {
  it('creates a Postgres 16 instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      DBInstanceClass: 'db.t4g.micro',
      StorageEncrypted: true,
      MultiAZ: false,
      DBName: 'vexillo',
    });
  });

  it('retains the database on stack deletion', () => {
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });
});

describe('ECR', () => {
  it('creates a repository named vexillo-api', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'vexillo-api',
    });
  });

  it('retains the repository on stack deletion', () => {
    template.hasResource('AWS::ECR::Repository', {
      DeletionPolicy: 'Retain',
    });
  });
});

describe('App Runner', () => {
  it('creates an App Runner VPC connector', () => {
    template.resourceCountIs('AWS::AppRunner::VpcConnector', 1);
    template.hasResourceProperties('AWS::AppRunner::VpcConnector', {
      VpcConnectorName: 'vexillo-connector',
    });
  });

  it('creates an App Runner service with auto-deployments disabled', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      ServiceName: 'vexillo-api',
      SourceConfiguration: {
        AutoDeploymentsEnabled: false,
        ImageRepository: {
          ImageRepositoryType: 'ECR_PUBLIC',
        },
      },
    });
  });

  it('configures a health check on /health', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      HealthCheckConfiguration: {
        Protocol: 'HTTP',
        Path: '/health',
      },
    });
  });

  it('uses VPC egress via the connector', () => {
    template.hasResourceProperties('AWS::AppRunner::Service', {
      NetworkConfiguration: {
        EgressConfiguration: {
          EgressType: 'VPC',
        },
      },
    });
  });
});

describe('S3', () => {
  it('creates a private bucket with all public access blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe('CloudFront', () => {
  it('creates a CloudFront distribution with HTTPS redirect', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: {
          ViewerProtocolPolicy: 'redirect-to-https',
        },
      },
    });
  });

  it('has three cache behaviors: default + /api/sdk/flags + /api/*', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/sdk/flags' }),
          Match.objectLike({ PathPattern: '/api/*' }),
        ]),
      },
    });
  });

  it('maps 403 and 404 to /index.html for SPA routing', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponsePagePath: '/index.html' }),
        ]),
      },
    });
  });

  it('creates an OAC for S3', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
  });

  it('sdk-flags cache policy has 30s default TTL', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'vexillo-sdk-flags-30s',
        DefaultTTL: 30,
        MaxTTL: 60,
      },
    });
  });
});

describe('SSM Parameters', () => {
  const requiredParams = [
    '/vexillo/DATABASE_URL',
    '/vexillo/BETTER_AUTH_SECRET',
    '/vexillo/BETTER_AUTH_URL',
    '/vexillo/BETTER_AUTH_TRUSTED_ORIGINS',
    '/vexillo/OKTA_CLIENT_ID',
    '/vexillo/OKTA_CLIENT_SECRET',
    '/vexillo/OKTA_ISSUER',
  ];

  it.each(requiredParams)('creates SSM parameter %s', (name) => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: name,
    });
  });
});

describe('Stack outputs', () => {
  it('exports CloudFront URL', () => {
    template.hasOutput('CloudFrontUrl', {});
  });

  it('exports App Runner service ARN', () => {
    template.hasOutput('AppRunnerServiceArn', {});
  });

  it('exports ECR repository URI', () => {
    template.hasOutput('EcrRepositoryUri', {});
  });

  it('exports S3 bucket name', () => {
    template.hasOutput('WebBucketName', {});
  });

  it('exports CloudFront distribution ID', () => {
    template.hasOutput('CloudFrontDistributionId', {});
  });
});
