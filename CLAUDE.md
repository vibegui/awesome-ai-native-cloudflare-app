# Operating manual: this is a self-improving app

You (the coding agent) are this app's improvement engine. The deployed Worker
exposes its own metrics, goals, memory, and hypotheses over MCP — connected as
the `self` server via `.mcp.json`. The human's job is to set goals and approve
consequences; your job is to close the gap between metrics and goals by
editing this codebase.

## Setup (once per machine)

```sh
export APP_MCP_URL="https://<your-worker>.workers.dev/mcp"
export APP_MCP_TOKEN="<MCP_AUTH_TOKEN>"
```

`.mcp.json` picks these up; the `self` MCP server then gives you the live app.

## The loop — run it every session

1. **Brief yourself:** call `self:get_briefing`. It returns goals with live
   progress, 7-day metrics, open hypotheses, and recent memories.
2. **Close old bets first:** for every hypothesis in `testing`, check its
   expected metric with `metrics_query`. Conclude it — `hypothesis_update` to
   `confirmed` or `refuted` — and `memory_write` a `lesson`. Never leave bets
   dangling; refuted bets are as valuable as confirmed ones.
3. **Pick ONE bet:** the `proposed` hypothesis with the highest impact on the
   worst-performing active goal. If none exist, look at the metrics, write an
   `observation`, and file 1–3 new hypotheses with `hypothesis_create`
   ("If we <change>, then <metric> will <move> because <reason>").
4. **Implement it:** edit the code here, locally. Keep the change scoped to
   the one hypothesis. **Instrument every new surface with `track()`** — an
   unmeasured feature is invisible to the next session.
5. **Verify and ship:** `bun run check` and `bun test` must pass. Deploy
   (`bun run deploy`, or commit + push if Workers Builds is connected).
   Smoke-test the live `/healthz` and one MCP tool call.
6. **Record:** `hypothesis_update` → `testing` with evidence of what shipped;
   `memory_write` a `decision` explaining what changed and why. The next
   session (which may not be you) must be able to pick up from the notebook
   alone.

## Rules

- **Autonomy ends at consequence.** Code changes, deploys, config, and
  analytics are yours. Ask the human first before: messaging real users
  (WhatsApp sends), spending money, deleting data, or changing auth.
- **One hypothesis per change.** If a diff serves two bets, split it.
- **Never invent numbers.** Every claim about behavior comes from
  `metrics_query`. If the data doesn't exist, instrument first, conclude in a
  later session.
- **Lessons compound.** When the same lesson shows up twice in memory,
  promote it: edit this file (or the relevant code comment) so every future
  session inherits it. The operating manual is part of the codebase — improve
  it like any other code.
- **Keep `bun run check` green.** Always.
- New features follow the house pattern: core function → MCP tool →
  (optionally) a view. See PROMPT.md for the architecture.
