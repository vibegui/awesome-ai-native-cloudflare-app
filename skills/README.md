# Cloudflare skills

Six [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) for
running apps on Cloudflare Workers without surprise bills, outages or
self-inflicted blocks. They come from what a team running dozens of
production storefronts on Cloudflare learned the hard way, rewritten as
generic patterns: no framework, no customer, nothing you need besides a
Worker.

| Skill | Use it when |
|---|---|
| [`cloudflare-request-budget`](./cloudflare-request-budget/SKILL.md) | You add anything that fetches: worst-case fan-out, caps per loop, cron snapshots with stale-while-revalidate, negative caching, service bindings between your own Workers, per-caller rate limits. |
| [`cloudflare-edge-caching`](./cloudflare-edge-caching/SKILL.md) | A page "should cache" but doesn't: Cache-Control per route, cache keys, what silently turns a response into no-store, single-flight dedupe, in-memory SWR cache. |
| [`cloudflare-worker-memory`](./cloudflare-worker-memory/SKILL.md) | A Worker hits its memory limit (error 1102) or gets slower after a deploy: measuring per deploy, moving build-time data to KV, streaming instead of buffering. |
| [`cloudflare-egress-audit`](./cloudflare-egress-audit/SKILL.md) | Bandwidth is high or the cache hit rate is low: the traps that look cached but aren't, trimming payloads before render and cache. |
| [`cloudflare-waf-and-bots`](./cloudflare-waf-and-bots/SKILL.md) | Bots hammer a route, or you're about to touch WAF rules: investigation method, bot scores, log → challenge → block, expiry, the API call that wipes a ruleset. |
| [`worker-security-baseline`](./worker-security-baseline/SKILL.md) | A route spends money, holds a secret, proxies a URL or guards `/mcp`: same-origin checks, Rate Limiting binding, SSRF allowlists, failing closed. |

## Install

Paste this into Claude Code (or any coding agent that reads `.claude/skills`)
at the root of your project:

```text
Install the Cloudflare skills from https://github.com/vibegui/awesome-ai-native-cloudflare-app/tree/main/skills into this project: download the repo tarball, copy every folder under skills/ that has a SKILL.md into .claude/skills/ (create it if missing, overwrite older copies of the same skills, leave other skills alone), then list what you installed with each skill's one-line description.
```

Or do it yourself from the project root:

```bash
mkdir -p .claude/skills && curl -sL https://github.com/vibegui/awesome-ai-native-cloudflare-app/archive/refs/heads/main.tar.gz \
  | tar -xz -C .claude/skills --strip-components=2 \
    'awesome-ai-native-cloudflare-app-main/skills/cloudflare-*' \
    'awesome-ai-native-cloudflare-app-main/skills/worker-*'
```

For every project on your machine, use `~/.claude/skills` instead of
`.claude/skills`.
