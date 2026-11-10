# Operating manual

This folder is one Cloudflare Worker (`worker.ts`). The deployed app is
connected to you as the `notes` MCP server through `.mcp.json`.

- To use the app, call its tools: `list_notes`, `add_note`, `delete_note`.
- To change the app, edit `worker.ts`: a new feature is one more entry in
  `TOOLS`. Then `bunx wrangler deploy` and call the new tool to prove it works.
- Ask before deleting notes you did not create in this session.
