# Working on this app

The deployed Worker exposes its own analytics over MCP, connected as the
`self` server via `.mcp.json`:

```sh
export APP_MCP_URL="https://<your-worker>.workers.dev/mcp"
export APP_MCP_TOKEN="<MCP_AUTH_TOKEN>"
```

## Every change

1. **Read the numbers first:** `self:analytics_overview` (traffic, status,
   referrers, devices) or `self:metrics_query` (one event, grouped). No data
   for what you want to know? Add a `track()` and come back later.
2. **Make one change.** New features follow the house pattern: core function
   → MCP tool → (optionally) a view. See PROMPT.md.
3. **Track every new surface** with `track()`. An unmeasured feature is
   invisible.
4. **Verify:** `bun run check` and `bun test` green. Have a subagent read the
   diff assuming it's broken; fix what it finds.
5. **Ship:** `bun run deploy` (or push, with Workers Builds). Smoke-test
   `/healthz` and one MCP tool call.
6. **Write down what you learned** in the commit message. A lesson that
   recurs goes into this file.

## Rules

- **The human decides at consequence:** messaging real users, spending money,
  deleting data, auth changes. Ask and stop.
- **Never invent numbers.** Claims come from `metrics_query` or
  `analytics_overview`.
- **Bots are not traffic.** Unknown paths answer 404 and are tracked as
  `blocked`, never `pageview`. Check `device=bot` before celebrating a spike.
- **Keep `bun run check` green.**
