# minimal: one file, one KV, an MCP server

The smallest app on this stack (`worker.ts`, ~100 lines): a notes page at `/`
and an MCP server at `/mcp` with three tools. No framework, no SDK, no
database migration. Start here; move to the full starter when you need D1,
WhatsApp, a UI or the self-improvement loop.

```sh
bunx wrangler kv namespace create NOTES     # paste the id into wrangler.jsonc
bunx wrangler secret put MCP_AUTH_TOKEN     # any long random string
bunx wrangler deploy

export NOTES_MCP_URL=https://minimal-notes.<you>.workers.dev/mcp
export NOTES_MCP_TOKEN=<the token>
claude "add a note saying hello, then open the page"
```

How the agent uses it: `.mcp.json` connects Claude Code to the deployed
`/mcp`, so it can call `list_notes`, `add_note` and `delete_note` against
production. `CLAUDE.md` tells it that a new feature is one more entry in
`TOOLS`, then deploy and call it. Same loop as the full starter, minus
everything else.

Local: `printf 'MCP_AUTH_TOKEN=dev\n' > .dev.vars && bunx wrangler dev`.
Test: `bun test`.
