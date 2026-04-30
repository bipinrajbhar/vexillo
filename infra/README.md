# Vexillo infrastructure

Vexillo deploys as a Kubernetes service in the rhapsody EKS cluster, with
Postgres provisioned outside K8s as a managed RDS instance.

| Component | Provisioned by |
|-----------|----------------|
| K8s deployment + service + ingress | Helm charts under [`../k8s/`](../k8s/) — applied by the `jenkins-rhapsody-libraries` `DockerBuildPipeline` (see [`../Jenkinsfile`](../Jenkinsfile)) |
| Container image | Built from [`../Dockerfile`](../Dockerfile) by the same Jenkins pipeline |
| RDS PostgreSQL | rhapsody Terraform RDS module — **TODO: add Terraform here** |
| S3 + CDN (Akamai/CloudFront) for the SPA | **Future:** when the SPA is moved off the K8s container, see _SPA hosting_ below |
| Secrets | Vault — **in-progress migration**; non-secret env-vars live in the per-env `helm-deployment.yaml` files |
| VPC, IAM, CloudWatch logs | Existing rhapsody platform — no per-app provisioning required |

## RDS PostgreSQL

A managed RDS instance is the source of truth for vexillo's flag/org/member
data. It must be reachable from the EKS cluster's pod subnets. Provision it
through the org's existing Terraform RDS module (separate repo) and inject
the connection string into the K8s deployment via Vault as `DATABASE_URL`.

Until Vault wiring is in place, `DATABASE_URL` is stubbed in each
`k8s/<env>/helm-deployment.yaml` and must be filled in before promoting a
build to that environment.

The Bun container runs `drizzle-kit migrate` on startup
(see [`../apps/api/start.sh`](../apps/api/start.sh)) — migrations are
idempotent and safe to run on every deploy.

## SPA hosting

The Vite SPA is currently bundled into the container image and served by the
Hono API (`SERVE_SPA=true`). When the SPA is moved to S3 + CDN per the
project plan:

1. Stand up an S3 bucket + Akamai/CloudFront distribution (out of scope here —
   Robert is helping with this).
2. Configure the CDN to route `/` → S3, `/api/*` → the K8s ingress.
3. Set `SERVE_SPA=false` in the helm `envVars` (or stop bundling
   `apps/web/dist` into the container — see the runtime stage in
   [`../Dockerfile`](../Dockerfile)).
4. Publish the SPA build to S3 from CI (Jenkins or a dedicated workflow).

The application itself requires no code change at the cutover.

## Vault migration

All secrets currently live as inline placeholders in each
`k8s/<env>/helm-deployment.yaml` (`DATABASE_URL`, `BETTER_AUTH_SECRET`,
`OKTA_SECRET_KEY`, `INTERNAL_SECRET`, `REDIS_URL`). Once Vault paths are
provisioned, replace each placeholder with the rhapsody Vault reference
syntax used by the other services in the org.
