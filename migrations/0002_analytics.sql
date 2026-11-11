-- Migration number: 0002
-- First-party analytics: one append-only event stream, queried over MCP.

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
