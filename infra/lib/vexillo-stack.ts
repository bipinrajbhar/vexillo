import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * VexilloStack — single-region AWS deployment.
 *
 * Architecture:
 *   CloudFront → S3 (default, Vite SPA)
 *              → ALB → ECS Fargate (/api/*, 30s cache on /api/sdk/flags)
 *   ECS Fargate → RDS Postgres (via VPC, private subnet)
 *   ECR        ← CI/CD (docker push + ecs update-service)
 *   SSM        ← operator sets real secret values via setup-secrets.sh
 */
export class VexilloStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── SSM Parameters — created FIRST so ECS can reference them ─────────────
    // All start as REPLACE_ME. Run ./setup-secrets.sh after cdk deploy to fill
    // in real values, then push to main to trigger the first real deployment.
    const paramNames = [
      '/vexillo/DATABASE_URL',
      '/vexillo/BETTER_AUTH_SECRET',
      '/vexillo/BETTER_AUTH_URL',
      '/vexillo/BETTER_AUTH_TRUSTED_ORIGINS',
      '/vexillo/OKTA_CLIENT_ID',
      '/vexillo/OKTA_CLIENT_SECRET',
      '/vexillo/OKTA_ISSUER',
    ] as const;

    const ssmParams: Record<string, ssm.StringParameter> = {};
    for (const name of paramNames) {
      const id = name.replace(/\//g, '').replace(/_/g, '');
      ssmParams[name] = new ssm.StringParameter(this, `Param${id}`, {
        parameterName: name,
        stringValue: 'REPLACE_ME',
        description: 'Vexillo runtime secret - update via setup-secrets.sh',
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // ── VPC ──────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public',  subnetType: ec2.SubnetType.PUBLIC,               cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,  cidrMask: 24 },
      ],
    });

    // ── Security groups ───────────────────────────────────────────────────────
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'ECS Fargate API service',
      allowAllOutbound: true,
    });

    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc,
      description: 'RDS Postgres - accept from ECS API',
      allowAllOutbound: false,
    });
    rdsSg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'Allow Postgres from ECS API');

    // ── RDS Postgres ─────────────────────────────────────────────────────────
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromGeneratedSecret('postgres', { secretName: '/vexillo/rds-credentials' }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [rdsSg],
      databaseName: 'vexillo',
      multiAz: false,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backupRetention: cdk.Duration.days(7),
    });

    // ── ECR repository ────────────────────────────────────────────────────────
    const repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: 'vexillo-api',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10, tagStatus: ecr.TagStatus.ANY, description: 'Retain last 10 images' }],
    });

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'vexillo',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── Task execution role (pull image from ECR, read SSM, write logs) ───────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'vexillo-ecs-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    // Grant execution role access to read all SSM params at task startup
    for (const param of Object.values(ssmParams)) {
      param.grantRead(executionRole);
    }

    // ── Task role (runtime: Secrets Manager for RDS credentials) ─────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'vexillo-ecs-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    database.secret?.grantRead(taskRole);

    // ── CloudWatch log group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/vexillo/api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── ECS Fargate service + ALB ─────────────────────────────────────────────
    // Placeholder image: python3 -m http.server 8080 returns 200 on GET /
    // CI/CD replaces this with the real ECR image on first push to main.
    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      serviceName: 'vexillo-api',
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      securityGroups: [apiSg],
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      publicLoadBalancer: true,
      assignPublicIp: false,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/python:3.11-alpine'),
        containerPort: 8080,
        command: ['python3', '-m', 'http.server', '8080'],
        executionRole,
        taskRole,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
        environment: { PORT: '8080', NODE_ENV: 'production' },
        // ECS reads these from SSM and injects as env vars before the container starts.
        secrets: {
          DATABASE_URL:                ecs.Secret.fromSsmParameter(ssmParams['/vexillo/DATABASE_URL']),
          BETTER_AUTH_SECRET:          ecs.Secret.fromSsmParameter(ssmParams['/vexillo/BETTER_AUTH_SECRET']),
          BETTER_AUTH_URL:             ecs.Secret.fromSsmParameter(ssmParams['/vexillo/BETTER_AUTH_URL']),
          BETTER_AUTH_TRUSTED_ORIGINS: ecs.Secret.fromSsmParameter(ssmParams['/vexillo/BETTER_AUTH_TRUSTED_ORIGINS']),
          OKTA_CLIENT_ID:              ecs.Secret.fromSsmParameter(ssmParams['/vexillo/OKTA_CLIENT_ID']),
          OKTA_CLIENT_SECRET:          ecs.Secret.fromSsmParameter(ssmParams['/vexillo/OKTA_CLIENT_SECRET']),
          OKTA_ISSUER:                 ecs.Secret.fromSsmParameter(ssmParams['/vexillo/OKTA_ISSUER']),
        },
      },
    });

    // ALB target group health check
    apiService.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200-399',
      interval: cdk.Duration.seconds(15),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Allow ALB to reach ECS tasks on port 8080
    apiService.service.connections.allowFrom(apiService.loadBalancer, ec2.Port.tcp(8080), 'ALB to ECS');

    // ── S3 bucket (web frontend) ──────────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudFront cache policies ─────────────────────────────────────────────
    const sdkFlagsCachePolicy = new cloudfront.CachePolicy(this, 'SdkFlagsCachePolicy', {
      cachePolicyName: 'vexillo-sdk-flags-30s',
      defaultTtl: cdk.Duration.seconds(30),
      maxTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'vexillo-api-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    });

    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: 'vexillo-api-forward-all',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.all(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
    });

    // ── CloudFront distribution ───────────────────────────────────────────────
    const albOrigin = new origins.LoadBalancerV2Origin(apiService.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Vexillo - SPA + API',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      additionalBehaviors: {
        '/api/sdk/flags': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: sdkFlagsCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
        '/api/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ── Stack outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      description: 'CloudFront URL - pass to setup-secrets.sh as BETTER_AUTH_URL',
      value: `https://${distribution.distributionDomainName}`,
      exportName: 'VexilloCloudFrontUrl',
    });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      description: 'ALB DNS name (direct)',
      value: apiService.loadBalancer.loadBalancerDnsName,
      exportName: 'VexilloAlbDnsName',
    });
    new cdk.CfnOutput(this, 'EcsClusterName', {
      description: 'ECS cluster name',
      value: cluster.clusterName,
      exportName: 'VexilloEcsClusterName',
    });
    new cdk.CfnOutput(this, 'EcsServiceName', {
      description: 'ECS service name',
      value: apiService.service.serviceName,
      exportName: 'VexilloEcsServiceName',
    });
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      description: 'ECR repository URI - set as ECR_REPOSITORY GitHub secret',
      value: repository.repositoryUri,
      exportName: 'VexilloEcrRepositoryUri',
    });
    new cdk.CfnOutput(this, 'WebBucketName', {
      description: 'S3 bucket name - set as S3_BUCKET_NAME GitHub secret',
      value: webBucket.bucketName,
      exportName: 'VexilloWebBucketName',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      description: 'CloudFront distribution ID - set as CLOUDFRONT_DISTRIBUTION_ID GitHub secret',
      value: distribution.distributionId,
      exportName: 'VexilloCloudFrontDistributionId',
    });
    new cdk.CfnOutput(this, 'RdsEndpoint', {
      description: 'RDS endpoint - used by setup-secrets.sh to build DATABASE_URL',
      value: database.dbInstanceEndpointAddress,
      exportName: 'VexilloRdsEndpoint',
    });
  }
}
