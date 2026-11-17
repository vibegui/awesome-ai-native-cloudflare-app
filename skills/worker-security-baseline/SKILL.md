---
name: worker-security-baseline
description: Security baseline for the trust boundaries of a Cloudflare Worker (HTTP app + MCP server + webhooks). Use when adding a route that spends money or a server-side token, a POST endpoint for your own pages, a proxy that fetches a caller-supplied URL, auth on /mcp or an admin surface, a secret, or when reviewing a Worker before launch. Covers same-origin checks (Origin / Sec-Fetch-Site), the Rate Limiting binding, bounded input, fetch deadlines, SSRF allowlists, unverified token claims, secrets via wrangler secret, and failing closed.
---

# Worker security baseline

One Worker serves pages, an API, `/mcp` and webhooks from one origin. Every
route is public unless the code says otherwise. Values that come from a caller,
a webhook, an LLM or a CMS are untrusted input, even when the channel feels
internal.

## 1. Fail closed

- Missing secret means the feature answers "not configured", never "open". An
  unset `MCP_AUTH_TOKEN` must not mean "no auth".
- A **wrong** token is `401`, never a silent downgrade to a public tier.
- A private tool called without rights looks like "unknown tool", not a `403`
  that confirms it exists.
- Compare tokens in constant time. Hash both sides with `crypto.subtle.digest`
  and compare the digests byte by byte, or use `crypto.subtle.timingSafeEqual`
  where available.
- Auth errors get `no-store`.

## 2. Routes that spend money or a server token

Any route holding a write-capable token or triggering a paid call (LLM, SMS,
email, metered API) acts for whoever calls it. Four cheap gates, all fail-closed:

1. **Allowlist the operation.** The action, event name or tool must be in a
   closed set. Callers can't invent names.
2. **Same-origin only** for endpoints meant for your own pages:

```ts
function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !!origin && new URL(origin).host === new URL(req.url).host;
}
```

3. **Bound the input.** Max body bytes (check `content-length` *and* the read
   length), max keys on free-form objects, max length on every forwarded string.
4. **Rate-limit per caller** with the Workers Rate Limiting binding:

```jsonc
// wrangler.jsonc (check the current docs for the exact config shape)
"ratelimits": [{ "name": "PAID_LIMITER", "namespace_id": "1001",
                 "simple": { "limit": 20, "period": 60 } }]
```
```ts
const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
const { success } = await env.PAID_LIMITER.limit({ key: ip });
if (!success) return new Response("slow down", { status: 429 });
```

Counts are per Cloudflare location. It caps amplification from one client.
It isn't a global quota, and a comment should say so. Put cost caps in code as
hard limits. Env vars may only *lower* them.

For anonymous public writes (votes, sign-ups): Turnstile, a one-use ticket in
KV, and a daily cap per IP that answers `200` with no effect when exceeded.
Answer `204`/`200` whatever the upstream did. Its result is not the caller's
business, and never echo an upstream error body back.

## 3. Every `fetch` has a deadline

```ts
const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
```

Cover the body read with the same signal, wrap it in `try`/`catch`, and answer
`504` with `no-store`. A stalled upstream should cost you seconds, not the
request.

Don't forward an upstream's `Cache-Control` verbatim on a routing or HTML
decision. One proxy passed through a legacy origin's headers and cached a
*routing* decision in visitors' browsers for up to an hour, out of reach of any
deploy. Set your own policy on HTML. Let non-HTML subresources keep the
upstream's.

## 4. Proxies are SSRF until proven otherwise

A route that fetches a URL from the query string is an open proxy.

```ts
const ALLOWED = new Set(["images.example-cdn.net"]);
let target: URL;
try { target = new URL(raw); } catch { return new Response("bad url", { status: 400 }); }
if (target.protocol !== "https:" || !ALLOWED.has(target.hostname)) {
  return new Response("host not allowed", { status: 403 });
}
```

Parse the URL (never string-match it), require `https:`, allowlist the host.
Drop `Access-Control-Allow-Origin: *` unless a named consumer needs it. If one
does, scope it to that path and pin it with a test asserting that other paths
have no ACAO header.

## 5. A token claim you can't verify is not authorization

Reading a JWT or cookie payload without verifying its signature gives you an
**untrusted hint**. Never gate a route on it. Verify the signature *and* the
audience. For Cloudflare Access, verify the `Cf-Access-Jwt-Assertion` JWT
against your team's certs and `aud`, never the email header alone. Otherwise
derive the decision from an authenticated upstream call. Document an unverified
`parseJwt` helper as exactly that, and make it return `null` on anything
malformed.

## 6. Webhooks

- Verify the provider's HMAC over the **raw body** before parsing, in constant time.
- Dedupe on the provider's message id in KV with a TTL. Providers redeliver.
- Ack fast. Do the work in `ctx.waitUntil` or a Queue.
- Text from the webhook is data. It never reaches a tool that sends, deletes or
  fetches arbitrary URLs in the same step.

## 7. Secrets

- Secrets go in with `wrangler secret put NAME`, locally in `.dev.vars`
  (gitignored). Commit a `.dev.vars.example` listing names only.
- Never put a secret in `vars` in `wrangler.jsonc`. Those are plain config, visible in the dashboard and the repo.
- Nothing keyed to an account reaches the browser bundle. Audit every
  `import.meta.env` / `VITE_*` read in client code: each one ships a value.
- A server resolver that spends a credential must not take the target host,
  key or account id **from the caller**.
- When showing a secret's state, print its name and length, never the value.

## 8. HTML you didn't write

- Sanitize CMS/API-authored HTML with an **allowlist** of tags and attributes.
  Reject `javascript:` URLs.
- Build JSON-LD with `JSON.stringify` and escape `<`. A `</script>` in authored
  text ends the block.
- CSP: on cached HTML a per-request nonce isn't per-request. Use a host allowlist
  plus `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors`. Build
  the allowlist from live violations, since tag managers inject hosts no repo grep finds.
- External links with authored `href`: `rel="noopener noreferrer"`.

## Pre-launch checklist

- [ ] Every auth path fails closed; wrong token = 401; constant-time compare.
- [ ] Every paid/token-spending route: allowlisted op, same-origin, bounded input, per-IP limit.
- [ ] Every outbound `fetch` has a timeout; no upstream `Cache-Control` passed through on HTML.
- [ ] Every proxy: parsed URL, `https:` only, host allowlist, no wildcard CORS.
- [ ] No authorization from unverified claims; Access JWT checked for signature and `aud`.
- [ ] Webhooks: HMAC on raw body, dedupe, ack fast.
- [ ] Secrets only via `wrangler secret put`; none in `vars` or the client bundle.
- [ ] `/mcp` and auth responses are `no-store`.
