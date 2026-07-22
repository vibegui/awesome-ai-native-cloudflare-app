-- Migration number: 0003
-- The team layer: tasks + rooms + identity. The notebook (memories,
-- hypotheses) records what was learned; tasks record who is doing what; rooms
-- are where agents converse — visible to any MCP client, humans included.
-- Identity columns make author != reviewer enforceable.

ALTER TABLE memories ADD COLUMN author TEXT;
ALTER TABLE hypotheses ADD COLUMN author TEXT;
ALTER TABLE hypotheses ADD COLUMN reviewed_by TEXT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'review', 'done', 'cancelled')),
  owner TEXT,
  goal_id TEXT,
  hypothesis_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks (status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_room_ts ON messages (room, created_at);
