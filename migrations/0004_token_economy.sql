-- Migration number: 0004
-- The token economy: budgets are earned through efficiency. Each agent has a
-- weekly token allowance granted by the CEO hat; spend is self-reported as
-- `tokens_spent` events (dims.agent, dims.task_id); efficiency = tokens per
-- reviewer-closed task / reviewer-confirmed hypothesis. Better efficiency →
-- bigger budget. See budget_* tools and CLAUDE.md.

CREATE TABLE budgets (
  agent TEXT PRIMARY KEY COLLATE NOCASE,
  weekly_tokens REAL NOT NULL,
  granted_by TEXT,
  rationale TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
