-- Migration number: 0001
-- Plain numbered SQL migrations, applied with:
--   bun run db:local   (wrangler d1 migrations apply app-db --local)
--   bun run db:remote  (wrangler d1 migrations apply app-db --remote)
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_notes_created_at ON notes (created_at DESC);
