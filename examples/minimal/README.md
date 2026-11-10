# minimal: one file, a chat agent, an admin, an MCP server

The smallest app on this stack: `worker.ts` (~250 lines), one KV namespace,
no framework, no SDK.

- **`/`** — your notes and a chat. Say "add a note saying buy coffee": a model
  (any OpenRouter model, set in `wrangler.jsonc`) calls the app's own tools
  and answers. The chat can list and add notes, never delete them.
- **`/admin?token=…`** — every conversation: what was said, each tool call with
  its arguments and result, and the reply. Kept 30 days.
- **`/mcp`** — the same tools (plus `delete_note` and `list_conversations`)
  for any agent. Claude Code connects through `.mcp.json`.

One `TOOLS` list is the whole business logic; the chat, the admin and MCP
are three clients of it. A new feature is one more entry.

```sh
bunx wrangler kv namespace create DATA       # paste the id into wrangler.jsonc
bunx wrangler secret put MCP_AUTH_TOKEN      # any long random string
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler deploy

export NOTES_MCP_URL=https://minimal-notes.<you>.workers.dev/mcp
export NOTES_MCP_TOKEN=<the token>
claude "read the last conversations and tell me what people asked for"
```

Guardrails, small on purpose: the chat is rate-limited per IP (10/min) and
refuses cross-site posts, the agent loop stops after 5 rounds, deleting is
not a chat tool, `/mcp` and `/admin` fail closed without the token. For
more than one owner, put `/admin` behind Cloudflare Access instead of a
token in the URL.

Local: put `MCP_AUTH_TOKEN` and `OPENROUTER_API_KEY` in `.dev.vars`, then
`bunx wrangler dev`. Test: `bun test` (the model is stubbed).
