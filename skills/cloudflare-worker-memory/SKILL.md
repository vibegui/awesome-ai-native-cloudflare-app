---
name: cloudflare-worker-memory
description: Diagnose and fix Cloudflare Worker memory-limit errors (128 MB per isolate, error 1102). Use when a Worker exceeds its memory limit, memory P90 sits near the ceiling, CPU time or latency suddenly jumped after a deploy, or before bundling a large dataset into a Worker. Covers where Worker memory actually goes, measuring per deploy, moving big build-time data to KV, streaming instead of buffering, changes that look like memory fixes but aren't, and shipping content/config without redeploying.
---

# Cloudflare Worker memory

An isolate has 128 MB. Exceeding it is error 1102 with no JS exception to catch.
Everything reachable from module scope is paid for on **every isolate, for the
isolate's whole life**. You cannot attach a debugger in production, so reason
from bundle contents plus per-deploy metrics.

## Short version

Resident memory is almost always **data a build step put into the bundle**,
not your caches. In the incidents this skill comes from, moving big build-time
JSON out of the bundle cut memory P90 by roughly a fifth to a third per dataset.
Three separate cache changes, each made in good faith, moved P90 by under 1%.
Measure before you believe.

## 1. Where the memory is (check in this order)

1. **Big JSON imported at module scope.** A bundler that emits
   `export const data = JSON.parse("<9 MB string>")` makes you hold the escaped
   string *and* the parsed graph. A 9 MB JSON file came to ~14 MB of heap parsed,
   plus the string.
2. **Anything else materialized at build time.** Redirect tables from CSV,
   fixtures, geo tables, a schema. Thousands of rows add up fast.
3. **Double-holding.** You moved data to KV but the bundle still contains it.
   Now you hold two copies. Doing half of a migration is worse than not starting.
4. **Unbounded in-memory caches.** A `Map` with no size cap grows with distinct
   keys × payload size. It adds memory. It never saves it.
5. **Transient peaks.** One request doing `await res.text()` on a big proxied
   body (sitemap, feed, export, R2 object). See §4.

Measure a JSON file's parsed size locally before bundling it:

```bash
node --expose-gc -e 'const raw=require("fs").readFileSync(process.argv[1],"utf8");
global.gc();const a=process.memoryUsage().heapUsed;const x=JSON.parse(raw);
global.gc();console.log(((process.memoryUsage().heapUsed-a)/1048576).toFixed(1),"MB");' data.json
```

## 2. Measure per deploy, not by eyeballing

1. Pull memory, CPU and wall time **quantiles per script** at hourly
   granularity. The Workers metrics in the dashboard show them. For queries, the
   GraphQL Analytics API's Workers invocations dataset (`workersInvocationsAdaptive`)
   has per-script quantiles. Introspect the schema for the exact memory and
   CPU field names before writing the query.
2. Pull the version timeline: `wrangler deployments list` / `wrangler versions list`.
3. Find the transition hour, then re-pull at 5-minute granularity to pin it.
4. Compare the **median of buckets** across stable windows before and after,
   not single points.
5. Look for a **reversal**: a revert, or turning the change off and on again.
   Three consistent transitions in both directions is causation. One drop is a
   coincidence until proven otherwise.

Read the metrics like this:

- **P90 memory** is the number against the limit. P50 flatters you, P99.9 is noise.
- **P90 pinned flat across your change** means you didn't touch what holds the memory.
- **CPU P50 blew up**: work at cold start or module init (a big `JSON.parse` on
  the first request of every isolate), multiplied by isolate churn.
- **CPU P99 high but P50 healthy**: ordinary per-request work on the slow tail.
  Probably not memory.
- **Wall time high, CPU low**: waiting on I/O (an upstream, a hung promise), not computing.
- **Requests flat or falling?** Then it isn't load. Rule load out first, since
  everyone assumes it.

Chart memory, CPU and wall time together. Two of them will often disagree, and
they can share a cause without one causing the other.

## 3. Move big build-time data to KV

**Point-lookup tables** (redirects, id maps), thousands of rows, read rarely:

- Stop bundling the data. Confirm the bundle shrank (`wrangler deploy --dry-run --outdir dist` and check sizes).
- Upload as one KV key per row (`redir:/old-path` → `"301:/new-path"`), not one
  big array. Use the *exact* normalization the runtime uses (case, trailing
  slash), or every lookup silently misses.
- `wrangler kv bulk put` takes a JSON array. Chunk large uploads (10k entries per call).
- Run the upload *before* `wrangler deploy` in the same script, so KV is never behind the code.
- At request time: one `env.KV.get(key)`, no `list()`. Race it against a short
  deadline and fail open (no redirect). The KV binding takes no `AbortSignal`,
  so use `Promise.race`.
- Keep a small, hot set (a few dozen rows) in the bundle and check it first.
  Fifty rows aren't worth a KV read per request.

**Content/config blobs** (CMS content, a large settings document) so that a
content change needs no redeploy:

- The build writes `content:<version-id>` to KV, and a pointer `content:live`
  names the active version. CI order: **seed → deploy → flip pointer**.
- The seed step **fails the build** if it fails. The previous version keeps
  serving, which is the safe outcome.
- **Stub the data out of the bundle** in the same change. Hydrating from KV while
  the bundle still carries it is the double-hold trap.
- Treat an empty or missing snapshot as an **error (5xx, not cached)**. Never
  serve and edge-cache an empty site.
- **Module-scope init that reads the config runs before hydration** and latches
  the empty value for the isolate's life. One integration silently died this
  way. Re-run inits when hydration delivers data (an on-change hook), and
  skip the work when the relevant slice didn't change.
- **Preview builds usually aren't seeded.** Stubbed bundle plus no snapshot means
  every preview 5xxs. Seed previews, or enable the stub only for production.
- A cross-request hydration promise must be kept alive with `ctx.waitUntil` and
  bounded by a timeout, or it can hang every later request in the isolate.

Also: **a feature flag that has been inert for weeks is not proven safe.** It may
be waiting on a second precondition (a deploy-time `--var`, a KV key that a new
pipeline starts writing). When the deploy pipeline changes, diff the bindings and
vars of the last good version against the first bad one. Attribute incidents by
**deployed version**, not by commit timestamp.

## 4. Stream, don't buffer

KV fixes resident memory. Transient peaks need streaming.

- R2: return `obj.body` as the response body (or pipe it, as below). Never
  `await obj.text()` on a big object.
- Proxies that rewrite text: use a `TransformStream` that holds back a tail, so
  a needle split across chunks still matches:

```ts
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const map = new Map(pairs);                          // [from, to][]
const re = new RegExp([...map.keys()].map(esc).join("|"), "g");
const hold = Math.max(...[...map.keys()].map((k) => k.length)) - 1;

// Replace matches that start before the cut; anything after it may be a partial needle.
function step(text: string, final: boolean): [out: string, tail: string] {
  let cut = final ? text.length : Math.max(0, text.length - hold);
  let out = "", last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index >= cut) break;
    out += text.slice(last, m.index) + map.get(m[0]);
    last = m.index + m[0].length;
    if (last > cut) cut = last;                      // a match may straddle the cut
  }
  return [out + text.slice(last, cut), text.slice(cut)];
}

let tail = "";
const rewrite = new TransformStream<string, string>({
  transform(chunk, c) { const [out, t] = step(tail + chunk, false); tail = t; if (out) c.enqueue(out); },
  flush(c) { const [out] = step(tail, true); if (out) c.enqueue(out); },
});
const body = upstream.body!
  .pipeThrough(new TextDecoderStream())             // handles multi-byte chars split across chunks
  .pipeThrough(rewrite)
  .pipeThrough(new TextEncoderStream());
return new Response(body, { headers });
```

Forgetting `flush` silently truncates the output. Size the held-back tail from
the longest search string. Grep passthrough handlers for `await res.text()` and
`await res.arrayBuffer()`.

## 5. Looks like a memory fix, isn't

| Change | Why it doesn't help |
|---|---|
| Moving the response cache from Cache API to KV | `caches.default` hands back a stream from the location's disk cache. The body never sits in JS memory. KV storage serializes every body (base64 + JSON, several live copies per hit). Measured ~0% on P90. Keep it if you want durability across deploys and locations, but don't book it as memory. |
| Adding an in-memory loader/result cache | Stores parsed payloads per isolate. It's a memory *source*. |
| Upgrading a library's "cache memory fix" | Within noise unless the library held the big data. |
| Bigger TTLs | Changes hit rate, not resident size. |

## Checklist

- [ ] Is **P90** (not P50) near 128 MB?
- [ ] Did CPU **P50** move too? Then look at cold-start parse/init.
- [ ] Did requests rise? If not, it isn't load.
- [ ] Did the deploy pipeline change (new `--var`, new builder)? Diff the bindings.
- [ ] How big is every JSON/CSV imported at module scope? That's your floor.
- [ ] Data moved to KV: is the bundle stubbed, or are you double-holding?
- [ ] Any `await res.text()` on a passthrough or big R2 object?
- [ ] Before claiming a fix: what did P90 do, and did a reversal confirm it?
