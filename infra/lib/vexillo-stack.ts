import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import { Construct } from 'constructs';

/**
 * VexilloStack — single-region, single-AZ-redundant AWS deployment.
 *
 * Architecture:
 *   CloudFront → S3 (default, Vite SPA)
 *              → App Runner (  /api/*, 30s cache on /api/sdk/flags)
 *   App Runner → RDS Postgres (via VPC connector, private subnet)
 *   ECR        ← CI/CD (docker push + apprunner start-deployment)
 *   SSM        ← operator sets real secret values post-deploy
 */
export class VexilloStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ── Security groups ───────────────────────────────────────────────────────
    // App Runner VPC connector: egress only (traffic originates inside App Runner)
    const vpcConnectorSg = new ec2.SecurityGroup(this, 'VpcConnectorSg', {
      vpc,
      description: 'App Runner VPC connector — outbound to RDS',
      allowAllOutbound: true,
    });

    // RDS: only accept Postgres connections from the VPC connector
    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc,
      description: 'RDS Postgres — accept from App Runner VPC connector',
      allowAllOutbound: false,
    });
    rdsSg.addIngressRule(
      vpcConnectorSg,
      ec2.Port.tcp(5432),
      'Allow Postgres from App Runner VPC connector',
    );

    // ── RDS Postgres ─────────────────────────────────────────────────────────
    const dbCredentials = rds.Credentials.fromGeneratedSecret('postgres', {
      secretName: '/vexillo/rds-credentials',
    });

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      credentials: dbCredentials,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [rdsSg],
      databaseName: 'vexillo',
      // Single-AZ for cost; promote to Multi-AZ when going to production
      multiAz: false,
      storageEncrypted: true,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      backupRetention: cdk.Duration.days(7),
    });

    // ── ECR repository ────────────────────────────────────────────────────────
    const repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: 'vexillo-api',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Keep last 10 tagged images to avoid unbounded growth
          maxImageCount: 10,
          tagStatus: ecr.TagStatus.ANY,
          description: 'Retain last 10 images',
        },
      ],
    });

    // ── App Runner IAM roles ──────────────────────────────────────────────────
    // Access role: used by App Runner SERVICE to pull the image from ECR
    const appRunnerAccessRole = new iam.Role(this, 'AppRunnerAccessRole', {
      roleName: 'vexillo-apprunner-access-role',
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonEC2ContainerRegistryReadOnly',
        ),
      ],
    });

    // Instance role: assumed by the running CONTAINER for SSM access
    const appRunnerInstanceRole = new iam.Role(this, 'AppRunnerInstanceRole', {
      roleName: 'vexillo-apprunner-instance-role',
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
    });
    appRunnerInstanceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSsmParameters',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/vexillo/*`,
        ],
      }),
    );
    // Allow reading the RDS credentials secret generated above
    database.secret?.grantRead(appRunnerInstanceRole);

    // ── App Runner VPC connector ──────────────────────────────────────────────
    const vpcConnector = new apprunner.CfnVpcConnector(this, 'VpcConnector', {
      vpcConnectorName: 'vexillo-connector',
      subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
        .subnetIds,
      securityGroups: [vpcConnectorSg.securityGroupId],
    });

    // ── App Runner service ────────────────────────────────────────────────────
    // Placeholder public image for the initial CDK deploy.
    // The CI/CD pipeline (deploy.yml) will push to ECR and call
    // `aws apprunner start-deployment` to switch to the real image.
    const appRunnerService = new apprunner.CfnService(this, 'ApiService', {
      serviceName: 'vexillo-api',
      sourceConfiguration: {
        autoDeploymentsEnabled: false,
        imageRepository: {
          // Amazon's hello-app-runner image returns HTTP 200 on any path
          imageIdentifier: 'public.ecr.aws/aws-containers/hello-app-runner:latest',
          imageRepositoryType: 'ECR_PUBLIC',
          imageConfiguration: {
            port: '8080',
            runtimeEnvironmentVariables: [
              // The real DATABASE_URL is injected at runtime via SSM;
              // this placeholder satisfies the CDK requirement for a value.
              { name: 'DATABASE_URL', value: 'placeholder' },
            ],
          },
        },
      },
      instanceConfiguration: {
        instanceRoleArn: appRunnerInstanceRole.roleArn,
        cpu: '0.25 vCPU',
        memory: '0.5 GB',
      },
      networkConfiguration: {
        egressConfiguration: {
          egressType: 'VPC',
          vpcConnectorArn: vpcConnector.attrVpcConnectorArn,
        },
      },
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
    });

    // ── S3 bucket (web frontend) ──────────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // OAC is created automatically by S3BucketOrigin.withOriginAccessControl() below.

    // ── CloudFront cache policies ─────────────────────────────────────────────
    // SDK flags: 30s default TTL, 60s max, key on Authorization header
    const sdkFlagsCachePolicy = new cloudfront.CachePolicy(
      this,
      'SdkFlagsCachePolicy',
      {
        cachePolicyName: 'vexillo-sdk-flags-30s',
        defaultTtl: cdk.Duration.seconds(30),
        maxTtl: cdk.Duration.seconds(60),
        minTtl: cdk.Duration.seconds(0),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
          'Authorization',
        ),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      },
    );

    // API (no cache): pass everything, no caching
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'vexillo-api-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    });

    // ── CloudFront origin request policy for API (forward all) ────────────────
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'ApiOriginRequestPolicy',
      {
        originRequestPolicyName: 'vexillo-api-forward-all',
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.all(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      },
    );

    // ── App Runner origin (HTTPS only) ────────────────────────────────────────
    const appRunnerOrigin = new origins.HttpOrigin(
      cdk.Fn.select(
        2,
        cdk.Fn.split('/', appRunnerService.attrServiceUrl),
      ),
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        httpsPort: 443,
        readTimeout: cdk.Duration.seconds(60),
        keepaliveTimeout: cdk.Duration.seconds(60),
      },
    );

    // ── S3 origin — OAC wired natively by S3BucketOrigin ─────────────────────
    // withOriginAccessControl() creates the OAC resource and adds the bucket
    // policy granting CloudFront s3:GetObject access automatically.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);

    // ── CloudFront distribution ───────────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Vexillo — SPA + API',
      defaultRootObject: 'index.html',
      // Default behavior: S3 SPA
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      additionalBehaviors: {
        // SDK flags endpoint — 30s CDN cache, keyed on Authorization header
        '/api/sdk/flags': {
          origin: appRunnerOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: sdkFlagsCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
        // All other API routes — no cache, forward everything
        '/api/*': {
          origin: appRunnerOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
      },
      // SPA routing: map S3 403/404 → index.html so TanStack Router can handle the path
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ── SSM Parameter Store — secret placeholders ─────────────────────────────
    // Operators must update these values before the API can start correctly.
    // The App Runner container reads them at startup via SSM SDK calls.
    const ssmParams: Record<string, string> = {
      '/vexillo/DATABASE_URL': 'REPLACE_ME',
      '/vexillo/BETTER_AUTH_SECRET': 'REPLACE_ME',
      '/vexillo/BETTER_AUTH_URL': `https://${distribution.distributionDomainName}`,
      '/vexillo/BETTER_AUTH_TRUSTED_ORIGINS': `https://${distribution.distributionDomainName}`,
      '/vexillo/OKTA_CLIENT_ID': 'REPLACE_ME',
      '/vexillo/OKTA_CLIENT_SECRET': 'REPLACE_ME',
      '/vexillo/OKTA_ISSUER': 'REPLACE_ME',
    };

    for (const [name, value] of Object.entries(ssmParams)) {
      const id = name.replace(/\//g, '').replace(/_/g, '');
      new ssm.StringParameter(this, `Param${id}`, {
        parameterName: name,
        stringValue: value,
        description: `Vexillo runtime secret — update before first deploy`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // ── Stack outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      description: 'CloudFront distribution URL — use as BETTER_AUTH_URL',
      value: `https://${distribution.distributionDomainName}`,
      exportName: 'VexilloCloudFrontUrl',
    });

    new cdk.CfnOutput(this, 'AppRunnerServiceUrl', {
      description: 'App Runner service URL (direct, bypasses CloudFront)',
      value: appRunnerService.attrServiceUrl,
      exportName: 'VexilloAppRunnerServiceUrl',
    });

    new cdk.CfnOutput(this, 'AppRunnerServiceArn', {
      description:
        'App Runner service ARN — set as APP_RUNNER_SERVICE_ARN GitHub secret',
      value: appRunnerService.attrServiceArn,
      exportName: 'VexilloAppRunnerServiceArn',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      description: 'ECR repository URI — set as ECR_REPOSITORY GitHub secret',
      value: repository.repositoryUri,
      exportName: 'VexilloEcrRepositoryUri',
    });

    new cdk.CfnOutput(this, 'WebBucketName', {
      description: 'S3 bucket name — set as S3_BUCKET_NAME GitHub secret',
      value: webBucket.bucketName,
      exportName: 'VexilloWebBucketName',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      description:
        'CloudFront distribution ID — set as CLOUDFRONT_DISTRIBUTION_ID GitHub secret',
      value: distribution.distributionId,
      exportName: 'VexilloCloudFrontDistributionId',
    });

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      description: 'RDS Postgres endpoint — use to build DATABASE_URL',
      value: database.dbInstanceEndpointAddress,
      exportName: 'VexilloRdsEndpoint',
    });
  }
}
