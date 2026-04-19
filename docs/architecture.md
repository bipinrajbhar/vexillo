# Architecture

> Scale context: ~1M visits/month, e-commerce storefront.

---

## System Overview

```mermaid
graph TD
    subgraph Clients
        Dashboard["Dashboard UI\n(React SPA)"]
        SDK_REST["SDK — REST mode\ncreateVexilloClient()"]
        SDK_SSE["SDK — Streaming mode\ncreateVexilloClient()"]
    end

    subgraph Edge
        CF["CloudFront\n(global CDN)"]
        S3["S3\n(SPA assets)"]
    end

    subgraph Primary["Primary Region (us-east-1)"]
        ALB_P["ALB"]
        ECS_P["ECS Fargate\n(2–4 tasks)"]
        RDS["RDS Postgres"]
    end

    subgraph Secondary["Secondary Region (eu-west-1, …)"]
        ALB_S["ALB"]
        ECS_S["ECS Fargate\n(2–4 tasks)"]
    end

    Dashboard -->|"GET /"| CF
    CF -->|SPA assets| S3
    CF -->|"/api/dashboard/*\n(no cache)"| ALB_P
    CF -->|"/api/sdk/flags\n(300s cache)"| ALB_P
    CF -->|"/api/sdk/flags/stream\n(no cache)"| ALB_P

    SDK_REST -->|"GET /api/sdk/flags"| CF
    SDK_SSE -->|"GET /api/sdk/flags (race)"| CF
    SDK_SSE -->|"GET /api/sdk/flags/stream"| CF

    ALB_P --> ECS_P
    ECS_P --> RDS

    ECS_P -->|"POST /internal/flag-change\n(fire-and-forget)"| ALB_S
    ALB_S --> ECS_S
    ECS_S -->|"cross-region read"| RDS
```

---

## Flag Toggle — Propagation Flow

When an admin toggles a flag in the dashboard, updates reach all connected clients within seconds.

```mermaid
sequenceDiagram
    participant Admin as Dashboard UI
    participant API as ECS (primary, task that handled request)
    participant DB as RDS
    participant Cache as snapshotCache
    participant SSE_P as SSE clients (same task only)
    participant Sec as ECS (secondary)
    participant SSE_S as SSE clients (secondary, same task only)

    Admin->>API: POST /api/dashboard/.../toggle
    API->>DB: UPDATE flagStates SET enabled = …
    API->>Cache: snapshotCache.set(envId, payload)
    API-->>Sec: POST /internal/flag-change (fire-and-forget)
    API->>SSE_P: in-process broadcast (streamRegistry)
    SSE_P-->>Admin: SSE event (if streaming)

    Sec->>Cache: snapshotCache.set(envId, payload)
    Sec->>SSE_S: in-process broadcast (streamRegistry)
```

The fan-out to secondary regions is fire-and-forget — it does not block the primary's response. If the secondary misses an event, its `snapshotCache` expires after 30 s and the next request re-queries RDS in us-east-1 as a fallback.

> **Multi-task SSE limitation:** SSE broadcasts are in-process only. A toggle handled by task A is not seen by SSE clients connected to tasks B, C, or D. Those clients receive the update when their `snapshotCache` expires (≤30 s) or when they reconnect. To fan-out across all tasks in a region, set `REDIS_URL` — the app uses Redis pub/sub when the variable is present, but Redis is not provisioned by the CDK stack.

---

## REST Request — Cache Layers

A REST client hitting `/api/sdk/flags` passes through three cache layers before touching the database.

```mermaid
flowchart LR
    Client["SDK\nGET /api/sdk/flags"]
    CF["CloudFront\n300s TTL\n+60s stale-while-revalidate"]
    Auth["authCache\n30s LRU\nAPI key → env lookup"]
    Snap["snapshotCache\n30s LRU\nflag snapshot per env"]
    DB["RDS Postgres"]

    Client --> CF
    CF -->|"cache miss (<5% of requests)"| Auth
    Auth --> Snap
    Snap -->|"cache miss"| DB
    DB -->|"result cached immediately"| Snap
```

At 1M visits/month, over 95% of requests are served from CloudFront without reaching ECS.

---

## Streaming — Connection Lifecycle

SSE broadcasts are in-process within a single ECS task. If `REDIS_URL` is set, the app uses Redis pub/sub to fan out across all tasks; otherwise only clients on the same task as the toggle receive the real-time event.

```mermaid
sequenceDiagram
    participant SDK as SDK (streaming mode)
    participant CF as CloudFront
    participant ECS as ECS (one task)

    SDK->>CF: GET /api/sdk/flags (REST race)
    SDK->>CF: GET /api/sdk/flags/stream (SSE)
    CF-->>ECS: /api/sdk/flags (cache hit, ~50ms)
    ECS-->>SDK: {flags: […]} → isReady = true

    CF-->>ECS: /api/sdk/flags/stream (no cache)
    ECS-->>SDK: SSE: initial snapshot (overwrites REST)

    loop on flag toggle (same task only without Redis)
        ECS-->>SDK: SSE: updated snapshot
    end

    loop every 25s
        ECS-->>SDK: SSE: ": keepalive"
    end

    SDK->>ECS: disconnect / reconnect
```

The REST race on connect means `isReady` is `true` and components render with real values before the SSE handshake completes. The SSE snapshot then overwrites the cached REST value once it arrives.

---

## Infrastructure Summary

What the CDK stack (`infra/lib/vexillo-stack.ts`) actually provisions:

| Component | Detail |
|---|---|
| CloudFront | Global CDN; caches `/api/sdk/flags` at edge (300 s + 60 s SWR); no cache for dashboard or SSE |
| ECS Fargate | 256 CPU / 512 MB per task; 2 min, 4 max; scales at 65% CPU; 120 s idle timeout (SSE kept alive by 25 s keepalives) |
| RDS Postgres | t4g.micro; primary region only; isolated VPC subnet; 7-day backup retention |
| S3 | SPA assets (dashboard); private bucket, served via CloudFront OAC |
| Secondary regions | No RDS — ECS tasks in the secondary connect to the primary's RDS via `DATABASE_URL` |
| `/internal/flag-change` | ALB-only route (not exposed via CloudFront); protected by `X-Internal-Secret` header |

> **Redis is not provisioned by CDK.** The app supports it via `REDIS_URL` for cross-task SSE fan-out, but it must be provisioned and wired up manually.
