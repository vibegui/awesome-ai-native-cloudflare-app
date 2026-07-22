-- Migration number: 0002
-- The self-improvement loop: first-party analytics + goals + memory +
-- hypotheses. All of it lives in D1 and is exposed as MCP tools, so a coding
-- agent connected to /mcp has everything it needs to improve the app.

-- Append-only event stream. Pageviews, custom events, LLM usage, tool calls.
-- Pruned by the daily cron (90-day retention); aggregate before, not after.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 1,
  path TEXT,
  visitor TEXT,             -- daily salted hash of ip+ua; uniques without cookies
  country TEXT,
  dims TEXT,                -- small JSON bag of extra dimensions
  ts INTEGER NOT NULL
);
CREATE INDEX idx_events_name_ts ON events (name, ts);
CREATE INDEX idx_events_ts ON events (ts);

-- Goals: the objective function. `metric` is an event name; progress is
-- SUM(value) of that event over the trailing `window_days`.
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  target REAL NOT NULL,
  direction TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down')),
  window_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
  created_at INTEGER NOT NULL
);

-- Memory: the lab notebook. Agents write what they observed, decided, and
-- learned so the NEXT session (or the next agent) doesn't rediscover it.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('observation', 'decision', 'result', 'lesson')),
  content TEXT NOT NULL,
  goal_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_created_at ON memories (created_at DESC);

-- Hypotheses: falsifiable bets. Every code change should trace to one.
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  statement TEXT NOT NULL,
  expected_metric TEXT,
  expected_delta TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'testing', 'confirmed', 'refuted', 'abandoned')),
  evidence TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_hypotheses_status ON hypotheses (status);
