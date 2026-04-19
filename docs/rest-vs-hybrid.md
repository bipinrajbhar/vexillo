# REST vs. Hybrid

> Scale context: ~1M visits/month, e-commerce storefront.

---

## TL;DR

**Use both.** REST by default for the majority of traffic; streaming opt-in for pages where flag latency is business-critical (checkout, flash sales, kill switches). The hybrid is more capable than pure REST and significantly cheaper than running streaming everywhere.

In a **multi-region** deployment, the calculus shifts further: streaming eliminates the need for a secondary database, while REST does not. At two regions, the hybrid is cheaper than pure REST once you factor in the secondary RDS.

---

## How streaming actually works

Streaming mode (`<VexilloClientProvider streaming>`) is itself a hybrid under the hood:

1. **REST prefetch first** — `connectStream()` fires `GET /api/sdk/flags` immediately. This hits the CloudFront cache and resolves in under 50 ms, so `isReady` is `true` and components render with real flag values before the SSE handshake completes.
2. **SSE connection second** — once established, the server sends the full live snapshot (overwriting the cached REST value) and then pushes a new snapshot on every toggle.

The REST prefetch is intentional, not a cost concern — it's CDN-cached and costs a fraction of a cent per connect. The SSE connection is what carries the real-time update cost.

---

## Comparison

| | REST | Hybrid (recommended) |
|---|---|---|
| Flag freshness (single-region) | Up to ~6 min | Up to ~6 min (REST pages) / ~5–20 ms (streaming pages) |
| Flag freshness (multi-region) | Up to ~6 min (CloudFront TTL unaffected by fan-out) | <5 s on streaming pages |
| CDN-cacheable | Yes | Yes (REST prefetch + REST-only pages) |
| Persistent connections | None | Only for streaming pages — a fraction of total traffic |
| Redis required | No | Optional — recommended for multi-task SSE fan-out; sized for streaming subset only |
| Secondary DB required (multi-region) | Yes | No — streaming pages keep snapshotCache warm via fan-out |
| Est. AWS cost/month (single-region) | ~$12–25 | ~$25–55 |
| Est. AWS cost/month (two regions) | ~$55–115 | ~$50–105 |

---

## Cost Breakdown

### Pure REST (~$12–25/month, single region)

CloudFront caches responses per API key. At 1M visits/month, >95% of requests are served from edge cache — fewer than 1 req/s reaches your origin.

| | Est./month |
|---|---|
| CloudFront (1M requests + ~10 GB transfer) | $2–5 |
| ECS (one small task covers origin load) | $10–20 |
| **Total** | **~$12–25** |

### Hybrid (~$25–55/month, single region)

REST handles the bulk of traffic cheaply through CloudFront. Streaming is only enabled on a small subset of pages (checkout, kill-switch-protected flows). Persistent connections and Redis are sized for that subset, not your full 1M visits/month.

| | Est./month |
|---|---|
| CloudFront (REST majority) | $2–5 |
| ECS (sized for mixed load) | $15–30 |
| ElastiCache Redis (sized for streaming subset) | $8–20 |
| **Total** | **~$25–55** |

---

## Multi-Region Cost

### Pure REST (two regions, ~$55–115/month)

Fan-out propagates snapshots to the secondary's in-memory cache, but CloudFront's edge cache is independent — REST clients still see stale responses for up to 5 minutes. To avoid cross-region DB latency on cache misses, a second database is needed.

| | Est./month |
|---|---|
| REST costs × 2 regions | $24–50 |
| RDS in secondary region | $15–30 |
| Cross-region data transfer | $5–10 |
| Fan-out infra | <$5 |
| **Total** | **~$55–115** |

> Without a secondary DB, REST cache misses in eu-west-1 fall through to RDS in us-east-1 (~80–100 ms). Acceptable for low-traffic paths; noticeable at scale.

### Hybrid (two regions, ~$50–105/month)

The streaming subset keeps `snapshotCache` warm in the secondary via fan-out, eliminating the secondary DB requirement. REST pages in the secondary still serve from CloudFront (up to 6 min lag), but the critical paths (checkout, kill switches) get <5 s propagation via streaming.

| | Est./month |
|---|---|
| Hybrid costs × 2 regions | $50–110 |
| Secondary DB | $0 — streaming keeps cache warm |
| Cross-region data transfer | <$5 |
| **Total** | **~$50–105** |

**The hybrid at two regions costs less than pure REST** once you account for the secondary database, while giving you real-time updates where they matter.

---

## When to Use Each Mode

**REST** — anything where a 5-minute flag lag is acceptable:
- Product catalog, PDPs, homepage
- SSR pages (`fetchFlags()` at request time, pass as `initialFlags`)
- Gradual rollouts, UI experiments

**Streaming** — when the lag is not acceptable:
- Flash sales toggled at an exact time
- Kill switches on a broken payment flow
- Checkout funnel A/B tests that must apply mid-session
- Any multi-region deployment where you want <5 s propagation without a secondary DB

---

## Usage

```tsx
// REST (default) — catalog, PDPs, homepage
<VexilloClientProvider client={client}>
  <CatalogPage />
</VexilloClientProvider>

// Streaming — checkout, kill switches, flash sales
<VexilloClientProvider client={client} streaming>
  <CheckoutFlow />
</VexilloClientProvider>
```

For SSR, pre-fetch to avoid a loading flash:
```ts
const initialFlags = await fetchFlags(baseUrl, apiKey)
const client = createVexilloClient({ apiKey, baseUrl, initialFlags })
// client.isReady === true before first render
```

---

## Resilience

**REST:** CDN serves stale on origin failure up to the `stale-while-revalidate` window. After that, SDK falls back to defaults (`false` for all flags).

**Streaming:** SDK auto-reconnects with exponential backoff (1 s → 30 s max). On connect, it races a REST prefetch in parallel — flags are never blank even if the SSE handshake is slow.

**Multi-region fan-out:** Fire-and-forget — if the primary cannot reach a secondary at toggle time, the event is lost. The secondary falls back to serving its cached snapshot until the 30 s TTL expires and it refetches from the primary's RDS. No retry queue; missed events are bounded by cache TTL, not indefinite.
