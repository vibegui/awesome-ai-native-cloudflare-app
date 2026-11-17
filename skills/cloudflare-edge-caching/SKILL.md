---
name: cloudflare-edge-caching
description: Make a Cloudflare Worker's responses actually cache at the edge, and keep in-Worker caches correct. Use when setting Cache-Control per route, building cache keys, using caches.default or an in-memory fetch cache, debugging cf-cache-status MISS/BYPASS/DYNAMIC, or when a page that "should cache" comes back no-store. Covers route cache profiles, cache-key hygiene, what silently turns a page into no-store (cookies, per-request variants, Vary), single-flight dedupe, SWR with LRU/TTL, and caching failures briefly without caching broken results.
---

# Cloudflare edge caching for Workers

Three layers, each with its own failure mode:

| Layer | Where | Lifetime | Controlled by |
|---|---|---|---|
| Edge / zone cache | Cloudflare location | TTL from headers or Cache Rules | `Cache-Control`, Cache Rules |
| Cache API (`caches.default`) | per location, from your code | what you `put` | `cache.match` / `cache.put` |
| In-isolate memory | one isolate | until the isolate recycles | a `Map` you bound yourself |

## 1. One cache profile per route type

Decide the policy in one place, the Worker entry, not scattered per handler.

| Profile | Example routes | Cache-Control |
|---|---|---|
| immutable | hashed assets `/assets/*-<hash>.*` | `public, max-age=31536000, immutable` |
| static | home, about, docs | `public, max-age=300, s-maxage=86400, stale-while-revalidate=86400` |
| detail | item pages | `public, max-age=60, s-maxage=300, stale-while-revalidate=3600` |
| listing | lists, categories | `public, max-age=30, s-maxage=120, stale-while-revalidate=600` |
| search | `?q=` | `public, max-age=0, s-maxage=60, stale-while-revalidate=300` |
| private | cart, account, login, admin | `private, no-store` |
| api | `/mcp`, JSON-RPC, webhooks | `no-store` |

```ts
function profileFor(url: URL): Profile {
  if (url.pathname.startsWith("/assets/")) return "immutable";
  if (/^\/(cart|account|login|admin)/.test(url.pathname)) return "private";
  if (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/api/")) return "api";
  if (url.searchParams.has("q")) return "search";
  return "listing";                                   // conservative default
}
```

Values are starting points. Tune with real hit rates.

- `/mcp` responses get `no-store`. An MCP client that polls can otherwise
  hammer the Worker from a cached error or never see fresh state.
- Only cache `GET`. The Cache API never caches `POST`. If you need to cache
  tool results (every MCP call is a POST), `put` them under a hand-built `GET`
  key.
- Cache only `200`. Same-origin redirects can be cached too, but only after the
  safety checks in `cloudflare-egress-audit`.
- When you `cache.put`, set `max-age` on the stored copy to the edge TTL you
  want. Don't count on `s-maxage` being read there; check the current Cache API
  docs.
- Test the Cache API on a custom domain. Check the docs for how it behaves on
  `*.workers.dev`.

## 2. Cache keys: one URL, one body

- **Strip tracking params** before building the key: `utm_*`, `gclid`,
  `gad_*`, `gbraid`, `wbraid`, `fbclid`, `_gl`. Otherwise every ad click is a
  new cache entry. Do it in code for the Cache API, and with a Cache Rule
  (cache key, query string exclude) for the zone cache. Check which cache-key
  options your plan has.
- **Never store a MISS for `?gclid=…` under the clean URL** unless the body is
  really identical. One app stored a tracking-param response as the canonical
  page.
- **Stable keys.** `JSON.stringify` depends on property order. Sort keys when the
  key comes from an object.
- **Only the dimensions that change the body** go in the key: locale, currency,
  device class *if* the HTML differs. Every extra dimension divides the hit rate.
- **The zone cache ignores `Vary`** (apart from encoding). Serve one content type
  per URL. Don't rely on `Vary: Accept` or a region header to split variants.
  Put the variant in the URL or in a key you build yourself. Varying on a region
  header once split the cache into 27 copies of every page.

## 3. What silently turns a page into no-store

Work down this list when a page that should cache shows `no-store`, or
`cf-cache-status` is `BYPASS`/`DYNAMIC`:

- [ ] **`Set-Cookie` on the response.** Cloudflare does not cache it by default.
      Move analytics/session cookies to client-side JS, or drop them on cacheable routes.
- [ ] **A per-user call during render.** "Hi, name" in the header, a cart badge, a
      session lookup. One personalized call in a shared layout makes *every* page
      private. Render a stable shell and hydrate the personal bits from the browser.
- [ ] **A per-request variant** (A/B bucket, random pick, time-of-request) whose
      code path sets `no-store` to be safe. Make the variant deterministic from
      something in the key (a sticky cookie you key on, the date), or accept the
      bias: the first cold visitor's variant is served for the whole TTL. That's
      fine for cosmetic tests and wrong for big content swaps.
- [ ] **A data loader with no cache policy that defaults to no-store** and poisons
      the whole page. Audit for "no explicit policy" across all data sources a page
      touches.
- [ ] **A `Vary` header with a non-negotiation token** (`If-None-Match`, `Cookie`, `User-Agent`).
- [ ] **HEAD requests in your test.** `curl -I` sends HEAD. Test with GET:
      `curl -s -D - -o /dev/null URL`.

## 4. Single-flight: one upstream call per key at a time

Several components often need the same payload in one render. Dedupe per request:

```ts
const flights = new Map<string, Promise<unknown>>();     // created per request
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  let p = flights.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run().catch((e) => { flights.delete(key); throw e; });  // don't pin failures
    flights.set(key, p);
  }
  return p;
}
```

A promise shared **across requests** at module scope is riskier. If the request
that created it ends first, its I/O can be cancelled and every later request in
that isolate waits on it. One such hang held requests ~15 s each after every deploy.
Keep cross-request work alive with `ctx.waitUntil(p)` and race it against a timeout.

## 5. In-isolate SWR fetch cache (LRU + TTL)

For hot upstream GETs inside one isolate:

- **Bounded**: max entries (e.g. 500), evict least recently used. An unbounded
  `Map` is a memory leak with a hit rate.
- **TTL by status**: 2xx long (minutes), 404 short (seconds), 5xx/timeouts not
  stored as data. Record them in a short negative-cache marker instead (see
  `cloudflare-request-budget`).
- **Stale-while-revalidate**: serve the stale entry and refresh in
  `ctx.waitUntil`, with single-flight so only one refresh runs per key.
- **Versioned keys**: prefix with the deploy version (the `version_metadata`
  binding id) when a deploy must invalidate.
- It resets when the isolate recycles and is not shared across locations. Use it
  as an accelerator, never as the source of truth.

## 6. Don't cache broken results; do cache failures briefly

- An upstream returning `null`, an empty list *because it failed*, or a partial
  payload must not be stored for the full TTL. Throw or mark it, so the cache
  skips it. One empty listing, cached for 30 minutes, showed blank pages to every
  visitor.
- But don't skip caching the failure entirely. A short negative entry (30–120 s)
  stops every visitor from retrying a dead upstream.
- Trim payloads **before** caching. The cache stores what you return, and every
  HIT ships it.

## Verify

```bash
URL=https://example.com/some/page
curl -s -D - -o /dev/null "$URL" | grep -iE 'cache-control|cf-cache-status|age|vary|set-cookie'
curl -s -D - -o /dev/null "$URL" | grep -iE 'cf-cache-status|age'      # expect HIT, age > 0
curl -s -D - -o /dev/null "$URL?utm_source=test" | grep -i cf-cache-status   # expect HIT, same entry
```

- [ ] Second GET is `HIT` with a growing `age`.
- [ ] Tracking params don't create a new entry.
- [ ] Private routes return `private`/`no-store` and never `HIT`.
- [ ] No `Set-Cookie` on cacheable routes.
- [ ] Edge-cached HTML can outlive a deploy by minutes. Purge or version when it matters.
