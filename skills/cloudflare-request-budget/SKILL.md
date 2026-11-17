---
name: cloudflare-request-budget
description: Budget the upstream requests a Cloudflare Worker makes before shipping anything that fetches. Use when adding a page, tool or cron that calls an external API or another Worker, when an upstream is rate-limiting or blocking you, when a page "does a lot of fetches", or when designing caching for shared expensive data. Covers worst-case fan-out math, caps and budgets per loop, cron-built snapshots served stale-while-revalidate, negative caching, failed-vs-empty results, service bindings between your own Workers, per-caller rate limits, tagged test traffic and measuring in production.
---

# Cloudflare request budget

A Worker is cheap per request. What it *calls* is not: the upstream API, the
paid model, your own other Worker. Most outages on this stack are a loop that
nobody multiplied out, followed by a retry storm against an upstream that was
already failing. Every rule below was broken once in production.

## 1. Write down the worst case before you build

```
upstream reads per view = items × sources × reads per source   (when EVERY call fails)
```

- Compute it for the failure case, not the happy path. Failure is when loops
  stop short-circuiting and walk every source.
- Above ~20 upstream reads per view: redesign before writing code.
- Put the number in the PR description. If nobody can state it, it is unknown.

A home page with 18 cards × 57 sources × 1 read = ~1,000 upstream reads per
visit. Nobody had multiplied it out.

## 2. Every network loop has a cap and a budget

Two limits, both required: max attempts per item, and a total read budget per
request. `continue` on failure inside an unbounded loop is a fan-out bomb.

```ts
const PER_ITEM = 3;          // attempts per item
let budget = 20;             // total upstream reads for this request

for (const item of items) {
  let tries = 0;
  for (const source of sourcesFor(item)) {
    if (budget-- <= 0 || tries++ >= PER_ITEM) break;
    const r = await tryFetch(source, item).catch(() => null);
    if (r) { item.result = r; break; }
  }
  if (budget <= 0) break;    // out of budget: stop, report partial
}
```

Give every `fetch` a deadline: `fetch(url, { signal: AbortSignal.timeout(5000) })`.

## 3. Shared, expensive data is never computed on a visitor's request

If many visitors need the same expensive result (a ranking, a catalog
summary, an aggregate across sources), build it ahead:

1. A cron (`triggers.crons` + `scheduled()`) builds a snapshot into **one KV
   key**.
2. The request path reads that one key. No upstream calls.
3. When the snapshot is stale: serve the stale copy, rebuild in the
   background (`ctx.waitUntil`), behind a **lock** so concurrent visitors don't
   all rebuild.
4. Only the very first request may build inline. Warm it yourself right after
   deploying.
5. A rebuild never replaces a good snapshot with a worse one. Compare counts
   (items, ok sources) and keep the old one if the new one is smaller or
   mostly failed.

```ts
const snap = await env.KV.get<Snapshot>("snap:home", "json");
if (snap && Date.now() - snap.builtAt > STALE_MS) {
  ctx.waitUntil(rebuildWithLock(env));      // lock = KV key with short expirationTtl
}
return snap ?? (await rebuildWithLock(env, { inline: true }));
```

A KV lock is best-effort (KV is eventually consistent). It stops a stampede,
not every duplicate. If two builds must never overlap (paid calls, sends), take
the lease in D1 with a conditional `UPDATE` instead. Crons are at-least-once.

## 4. Cache failures too, briefly

"Don't cache incomplete results" without a short **negative cache** means every
visit retries the failing work: a retry storm against an upstream that is
already down.

- On failure, write a short-lived marker (`fail:<key>`, 30–120 s TTL).
- While the marker exists, serve the last good value or an explicit "temporarily
  unavailable". Don't call the upstream again.
- Successful results get the long TTL; failures get the short one.

## 5. "Upstream failed" ≠ "nothing found", end to end

Count `ok` and `failed` per request and carry both to the response:

```ts
type SourceResult<T> = { ok: number; failed: number; items: T[] };
```

- `failed > 0 && ok === 0`: tell the user (and the log) that the source is
  down. Do not render "no results".
- An LLM told "0 results" will confidently say the store doesn't sell it.
  Give tool results a status field the model can read.
- A 403 or 429 rendered as an empty list hides the fact that you are blocked.

## 6. Your own Workers are first-party to each other

Service-to-service calls between your Workers go over a **service binding** to
a named entrypoint the callee trusts, never over the public internet:

```jsonc
// caller wrangler.jsonc
"services": [{ "binding": "CATALOG", "service": "catalog", "entrypoint": "Internal" }]
```
```ts
// callee
import { WorkerEntrypoint } from "cloudflare:workers";
export class Internal extends WorkerEntrypoint<Env> {
  async search(q: string) { return search(this.env, q); }  // skips bot heuristics
}
```

The callee exempts this entrypoint from its own bot/scraper heuristics. Because
it is not reachable from the internet, the exemption can't be forged. Without it,
one product's anti-scraper sweep can blocklist another product for a week, and
the caller's failing retries keep renewing the block.

## 7. Automatic blocks expire and alert

Anything that bans a client by itself (an IP blocklist in KV, a WAF rule a
script created) must:
- expire on its own (`expirationTtl`, or an expiry date the cleanup cron enforces);
- be visible somewhere a human looks (a log line you alert on, an admin screen, a message).

## 8. Paid calls are rate-limited per caller

Anything that triggers a paid call (LLM, SMS, a metered API) gets a per-caller
limit with the Workers Rate Limiting binding, keyed on `CF-Connecting-IP` or the
user id. Counts are per Cloudflare location, so it is a cheap filter, not a
global quota. POST APIs meant for your own pages also check `Origin` /
`Sec-Fetch-Site`. See `worker-security-baseline`.

## 9. Tag test traffic

Load and smoke tests against production carry an identifiable marker (id prefix,
a header, `utm_source=test`) so analytics can exclude them. Bursts from your own
machine count against the same shared limits and can trip the same automatic
blocks real abusers do.

## 10. Query analytics by indexed columns

If you keep first-party analytics in D1, filter on what the index covers
(e.g. `name, ts`), not on a convenient unindexed column. One dashboard query
scanned 436k rows to return 83. Check with `EXPLAIN QUERY PLAN`.

## 11. Measure in production before saying it's fixed

"It typechecks" was true for every bug above.

- [ ] Replay the exact failing case against production.
- [ ] Count the upstream requests it caused (logs, subrequest counts in Workers analytics).
- [ ] Kill the upstream (or point at a bad host) and count again: is the failure case still under budget?
- [ ] Look at the screen: does a failed source say so?
- [ ] Re-check a day later that the snapshot cron is running and the negative cache is not stuck.
