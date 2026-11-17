---
name: cloudflare-waf-and-bots
description: Investigate bot and scraper traffic on a Cloudflare zone and manage WAF custom rules safely through the Rulesets API. Use when a route is hammered by bots, when designing or promoting a WAF rule (log → challenge → block), when a WAF change may have broken real users or your own services, or when touching rulesets via API. Covers the investigation method (path, ASN, user agent, bot score), interpreting bot scores, validation gates before blocking, rule expiry and alerts, never blocking your own services, and the API operations that can wipe a ruleset.
---

# Cloudflare WAF and bots

A WAF rule applies to every request on the zone. The usual failure isn't a
bot getting through. It's a rule blocking **your own infrastructure** or real
users who look odd. Investigate first, log before you block, and keep a way back.

## 1. Know what legitimately looks like a bot

List these before writing any rule:

| Looks like a bot | Actually |
|---|---|
| Datacenter ASN + server UA (`node`, `Deno/…`, `undici`) on `/api/*` | Your own SSR or Worker calling its backend |
| Cloudflare's own ASN (13335) | Workers or other Cloudflare-hosted services, possibly yours |
| `Zabbix`, `Blackbox Exporter`, `Pingdom`, `UptimeRobot`, `Checkly`, `Chrome-Lighthouse` | Uptime/CI monitoring, yours or a customer's |
| One URL hit hundreds of thousands of times a day from one mobile carrier | Your own app polling a fixed endpoint |
| Thousands of ASNs on one path | Could be a residential-proxy crawler, or a real paid-social campaign |
| Low bot score from mobile carriers, in-app browsers, shared egress | Real users |

Your own services should reach each other over **service bindings**, not the
public internet, so the WAF never sees them (see `cloudflare-request-budget`).

## 2. Investigation method

Work from the traffic, not from assumptions about an ASN's name.

1. **Where**: top paths by requests with cache status. A path burning origin
   (high volume, 0% cache, 200s) is the target. Strip the query to the base path,
   then count distinct URLs per base path.
2. **Who**: per target path, group by ASN and by **user-agent family**. One
   GCP/AWS ASN can host both a scraper and your SSR.
3. **How many ASNs**:
   - 1–50 ASNs hitting fixed pages at a steady rate: concentrated scraper.
     Host+path-scoped rule.
   - 500+ ASNs on one path: distributed residential proxy. Don't block by ASN.
     Use path pattern + bot score + country with a challenge.
4. **Shape**: combinatorial query strings (3+ repeated filter params) mean a crawl
   of the filter space. A challenge on the pattern is cheap and precise.
5. **Auth paths**: high failure rates on login/token endpoints from few ASNs mean
   credential stuffing. These get the strictest rules.

Data sources: Security → Events in the dashboard, the GraphQL Analytics API's
firewall events, or Logpush into your own store. Check which datasets your plan
exposes.

## 3. Bot score, briefly

- `cf.bot_management.score`: 1 = almost certainly automated, 2–29 likely
  automated, higher = likely human. It requires Bot Management, so check your
  plan. Smaller plans have `cf.client.bot` (known good bots) and Bot Fight Mode instead.
- Always exclude verified bots from score-based rules: `and not cf.bot_management.verified_bot`.
- **Score 2–29 alone is not a block signal** for residential and mobile ASNs. Use
  `managed_challenge` there. It passes real browsers invisibly and costs bots.
- Prefer `managed_challenge` over `block` for anything zone-wide. Reserve `block`
  for narrow, validated scopes (datacenter ASN + abused path + score 1, known bad UA).

## 4. Rule lifecycle: log → validate → challenge/block → expire

1. **Pre-flight UA sample.** Before deploying even as `log`, sample the top user
   agents inside the rule's exact scope. If a server runtime, monitoring tool or
   known integration is over ~1% of it, reshape the rule.
2. **Deploy as `log`** with a description prefix: `[LOG] <what> <owner> exp:2026-12-31`.
3. **Wait a full day.** You need a full daily cycle. A morning-only sample
   misses overnight waves.
4. **Gates before promotion:**
   - [ ] Volume in the expected band (much higher means too broad).
   - [ ] Every exclusion actually excludes (hits in the excluded scope are 0 for this rule).
   - [ ] Top 100 matched events: mostly the intended class (e.g. ≥70% datacenter), almost no browser UA + residential ISP.
   - [ ] UA sample has no server runtime, monitoring or integration fingerprints.
   - [ ] Per-host 5xx rate at baseline. Recheck 5 minutes and 1 hour after promoting.
5. **Promote** to `managed_challenge` or `block`, updating the description prefix.
6. **Don't promote during an unrelated incident.** Errors look the same whatever the cause.
7. **Expiry and alert.** Rules don't expire by themselves. A scheduled job lists
   rules, disables any whose `exp:` date has passed, and posts what it did where
   a human looks. Every automatic block must expire and be visible.

## 5. API mechanics (Rulesets API)

Custom rules live in the zone's `http_request_firewall_custom` phase entrypoint.
Use a token scoped to the zone with WAF edit permission only.

```bash
API=https://api.cloudflare.com/client/v4
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json")

# read (and snapshot) the entrypoint
curl -s "${H[@]}" "$API/zones/$ZONE/rulesets/phases/http_request_firewall_custom/entrypoint" \
  > "waf-snapshot-$(date -u +%Y%m%dT%H%M%SZ).json"

# add ONE rule
curl -s -X POST "${H[@]}" "$API/zones/$ZONE/rulesets/$RULESET/rules" --data '{
  "description": "[LOG] datacenter scrape /items exp:2026-12-31",
  "expression": "(starts_with(http.request.uri.path, \"/items\") and cf.bot_management.score eq 1 and not cf.bot_management.verified_bot)",
  "action": "log", "enabled": true }'

# change ONE rule: send action + expression + description + enabled together
curl -s -X PATCH "${H[@]}" "$API/zones/$ZONE/rulesets/$RULESET/rules/$RULE_ID" --data @rule.json
```

Hard rules:
- **Never `PUT` the entrypoint with a partial body.** PUT replaces the whole
  ruleset. A body without the full `rules` array deletes every rule. That has
  taken a production zone's WAF down. Use the rule-scoped `POST`/`PATCH`/`DELETE`
  endpoints, which touch one rule.
- **Snapshot before every write**, and again after. Keep snapshots in git as the audit trail.
- **PATCH with the full rule body** (action, expression, description, enabled).
  A PATCH with only `action` has been rejected because the expression
  re-validated as empty.
- **Disable rather than delete** while unsure.
- **Probe permissions safely**: `POST` a rule with a deliberately invalid
  expression. A validation error means you have write access, and nothing was
  created. Never probe by PUT.
- **More than 2 rules changing?** Print the planned calls and get a human's OK first.

## 6. Recovery

Rulesets keep a version history:

```bash
curl -s "${H[@]}" "$API/zones/$ZONE/rulesets/$RULESET/versions"            # list
curl -s "${H[@]}" "$API/zones/$ZONE/rulesets/$RULESET/versions/$GOOD"      # fetch last good
```

Strip read-only fields (`id`, `version`, `last_updated`, …), keep each rule's
`action`, `action_parameters`, `description`, `enabled`, `expression`, `logging`
and `ref`. Then `PUT` the **complete** rule list back to the entrypoint. Verify
the rule count and each rule's enabled state against your pre-change snapshot.

## Never

- Block by ASN *name* ("it's a cloud provider") without sampling user agents.
- Put Cloudflare's ASN or your own SSR/hosting ASN in a "datacenter" block set without path scoping.
- Block score 2–29 on residential/mobile ASNs. Challenge instead.
- Promote log → block on less than 24h of data.
- Leave a block with no expiry and no alert.
