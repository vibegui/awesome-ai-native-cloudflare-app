# awesome-ai-native-cloudflare-app

A batteries-included starting point for **AI-native apps on Cloudflare
Workers**: one Worker that is simultaneously an HTTP app, an **MCP server**
(so AI agents and workspaces like [deco studio](https://decocms.com) can
operate it), an embeddable **MCP-App UI**, and a **WhatsApp bot** — deployed
by `git push` via Workers Builds.

**Start with [PROMPT.md](./PROMPT.md)** — the master prompt / field guide.
Read it yourself, or paste it into your AI coding agent (as `CLAUDE.md` or
system context) and describe the app you want. The scaffold in this repo is
the reference implementation of every pattern it describes.

## What's inside

```
PROMPT.md                     ← the master prompt (read this first)
wrangler.jsonc                one Worker: D1 + KV bindings, Text-import rules
src/server/
  main.ts                     Hono app: / (SPA), /mcp, /webhook, /healthz
  mcp/server.ts               complete MCP server in ~150 lines (JSON-RPC 2.0, no SDK)
  mcp/tools.ts                tool registry — plain objects, hand-written JSON Schema
  mcp/resources.ts            ui:// resources — the SPA served as an MCP App
  routes/webhook.ts           Meta WhatsApp webhook (HMAC, dedupe, ack-fast + waitUntil)
  pipeline/inbound.ts         LLM reply pipeline with KV thread memory
  services/meta.ts            zero-dependency WhatsApp Cloud API client
  ai/gateway.ts               all LLM calls via Cloudflare AI Gateway
  lib/auth.ts                 bearer gate for /mcp (3 vectors, constant-time, fail closed)
src/client/                   React 19 MCP-App UI → ONE self-contained HTML file
migrations/                   numbered D1 SQL migrations
prompts/system.md             system prompt, bundled as a string
```

The demo domain is a trivial notes app + WhatsApp assistant — deliberately
boring, so the architecture is the interesting part. Replace the tools and
views with your own.

## Self-improving by design

The app measures itself (first-party analytics in D1 — no GA/PostHog: a
`track()` helper, a `POST /e` beacon, cookieless daily-hash uniques) and
exposes **goals, memory, and hypotheses as MCP tools**. Connect Claude Code to
the deployed app (`.mcp.json` — set `APP_MCP_URL` / `APP_MCP_TOKEN`), and
`CLAUDE.md` turns any session into an improvement cycle:

```
get_briefing → conclude testing hypotheses against real metrics →
pick one proposed bet → edit the code locally → deploy → record to memory
```

Set a few goals (`goal_set`), throw an agent at it, spend tokens, watch the
metrics move. Humans stay in the loop at consequence: user-facing messages,
money, data deletion. Full pattern in [PROMPT.md §10](./PROMPT.md).

## Quickstart

```sh
bun install
cp .dev.vars.example .dev.vars          # set MCP_AUTH_TOKEN at minimum

# create resources, paste the printed ids into wrangler.jsonc
bunx wrangler d1 create app-db
bunx wrangler kv namespace create THREADS
bunx wrangler kv namespace create DEDUPE

bun run db:local                        # apply migrations locally
bun run dev:worker                      # builds UI + runs the Worker on :8787
```

Try it:

```sh
curl -X POST 'http://localhost:8787/mcp?token=dev-token-change-me' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Deploy: `bun run deploy` once by hand, then connect the repo to **Workers
Builds** in the Cloudflare dashboard so every push to `main` deploys and every
PR gets a preview URL. Apply remote migrations with `bun run db:remote` and
set secrets with `wrangler secret put`.

Register in **deco studio**: Registry → Add MCP Server → URL
`https://<your-worker>.workers.dev/mcp?token=<MCP_AUTH_TOKEN>`, type `http`.
Your tools appear in the workspace and the dashboard renders as an MCP App.

WhatsApp: create a Meta developer app + WhatsApp Business number, set the
`META_*` secrets, point the webhook at `https://<your-worker>/webhook` with
your verify token. Full recipe and gotchas in [PROMPT.md §6](./PROMPT.md).

## License

MIT
