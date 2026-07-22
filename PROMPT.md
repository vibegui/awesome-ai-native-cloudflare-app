# The Master Prompt: AI-Native Apps on the Cloudflare + MCP Stack

> **How to use this document.** It works two ways: read it top to bottom as an
> engineer's field guide, or paste it into your AI coding agent (Claude Code,
> Cursor, etc.) as the system context — e.g. drop it in your repo as
> `CLAUDE.md` — and then just describe the app you want. Every pattern here is
> distilled from multiple production apps running this exact stack.

---

## 0. The pitch (for someone arriving from Big Tech infra)

You're used to building on planet-scale internal platforms: a monorepo, a
build farm, an RPC mesh, a config pusher, a queue service, a KV store, a
managed SQL, all glued by an SRE org. The cheat code is that **Cloudflare
Workers is that entire platform, rentable by one person, deployable in
seconds** — and MCP (Model Context Protocol) is the piece Big Tech doesn't
have yet: a standard wire protocol that makes your app **natively operable by
AI agents and manageable from an AI workspace** (deco studio, Claude, Cursor —
any MCP client).

The unit of deployment is **one Worker** — a single TypeScript file tree that
simultaneously serves:

- your **REST/HTML routes** (via Hono, a ~14kB router),
- your **MCP server** (`/mcp`) — the app's tools, callable by any AI agent,
- your **admin UI** — a React single-file bundle rendered *inside* the AI
  workspace as an "MCP App",
- your **WhatsApp webhook** (or any other channel),
- your **cron jobs** and **queue consumers**.

Push to `main` → deployed globally in ~30 seconds. No Docker, no k8s, no
Terraform, no cold starts worth mentioning, and the free tier carries you
embarrassingly far.

The philosophical core: **your app's API *is* an MCP server.** Build the tools
once; humans get a UI, agents get the same tools, and every future AI surface
(chat, WhatsApp, voice, whatever) is just another thin client over them.

---

## 1. The stack, one table

| Concern | Use | Notes |
|---|---|---|
| Runtime | **Cloudflare Worker** (one per app) | `nodejs_compat` flag on |
| HTTP router | **Hono** | Tiny, typed, middleware, sub-apps |
| Language/tooling | **TypeScript strict + Bun** | Bun = package manager, script runner, test runner |
| Frontend | **React 19 + Vite** | Two serving modes, see §4 |
| Relational data | **D1** (SQLite at the edge) | Raw SQL; numbered `.sql` migrations |
| Document/session data | **KV** | Prefixed keys + TTLs; often replaces the DB entirely |
| Blobs/corpus | **R2** | S3-compatible, no egress fees |
| Per-entity stateful compute | **Durable Objects** | Chat rooms, agent sessions, WebSocket hubs |
| Async/slow jobs | **Queues** + `ctx.waitUntil()` | See retry contract in §6 |
| Inference | **Workers AI** binding | Whisper, embeddings, small LLMs |
| Frontier LLMs | **AI Gateway** | One URL in front of every provider; logs, caching, spend caps, BYOK |
| RAG | **AutoRAG / AI Search** binding over R2 | Managed chunk→embed→index→query; zero vector plumbing |
| Cron | `triggers.crons` | `scheduled()` handler in the same Worker |
| Deploy | **Workers Builds** | Connect the GitHub repo once; push = deploy, PR = preview URL |
| Observability | `observability.enabled = true` | Structured logs in the dashboard, free |

**Decision rule for state:** ephemeral/conversational → KV with TTL;
relational/queryable → D1; coordination/realtime → Durable Object; big or
static → R2. Start with KV + D1; you rarely need more.

---

## 2. Project shape

```
wrangler.jsonc            # THE manifest: entry, bindings, vars, rules, crons
package.json              # bun scripts: dev, build, check, deploy, db:*
tsconfig.json             # strict, moduleResolution: Bundler, path aliases
vite.config.ts            # SPA build (single-file or assets mode)
.dev.vars.example         # documents every secret (commit this, never .dev.vars)
migrations/*.sql          # numbered D1 migrations
prompts/*.md              # system prompts, imported into the bundle as strings
src/
  server/
    main.ts               # Hono app; also `queue()` / `scheduled()` exports
    env.ts                # Env interface hand-mirroring wrangler.jsonc
    lib/                  # auth, signatures, small pure helpers
    mcp/                  # server.ts (JSON-RPC), tools.ts (registry), resources.ts (UI)
    routes/               # webhook.ts and friends (one Hono sub-app each)
    services/             # zero-dep external clients (WhatsApp, etc.)
    ai/                   # gateway.ts (LLM), retrieval
    pipeline/             # inbound message pipeline, single-purpose modules
  client/                 # React MCP-App UI (context.tsx bridge, router.tsx, views/)
scripts/                  # bun CLIs: seed, upload-corpus, configure-webhook
tests/                    # bun test — pure functions, no mocks needed
```

Non-negotiable conventions:

1. **`env.ts` mirrors `wrangler.jsonc` by hand.** Every binding, var, and
   secret in one interface. Secrets are optional (`?`) so features degrade
   gracefully when unconfigured (return "not configured" instead of crashing).
2. **`bun run check` (`tsc --noEmit`) stays green. Always.**
3. **Text imports:** `rules: [{ type: "Text", globs: ["**/*.md", "dist/web/*.html"] }]`
   lets you import markdown prompts and the built SPA as plain strings. This
   one trick removes the need for asset pipelines, template engines, and
   runtime file reads.
4. **Business logic lives in plain functions** that take `env` as an argument.
   REST routes, MCP tools, webhook pipelines, and CLIs all call the same
   functions. Nothing is coupled to a transport.

---

## 3. The MCP server (the heart)

Do **not** reach for a framework. A complete, spec-compliant MCP server is
~150 lines of JSON-RPC 2.0 over `POST /mcp` (see `src/server/mcp/server.ts`):
handle `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`, `prompts/list`. Request/response only — no SSE needed for
any current host.

**Tools are plain objects** in an array:

```ts
{
  name: "add_note",
  description: "Create a note.",           // written FOR the LLM — be precise
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  _meta: { ui: { resourceUri: "ui://app/dashboard" } },   // optional UI link, §4
  async execute(env, input) { /* call the same core function REST uses */ },
}
```

Hand-written JSON Schema, not zod-derived — it's what goes over the wire
anyway, and descriptions in the schema are prompt engineering: the agent reads
them to decide when and how to call you.

**Auth = one bearer token, three vectors.** Accept
`Authorization: Bearer`, `x-mcp-auth`, and `?token=` (some hosts only store a
URL). Compare constant-time. **Fail closed** if the secret is unset. That's
the whole security model for a single-tenant app, and it's enough.

**The mindset shift:** the MCP endpoint is not an "integration" — it's your
app's **live control plane**. Tools read and write the same KV/D1 the runtime
uses, so an agent (or you, from the studio chat) can inspect threads, hot-swap
the system prompt, send messages, and pull dashboards — with zero redeploys.
Whatever admin page you were about to build, build it as MCP tools first.

---

## 4. The UI: an app that renders inside the AI workspace

Two complementary modes; the scaffold ships (a), big SPAs use (b):

**(a) MCP App (single-file bundle).** Vite + `vite-plugin-singlefile` builds
the whole React app into ONE `index.html` (all JS/CSS inlined). The Worker
imports it as a string and serves it as `ui://` **MCP resources**
(mime `text/html;profile=mcp-app`). Hosts that support MCP Apps (deco studio)
render it in a sandboxed iframe next to tool results. The bridge is
`@modelcontextprotocol/ext-apps/react`:

- `useApp()` connects to the host; the host **proxies all tool calls** —
  the UI never holds the worker URL or token.
- Route at runtime: `hostContext.toolInfo.tool.name` → view component, via a
  plain `Record<string, Component>`. One bundle, many views, no router lib.
- Respect `hostContext.safeAreaInsets` and host theme (`useHostStyles`).
- Every resource read returns the same HTML; the URI is just an entry hint.

**(b) Classic SPA via Workers Assets.** For a big standalone frontend, add
`assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "single-page-application" }`
and — critical — `run_worker_first: ["/api/*", "/mcp", "/webhook/*"]` so
dynamic routes hit the Worker before the static fallback (forgetting this
breaks OAuth callbacks and every deep link).

---

## 5. deco studio: manage the app as an MCP app

[deco studio](https://decocms.com) (studio.decocms.com) is an open-source AI
workspace: agents, chat threads, tool connections, and MCP-App rendering.
Your Worker plugs in with **zero SDK coupling** — it's just a remote MCP
server to the studio. Two directions:

**(a) Studio consumes your app.** Registry → *Add MCP Server* → Remote URL =
`https://<your-worker>.workers.dev/mcp?token=<MCP_AUTH_TOKEN>`, type `http`.
The studio calls `initialize` + `tools/list`, discovers the catalog, and now
every agent in the org can call your tools, and your `ui://` views render as
the app's UI inside the workspace. This is what "managed in deco studio as an
MCP app" means — the studio is the admin console, the chat is the CLI, and
your Worker stays a plain, portable Cloudflare deployment.

**(b) Your app consumes studio agents.** The inverse: keep your Worker as a
thin channel (say, WhatsApp I/O) and let a studio-hosted agent be the brain.
The studio exposes an HTTP API (org-scoped API key): create a thread, POST a
message addressed to an agent, then read the reply from the thread's SSE
stream — accumulate `text-delta` chunks until `finish`. Production hardening
that matters: **poll the durable thread transcript as a fallback** when the
ephemeral stream stalls, and support human-in-the-loop — when the agent asks a
question via its `user_ask` tool, relay it to the user and resume the run by
patching the tool result back. Memory, tool access, and model choice then live
in the studio, editable without redeploying your Worker.

**(c) Your Worker as an MCP *client*.** To call other MCP servers from inside
a Worker, use `@modelcontextprotocol/sdk` with one crucial substitution: the
default ajv validator uses `new Function`, which workerd blocks. Construct
clients with `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` (from
`@modelcontextprotocol/sdk/validation/cfworker`). Dial a fresh client per
call, namespace remote tools as `<connection>__<tool>`, and merge them into
your agent loop's toolset.

---

## 6. WhatsApp support (the full recipe)

Go **direct to the Meta WhatsApp Cloud API** (Graph API). No Twilio tax, no
middleman: you need a Meta developer app, a WhatsApp Business phone number,
a permanent access token, and ~200 lines of code. All of it is in this
scaffold (`services/meta.ts`, `routes/webhook.ts`, `pipeline/inbound.ts`).

The webhook contract (get these wrong and you get retry storms):

1. **GET handshake:** echo `hub.challenge` when `hub.verify_token` matches.
2. **Verify HMAC** (`X-Hub-Signature-256`, SHA-256 over the **raw** body with
   your app secret) before parsing anything.
3. **Dedupe on `message.id`** in KV with a 24h TTL — Meta redelivers
   aggressively on any perceived failure.
4. **Ack 200 immediately; do all real work in `ctx.waitUntil()`.** Meta times
   out at ~20s. Status callbacks (delivered/read) are acked and ignored.
5. Inside the pipeline, **never throw** — log, and send a graceful fallback
   text so the user is never left on read.

Conversation state: KV documents keyed `t:<phone>:<YYYY-MM-DD>` (turn array,
capped ~30 turns, 30-day TTL). Daily rollover + folding yesterday into a
rolling `m:<phone>` memory summary gives you long-term memory without a
database. Send the reply, then persist both turns.

For **slow, non-idempotent** work (multi-message flows, scraping, long agent
runs) use a **Queue**, not `waitUntil`, with this retry contract: retry only
**total** failures; if the job partially succeeded (some messages sent), ack
anyway — a duplicate WhatsApp message is worse than a missing one. Add a
per-phone lock key in KV so concurrent messages from one user don't
double-run.

Extras that make it feel magical: voice notes → Workers AI Whisper
(`@cf/openai/whisper-large-v3-turbo`) → treat the transcript as text; images →
a vision model description; `markMessageAsRead` + typing indicator before you
think. And script your Meta webhook setup (Graph API: resolve WABA id,
`subscribed_apps`, per-phone `override_callback_uri`) so onboarding a number
is a CLI command, not a dashboard safari.

Two operational facts: Meta only delivers webhooks to the **production** URL
(previews get no traffic), and you must reply within Meta's 24-hour customer
service window unless you use templates.

---

## 7. LLM calls and RAG

**Route every frontier-LLM call through AI Gateway** —
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/...`. You get logs,
caching, rate limits, spend caps, and provider portability for free. Two
modes: `compat` (OpenAI-shaped endpoint, one unified bill from Gateway
credits) or per-provider passthrough (e.g. OpenRouter) with BYOK — store the
provider key in the Gateway and your Worker holds **no** LLM secrets. Tag
requests with `cf-aig-metadata` (user id, thread id, purpose) so the dashboard
becomes your LLM analytics.

Hard-won generation rules:

- **Disable reasoning by default** for chat replies — reasoning models will
  happily burn the entire token budget on hidden thinking and return an empty
  string. If a reply comes back empty: retry once with a bigger budget, then
  fall back to a canned line. Never send a blank message.
- **The model never writes HTML/markup.** For AI-generated artifacts, have
  the model fill a small JSON manifest (constrain with
  `response_format: json_schema`, re-validate with zod), then render with a
  deterministic template that escapes everything. Schema in, template out.

**RAG without vector plumbing:** put markdown in R2, create an **AutoRAG /
AI Search** instance over the bucket, add the binding, and call
`env.AUTORAG.search(...)`. Gotchas that cost real debugging days:

- Options are **nested** under `ai_search_options.retrieval` — flat keys are
  **silently ignored**.
- For cross-lingual corpora (queries in one language, docs in another), use a
  multilingual embedding model (`@cf/baai/bge-m3`) and consider **disabling
  reranking** — cross-lingual reranking can drop every result. Gate on the
  vector `match_threshold` (~0.45) instead.
- Keep corpus upload a CLI script (idempotent, hash-based) — it's content,
  not code; it doesn't belong in your deploy pipeline.

---

## 8. Dev & deploy workflow

**Local:** two terminals — `bun run dev` (Vite, hot reload UI) and
`bun run dev:worker` (Wrangler on :8787; Vite proxies `/mcp`, `/webhook`,
`/api` to it). Secrets in `.dev.vars` (git-ignored; commit
`.dev.vars.example`). D1 runs a real local SQLite: `bun run db:local`.

**Deploy: connect the repo to Workers Builds** (Cloudflare dashboard → your
Worker → Builds → connect GitHub repo). Then:

- push/merge to `main` → production deploy,
- any other branch/PR → `wrangler versions upload` → a **preview URL** per
  push.

Caveats: previews share production bindings and secrets (they're versions of
the same Worker, not staging envs); secrets are managed by
`wrangler secret put`, never by the build; rollback is `wrangler rollback` or
one click in the dashboard. Team rule that keeps you sane: **anything
deployed must be on `main`.**

**Testing:** design logic as pure functions and `bun test` them with zero
mocks. One black-box HTTP smoke test against a booted worker beats a mock
farm.

---

## 9. Gotchas index (tape this to your monitor)

1. `run_worker_first` for every dynamic route when using Workers Assets, or
   deep links and OAuth callbacks silently 404 to your SPA.
2. workerd blocks `new Function` / `eval` — anything using ajv-style codegen
   (including the MCP SDK's default validator) needs a workerd-safe
   substitute (`CfWorkerJsonSchemaValidator`).
3. Meta webhook: ack in <20s or face redelivery storms; dedupe by message id;
   verify HMAC over the **raw** body (not the parsed-and-restringified one).
4. Reasoning models return empty strings when the token budget is eaten by
   hidden reasoning. Reasoning off for chat; retry-then-fallback on empty.
5. AutoRAG options must be nested; flat options are silently ignored.
6. Cross-lingual reranking can drop all results — multilingual embeddings +
   score threshold instead.
7. Queue retries: only retry **total** failures, or users get duplicate
   messages.
8. KV values are your schema — version them informally and make every reader
   tolerate old shapes (accept `string | {source, text}` etc.). That's the
   whole migration story for KV.
9. Workers Builds previews share production state. A "preview" writing to
   prod KV is a footgun — guard destructive paths.
10. Never commit: account ids, namespace ids, phone-number ids, tokens,
    `.dev.vars`. Names in `wrangler.jsonc` are fine; ids are not (in public
    repos).

---

## 10. The self-improvement loop: throw an agent at it

The endgame of "your app's API is an MCP server": make the app **self-
improving**. Give it senses (metrics), a compass (goals), and a notebook
(memory + hypotheses) — all as MCP tools — and then any coding agent connected
to `/mcp` can improve the app with nothing but tokens. No dashboards, no
handoff docs, no tribal knowledge: `get_briefing` returns everything an agent
needs to decide what to do next.

**First-party analytics, full Cloudflare.** Don't add GA or PostHog — the
Worker *is* the collector. An append-only `events` table in D1; a `track()`
helper on every interesting code path (pageviews on served routes, tool
calls, WhatsApp turns, LLM token spend); a public `POST /e` beacon for
client-side events; uniques via a **daily-rotating salted hash** of IP+UA
(cookieless — can count, can't track across days); `request.cf.country` as a
free geo dimension; a cron pruning events past 90 days. Aggregates via
`metrics_query` (group by day/name/path/country) — SQL through a whitelist,
never interpolated.

**The data model of improvement** (one migration):
- `goals` — the objective function: `{name, metric, target, direction,
  window_days}` where `metric` is an event name. Progress is computed live.
  Without goals, autopilot is drift.
- `memories` — the lab notebook: `observation | decision | result | lesson`.
  Sessions are ephemeral; the notebook is what compounds.
- `hypotheses` — falsifiable bets: "If we <change>, then <metric> will
  <move> because <reason>", with lifecycle `proposed → testing →
  confirmed | refuted`. Every code change traces to one.

**The agent handshake.** Commit two files and the app becomes self-improving
for anyone who clones it:
1. `.mcp.json` — connects Claude Code to the deployed app's `/mcp` (env-var
   expansion keeps the token out of git). The agent now sees production
   reality: real metrics, real goals, real history.
2. `CLAUDE.md` — the operating manual: brief yourself → conclude old bets →
   pick ONE hypothesis → implement locally → deploy → record. The agent edits
   the code on the human's machine with the human's credentials — no
   server-side git/deploy tokens needed, which is the whole trick.

**Governance rules that make autopilot safe** (learned from bigger systems
that run agent teams this way):
- **Autonomy ends at consequence.** Agents own code, config, deploys,
  analytics. Humans approve: messaging real users, spending money, deleting
  data, auth changes.
- **One hypothesis per change**; conclude every bet (`refuted` is as valuable
  as `confirmed`); never leave `testing` bets dangling.
- **Unmeasured features are invisible** — instrumentation is part of the
  definition of done.
- **Lessons compound**: a lesson that recurs gets promoted into `CLAUDE.md`
  itself, so the operating manual improves like any other code.
- Scale-up path: multiple named agents with roles (analyst, builder,
  reviewer), a strict reporting tree with a hard headcount cap, and a
  proposals-only heartbeat cron that *suggests* work but never acts — but
  start with one agent and one loop.

---

## 11. Build checklist for a new app

```
[ ] bun create vite (React+TS) → collapse into the folder shape in §2
[ ] wrangler.jsonc: name, main, nodejs_compat, Text rules, observability
[ ] env.ts mirroring every binding/var/secret
[ ] Hono app: /healthz first, then routes
[ ] mcp/server.ts + tools.ts: start with get_status; add one tool per feature
[ ] Bearer auth on /mcp (fail closed)
[ ] Client: ext-apps bridge + tool→view router + one dashboard view
[ ] D1 migration 0001 (or skip DB — KV might be all you need)
[ ] wrangler d1/kv create → paste ids (keep them out of public repos)
[ ] bun run check green; deploy once by hand: bun run deploy
[ ] Connect repo to Workers Builds; push to main; verify preview URLs on PRs
[ ] Register /mcp?token=... in deco studio; call a tool from chat
[ ] (Optional) WhatsApp: Meta app + number, secrets, configure webhook, done
[ ] Self-improvement: events/goals/memories/hypotheses migration + track()
    on every surface + get_briefing tool + .mcp.json + CLAUDE.md
[ ] Set 1-3 goals via goal_set; connect Claude Code; let it run the loop
```

The loop from here: every new feature = a core function + an MCP tool +
(maybe) a view. Agents can use it immediately; humans get UI when you feel
like it. Ship.
