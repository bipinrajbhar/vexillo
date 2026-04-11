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
 * VexilloStack — single-region, single-AZ-redundant AWS deployment.
 *
 * Architecture:
 *   CloudFront → S3 (default, Vite SPA)
 *              → ALB → ECS Fargate (  /api/*, 30s cache on /api/sdk/flags)
 *   ECS Fargate → RDS Postgres (via VPC, private subnet)
 *   ECR        ← CI/CD (docker push + ecs update-service)
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
    rdsSg.addIngressRule(
      apiSg,
      ec2.Port.tcp(5432),
      'Allow Postgres from ECS API',
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
      lifecycleRules: [
        {
          maxImageCount: 10,
          tagStatus: ecr.TagStatus.ANY,
          description: 'Retain last 10 images',
        },
      ],
    });

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'vexillo',
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── Task execution role (pull image from ECR, write logs) ─────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'vexillo-ecs-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // ── Task role (runtime permissions: SSM, Secrets Manager) ────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'vexillo-ecs-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSsmParameters',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/vexillo/*`,
        ],
      }),
    );
    database.secret?.grantRead(taskRole);

    // ── CloudWatch log group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/vexillo/api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── SSM parameter references (created later, referenced here by name) ──────
    // fromStringParameterName does NOT create a new parameter — it's just a
    // reference used by ECS secrets injection. The actual parameters are created
    // in the SSM section below and their read grant is added to executionRole.
    const ssmRef = (name: string) =>
      ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(this, `Ref${name.replace(/\//g, '').replace(/_/g, '')}`, name),
      );

    // ── ECS Fargate service + ALB (ECS Express Mode pattern) ─────────────────
    // Uses a placeholder public image for initial deploy.
    // CI/CD updates the service with the real ECR image via `ecs update-service`.
    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'ApiService',
      {
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
          // Placeholder: python http.server returns 200 on GET /
          // CI/CD replaces this with the real ECR image on first push to main.
          image: ecs.ContainerImage.fromRegistry(
            'public.ecr.aws/docker/library/python:3.11-alpine',
          ),
          containerPort: 8080,
          command: ['python3', '-m', 'http.server', '8080'],
          executionRole,
          taskRole,
          logDriver: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: 'api',
          }),
          environment: {
            PORT: '8080',
            NODE_ENV: 'production',
          },
          // ECS injects these SSM values as env vars before the container starts.
          // Update the SSM parameters with real values before the first deploy.
          secrets: {
            DATABASE_URL:                ssmRef('/vexillo/DATABASE_URL'),
            BETTER_AUTH_SECRET:          ssmRef('/vexillo/BETTER_AUTH_SECRET'),
            BETTER_AUTH_URL:             ssmRef('/vexillo/BETTER_AUTH_URL'),
            BETTER_AUTH_TRUSTED_ORIGINS: ssmRef('/vexillo/BETTER_AUTH_TRUSTED_ORIGINS'),
            OKTA_CLIENT_ID:              ssmRef('/vexillo/OKTA_CLIENT_ID'),
            OKTA_CLIENT_SECRET:          ssmRef('/vexillo/OKTA_CLIENT_SECRET'),
            OKTA_ISSUER:                 ssmRef('/vexillo/OKTA_ISSUER'),
          },
        },
      },
    );

    // ALB target group health check — use / for the placeholder image;
    // the real API image serves /health which is a superset.
    apiService.targetGroup.configureHealthCheck({
      path: '/',
      healthyHttpCodes: '200-399',
      interval: cdk.Duration.seconds(15),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Allow ALB to reach the ECS tasks on port 8080
    apiService.service.connections.allowFrom(
      apiService.loadBalancer,
      ec2.Port.tcp(8080),
      'ALB to ECS',
    );

    // ── S3 bucket (web frontend) ──────────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── CloudFront cache policies ─────────────────────────────────────────────
    const sdkFlagsCachePolicy = new cloudfront.CachePolicy(
      this,
      'SdkFlagsCachePolicy',
      {
        cachePolicyName: 'vexillo-sdk-flags-30s',
        defaultTtl: cdk.Duration.seconds(30),
        maxTtl: cdk.Duration.seconds(60),
        minTtl: cdk.Duration.seconds(0),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      },
    );

    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'vexillo-api-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    });

    // ── CloudFront origin request policy for API ──────────────────────────────
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

    // ── ALB origin ────────────────────────────────────────────────────────────
    const albOrigin = new origins.LoadBalancerV2Origin(apiService.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    // ── S3 origin ─────────────────────────────────────────────────────────────
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);

    // ── CloudFront distribution ───────────────────────────────────────────────
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
    // After cdk deploy, run `aws ssm put-parameter --overwrite` to replace
    // REPLACE_ME values with real secrets before the first app deploy.
    const secretDefs: Record<string, string> = {
      '/vexillo/DATABASE_URL': 'REPLACE_ME',
      '/vexillo/BETTER_AUTH_SECRET': 'REPLACE_ME',
      '/vexillo/BETTER_AUTH_URL': `https://${distribution.distributionDomainName}`,
      '/vexillo/BETTER_AUTH_TRUSTED_ORIGINS': `https://${distribution.distributionDomainName}`,
      '/vexillo/OKTA_CLIENT_ID': 'REPLACE_ME',
      '/vexillo/OKTA_CLIENT_SECRET': 'REPLACE_ME',
      '/vexillo/OKTA_ISSUER': 'REPLACE_ME',
    };

    const ssmParameters: Record<string, ssm.StringParameter> = {};
    for (const [name, value] of Object.entries(secretDefs)) {
      const id = name.replace(/\//g, '').replace(/_/g, '');
      ssmParameters[name] = new ssm.StringParameter(this, `Param${id}`, {
        parameterName: name,
        stringValue: value,
        description: 'Vexillo runtime secret - update before first deploy',
        tier: ssm.ParameterTier.STANDARD,
      });
      // Grant the task execution role permission to read this parameter at task startup
      ssmParameters[name].grantRead(executionRole);
    }

    // ── Stack outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      description: 'CloudFront distribution URL - use as BETTER_AUTH_URL',
      value: `https://${distribution.distributionDomainName}`,
      exportName: 'VexilloCloudFrontUrl',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      description: 'ALB DNS name (direct, bypasses CloudFront)',
      value: apiService.loadBalancer.loadBalancerDnsName,
      exportName: 'VexilloAlbDnsName',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      description: 'ECS cluster name - use in CI/CD',
      value: cluster.clusterName,
      exportName: 'VexilloEcsClusterName',
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      description: 'ECS service name - use in CI/CD',
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
      description: 'RDS Postgres endpoint - use to build DATABASE_URL',
      value: database.dbInstanceEndpointAddress,
      exportName: 'VexilloRdsEndpoint',
    });
  }
}
