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

describe('ECS / ALB', () => {
  it('creates an ECS cluster named vexillo', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'vexillo',
    });
  });

  it('creates a Fargate task definition with the API container on port 8080', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 8080 }),
          ]),
        }),
      ]),
    });
  });

  it('creates an ECS Fargate service named vexillo-api', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'vexillo-api',
      LaunchType: 'FARGATE',
    });
  });

  it('creates an ALB with a health check on /health', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
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

  it('creates a response headers policy with CSP, HSTS, and framing controls', () => {
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        Name: 'vexillo-spa-security-headers',
        SecurityHeadersConfig: {
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ReferrerPolicy: {
            ReferrerPolicy: 'strict-origin-when-cross-origin',
            Override: true,
          },
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 365 * 24 * 60 * 60,
            IncludeSubdomains: true,
            Override: true,
          },
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'"),
            Override: true,
          },
        },
      },
    });
  });

  it('attaches the response headers policy to the default (SPA) behavior', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          ResponseHeadersPolicyId: Match.objectLike({ Ref: Match.anyValue() }),
        },
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
    '/vexillo/SUPER_ADMIN_EMAILS',
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

  it('exports ALB DNS name', () => {
    template.hasOutput('AlbDnsName', {});
  });

  it('exports ECS cluster name', () => {
    template.hasOutput('EcsClusterName', {});
  });

  it('exports ECS service name', () => {
    template.hasOutput('EcsServiceName', {});
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

  it('exports RDS endpoint', () => {
    template.hasOutput('RdsEndpoint', {});
  });
});
