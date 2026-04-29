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

export interface VexilloStackProps extends cdk.StackProps {
  /**
   * Set to false for secondary regions (eu-west-1, ap-*, etc.).
   * When false: RDS is not created; ECS tasks connect to the primary's RDS
   * via the same DATABASE_URL SSM parameter. Defaults to true.
   */
  isPrimary?: boolean;
}

/**
 * VexilloStack — multi-region AWS deployment.
 *
 * Architecture:
 *   CloudFront → S3 (default, Vite SPA)
 *              → ALB → ECS Fargate (/api/*, 30s cache on /api/sdk/flags)
 *   ECS Fargate → RDS Postgres (isolated subnet; primary region only)
 *   ECR        ← CI/CD (docker push + ecs update-service)
 *   SSM        ← operator sets real secret values via setup.sh
 *
 * Multi-region:
 *   Primary (us-east-1): owns RDS, fans out flag changes to secondary ALBs via
 *     SECONDARY_REGION_URLS → POST /internal/flag-change.
 *   Secondary (eu-west-1, …): no RDS construct; DATABASE_URL points at the
 *     primary's RDS; receives flag changes via /internal/flag-change and
 *     broadcasts to its local Redis pub/sub channel.
 */
export class VexilloStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VexilloStackProps = {}) {
    const { isPrimary = true } = props;
    super(scope, id, props);

    // ── SSM Parameters ────────────────────────────────────────────────────────
    // String parameters are created by CDK with placeholder values so 'cdk deploy'
    // works on a fresh account with no prior setup. Run './setup.sh' afterwards to
    // overwrite the placeholders with real secrets.
    //
    // CloudFormation only updates a resource when its template definition changes —
    // a 'cdk deploy' with no changes to these constructs will not clobber values
    // that './setup.sh' has set.
    const ssmParams: Record<string, ssm.StringParameter> = {};
    for (const name of [
      '/vexillo/BETTER_AUTH_URL',
      '/vexillo/BETTER_AUTH_TRUSTED_ORIGINS',
      '/vexillo/SUPER_ADMIN_EMAILS',
      // Primary: comma-separated secondary ALB base URLs (e.g. "https://eu-alb.example.com").
      // Secondary: leave as placeholder — an empty value means no fan-out is performed.
      '/vexillo/SECONDARY_REGION_URLS',
    ] as const) {
      const id = name.replace(/\//g, '').replace(/_/g, '');
      ssmParams[name] = new ssm.StringParameter(this, `Param${id}`, {
        parameterName: name,
        stringValue: 'placeholder',
      });
    }

    // DATABASE_URL, BETTER_AUTH_SECRET, OKTA_SECRET_KEY, and INTERNAL_SECRET must
    // be SecureString — CDK cannot create SecureString parameters. setup.sh creates
    // placeholders automatically before running 'cdk deploy'.
    const databaseUrlParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'ParamvexilloDATABASEURL', { parameterName: '/vexillo/DATABASE_URL' },
    );
    const betterAuthSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'ParamvexilloBETTERAUTHSECRET', { parameterName: '/vexillo/BETTER_AUTH_SECRET' },
    );
    const oktaSecretKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'ParamvexilloOKTASECRETKEY', { parameterName: '/vexillo/OKTA_SECRET_KEY' },
    );
    // Shared secret used by the primary to sign /internal/flag-change requests
    // and by each secondary to verify them. Must be identical in all regions.
    const internalSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'ParamvexilloINTERNALSECRET', { parameterName: '/vexillo/INTERNAL_SECRET' },
    );

    // ── VPC ──────────────────────────────────────────────────────────────────
    // No NAT gateway: ECS tasks run in the public subnet with assignPublicIp so
    // they can reach ECR and SSM directly. RDS sits in an isolated subnet with
    // no internet route — the security group is the only access control needed.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public',   subnetType: ec2.SubnetType.PUBLIC,           cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // ── Security groups ───────────────────────────────────────────────────────
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'ECS Fargate API service',
      allowAllOutbound: true,
    });

    // ── RDS Postgres (primary region only) ────────────────────────────────────
    // Secondary regions connect to the primary's RDS via DATABASE_URL; they do
    // not provision their own instance. Cross-region DB reads add ~80–100ms
    // latency but only occur on cold cache misses (hot path is served from
    // snapshotCache and authCache).
    let database: rds.DatabaseInstance | undefined;
    if (isPrimary) {
      const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
        vpc,
        description: 'RDS Postgres - accept from ECS API',
        allowAllOutbound: false,
      });
      rdsSg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'Allow Postgres from ECS API');

      database = new rds.DatabaseInstance(this, 'Database', {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        credentials: rds.Credentials.fromGeneratedSecret('postgres', { secretName: '/vexillo/rds-credentials' }),
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [rdsSg],
        databaseName: 'vexillo',
        multiAz: false,
        storageEncrypted: true,
        deletionProtection: false,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        backupRetention: cdk.Duration.days(7),
      });
    }

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
      enableFargateCapacityProviders: true,
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
    databaseUrlParam.grantRead(executionRole);
    betterAuthSecretParam.grantRead(executionRole);
    oktaSecretKeyParam.grantRead(executionRole);
    internalSecretParam.grantRead(executionRole);

    // ── Task role (runtime: Secrets Manager for RDS credentials) ─────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'vexillo-ecs-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    database?.secret?.grantRead(taskRole);
    // Required for ECS Exec (aws ecs execute-command)
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    // ── CloudWatch log group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/vexillo/api',
      retention: logs.RetentionDays.ONE_WEEK,
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
      desiredCount: 2,
      securityGroups: [apiSg],
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      assignPublicIp: true,
      enableExecuteCommand: true,
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE',      weight: 1, base: 1 },
        { capacityProvider: 'FARGATE_SPOT', weight: 4, base: 0 },
      ],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/python:3.11-alpine'),
        containerPort: 8080,
        command: ['python3', '-m', 'http.server', '8080'],
        executionRole,
        taskRole,
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
        environment: { PORT: '8080', NODE_ENV: 'production', APP_URL: cdk.Lazy.string({ produce: (): string => `https://${distribution.domainName}` }) },
        // ECS reads these from SSM and injects as env vars before the container starts.
        secrets: {
          DATABASE_URL:                ecs.Secret.fromSsmParameter(databaseUrlParam),
          BETTER_AUTH_SECRET:          ecs.Secret.fromSsmParameter(betterAuthSecretParam),
          BETTER_AUTH_URL:             ecs.Secret.fromSsmParameter(ssmParams['/vexillo/BETTER_AUTH_URL']),
          BETTER_AUTH_TRUSTED_ORIGINS: ecs.Secret.fromSsmParameter(ssmParams['/vexillo/BETTER_AUTH_TRUSTED_ORIGINS']),
          SUPER_ADMIN_EMAILS:          ecs.Secret.fromSsmParameter(ssmParams['/vexillo/SUPER_ADMIN_EMAILS']),
          OKTA_SECRET_KEY:             ecs.Secret.fromSsmParameter(oktaSecretKeyParam),
          // Shared cross-region secret: primary uses it to sign outbound POSTs;
          // secondary uses it to verify inbound /internal/flag-change requests.
          INTERNAL_SECRET:             ecs.Secret.fromSsmParameter(internalSecretParam),
          // Comma-separated ALB base URLs of secondary regions. Set by the operator
          // after deploying each secondary stack. Leave as placeholder in secondaries.
          SECONDARY_REGION_URLS:       ecs.Secret.fromSsmParameter(ssmParams['/vexillo/SECONDARY_REGION_URLS']),
        },
      },
    });

    // Give the container 120 s to drain SSE connections on SIGTERM before ECS
    // force-kills it. Matches Bun's idleTimeout and the Fargate Spot 2-min notice.
    apiService.taskDefinition.defaultContainer?.addStopTimeout(cdk.Duration.seconds(120));

    // ALB target group health check
    apiService.targetGroup.configureHealthCheck({
      path: '/api/health',
      healthyHttpCodes: '200-404', // 404 allows the CDK placeholder to pass; real API returns 200
      interval: cdk.Duration.seconds(15),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // ECS Service Auto Scaling — min 2 tasks for HA; scale out at 65% CPU
    const scaling = apiService.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
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
      cachePolicyName: 'vexillo-sdk-flags-5m',
      defaultTtl: cdk.Duration.seconds(300),
      maxTtl: cdk.Duration.seconds(600),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization', 'CloudFront-Viewer-Country', 'Origin'),
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

    // No-cache policy for the SSE stream: TTL=0 so nothing is cached, but
    // Authorization is listed so CloudFront forwards it to the origin (CF blocks
    // Authorization in OriginRequestPolicy; it must travel via CachePolicy).
    const sdkStreamCachePolicy = new cloudfront.CachePolicy(this, 'SdkStreamCachePolicy', {
      cachePolicyName: 'vexillo-sdk-stream-no-cache',
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
      minTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // SDK-specific policy: explicitly forwards CloudFront-Viewer-Country (a
    // CloudFront-generated header excluded from OriginRequestHeaderBehavior.all())
    // so the origin can apply geo-targeted flag evaluation.
    const sdkOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'SdkOriginRequestPolicy', {
      originRequestPolicyName: 'vexillo-sdk-forward-country',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'CloudFront-Viewer-Country',
        'Origin',
        'Last-Event-ID',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // ── CloudFront Response Headers Policy (SPA only) ─────────────────────────
    // Applied to the default (S3) behavior so every SPA page response gets
    // security headers. The /api/* behaviors are excluded — Hono handles its
    // own headers via secureHeaders() middleware.
    //
    // CSP notes:
    //   - 'unsafe-inline' in style-src is required: Base UI (dialogs, popovers,
    //     dropdowns) injects inline styles for dynamic positioning at runtime.
    //   - connect-src 'self' covers all /api/* calls via the same CloudFront domain.
    //   - No external font, script, or image origins — all assets are self-hosted.
    const spaResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SpaResponseHeaders', {
      responseHeadersPolicyName: 'vexillo-spa-security-headers',
      // Ensures CloudFront custom error pages (403/404 → index.html) carry ACAO
      // so SDK clients can read API error responses cross-origin. override:false
      // means API behaviors that already set their own ACAO are unaffected.
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['Authorization', 'Content-Type'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: ['*'],
        originOverride: false,
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
          override: true,
        },
      },
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
        responseHeadersPolicy: spaResponseHeadersPolicy,
      },
      additionalBehaviors: {
        '/api/sdk/flags': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: sdkFlagsCachePolicy,
          originRequestPolicy: sdkOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: false,
        },
        '/api/sdk/flags/stream': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: sdkStreamCachePolicy,
          originRequestPolicy: sdkOriginRequestPolicy,
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
    if (database) {
      new cdk.CfnOutput(this, 'RdsEndpoint', {
        description: 'RDS endpoint - used by setup-secrets.sh to build DATABASE_URL',
        value: database.dbInstanceEndpointAddress,
        exportName: 'VexilloRdsEndpoint',
      });
    }
  }
}
