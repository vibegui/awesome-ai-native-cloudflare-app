---
name: cloudflare-egress-audit
description: Audit a Cloudflare-fronted app with high bandwidth, low cache hit rate, or one URL eating a large share of traffic. Use when cf-cache-status is HIT in a curl test but real traffic still misses, when warm responses are still huge, when an upstream API bill or origin load is high despite "caching", or when one route dominates bandwidth. Covers the traps that look cached but bypass cache, trimming payloads before render and cache, safe redirect caching, and a verification checklist.
---

# Cloudflare egress and hit-rate audit

Worker responses carry no bandwidth bill on the Workers plan. Bytes still cost
you: origin and upstream API load, CPU spent re-rendering misses, and
visitors' load time. On one high-traffic site, the four traps below together
cut weekly egress by roughly two thirds. One large listing page shrank ~10×
from payload trimming alone.

## Get the numbers first

- Top URLs by bandwidth and by requests, with cache status (zone Analytics →
  Traffic / Cache, or Logpush data if you have it).
- Hit rate for anonymous traffic. Under ~60% on mostly-anonymous traffic means
  something is bypassing.
- Bytes per response on the top routes, compressed and raw.

Then check the traps **in this order**. Earlier ones make later ones read wrong.

## Trap 1: the cache key or cache gate rejects real traffic

**Smell.** Headers look right and your `curl` gets `HIT`, but real visitors
mostly miss. Your own cache store has very few keys, or one giant one.

**Cause.** The "is this request cacheable?" check rejects visitors who carry
harmless marketing state: `utm_*` params, an ad click id, a campaign cookie set
by a third party. Your test request has none of it. Most real visitors do.

**Fix.**
- Bypass the cache only for dimensions that **change the response** (logged-in
  session, private price list, region-specific stock), never for marketing tags.
- Drop tracking params and tracking cookies from the key (see `cloudflare-edge-caching` §2).
- Add a zone Cache Rule that excludes tracking query params from the edge cache
  key. Code-level fixes don't help the zone cache.

**Verify.** Request the same page as several visitor profiles (no cookies,
default cookies, UTM-tagged cookie, `?gclid=…&fbclid=…`) and assert the body
fingerprint (e.g. the ordered list of item ids) matches, and the second request
of each is a `HIT`.

## Trap 2: payload bloat inside the HTML

**Smell.** `HIT`, but warm responses are still 150 KB+ compressed, or several MB raw.

**Cause.** SSR serializes upstream objects whole into the page (hydration state,
island props, JSON in `<script>`). Upstream APIs return far more than a card
needs: every price/installment variant, every image size, full nested
"related items" each carrying its own full graph. The edge then caches and ships
the bloat on every hit.

**Fix: trim before render and before caching.**
1. List every consumer of the object and the fields each one reads. Grep;
   don't guess.
2. Write a `trimForCard(item)` that keeps exactly those fields. Cut nested
   arrays hard (related items keep id, thumbnail, availability). Set nested
   self-references to `undefined` so a future upstream change can't re-bloat it
   geometrically.
3. Leave detail-page consumers on the full object. Trim only list/card paths.
4. Apply the trim **inside the cached loader, before returning**, so the cache
   stores the small version. Apply it on client-side "load more" paths too.

**Verify.**
```bash
curl -s "$URL" | wc -c                           # raw bytes
curl -s --compressed "$URL" -o /dev/null -w '%{size_download}\n'   # wire bytes
curl -s "$URL" | grep -o 'SomeBloatMarker' | wc -l   # count a repeated type name before/after
```
Then check visually: cards, swatches, size pickers, price text, load-more, detail page.

## Trap 3: `Vary` fragmentation

**Smell.** A static URL (`/sprites.svg`, an icon, a font) is `MISS` on every request.

**Cause.** Something emits `Vary` with a token that isn't content negotiation:
`Vary: If-None-Match`, `Vary: Cookie`, `Vary: User-Agent`. Caches that honor it
fragment per value.

**Fix.** Normalize `Vary` on every response branch (2xx, redirects, errors):

```ts
function normalizeVary(h: Headers) {
  const keep = (h.get("vary") ?? "").split(",").map((t) => t.trim())
    .filter((t) => t && !/^(if-none-match|cookie|user-agent)$/i.test(t));
  keep.length ? h.set("vary", keep.join(", ")) : h.delete("vary");
}
```

Keep `ETag`, since 304s still work. Give versioned static assets a long edge TTL
with a Cache Rule.

## Trap 4: redirects that always go to origin

**Smell.** Top navigation links (`/shoes` → `/shoes-all`) show `BYPASS`/`DYNAMIC`.
Every click round-trips just to learn the destination.

**Cause.** 3xx responses leave the Worker with no cache headers.

**Fix.** Cache same-origin redirects at the edge, **only when safe**. A cached
leg of a redirect loop freezes the loop for the TTL.

```ts
if (res.status >= 300 && res.status < 400) {
  let to: URL | null = null;
  try { to = new URL(res.headers.get("location") ?? "", url); } catch {}
  const safe = to && to.host === url.host && to.protocol === url.protocol &&
    !(to.pathname === url.pathname && to.search === url.search);
  if (safe) {
    const h = new Headers(res.headers);
    h.set("cache-control", "public, s-maxage=86400, stale-while-revalidate=86400");
    return new Response(null, { status: res.status, headers: h });
  }
}
```

That rules out cross-host hops (naked↔www), protocol downgrades and self-redirects.

## Also check

- [ ] SPA fallback answering `/assets/missing.js` with `index.html` + an immutable
      header. It caches HTML as JS and blanks the site. Return 404 + `no-store` for
      unknown asset paths, and reject the wrong MIME under `/assets/*`.
- [ ] Bots crawling combinatorial URLs (`?filter=a&filter=b&…`), each a unique
      miss. That's a WAF problem, see `cloudflare-waf-and-bots`.
- [ ] Large downloads served through the Worker that could come straight from R2
      or static assets.
- [ ] `Set-Cookie` on cacheable routes (see `cloudflare-edge-caching` §3).

## Verification checklist (after each fix ships)

- [ ] Same page, four visitor profiles: same body fingerprint, second request `HIT`.
- [ ] Warm `HIT` body size on top routes is under your budget (e.g. < 100 KB compressed for a list page).
- [ ] Static assets: `HIT`, no fragmenting `Vary`.
- [ ] Top-nav redirects: `HIT` after the first request, no loops (`curl -L --max-redirs 5`).
- [ ] A week later: hit rate and bandwidth per top URL, compared with the baseline you saved.
- [ ] Put a payload-size and same-fingerprint check in an e2e test so a refactor can't silently undo it.
