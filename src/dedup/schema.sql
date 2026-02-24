-- Migration: persistent message dedup table
-- Fixes: BLOCKER 4 — in-memory dedup wiped on restart
-- Task: TKSdpWn0cyh-GB1QT_RC5

CREATE TABLE IF NOT EXISTS message_dedup (
  id             TEXT PRIMARY KEY,
  from_agent_id  TEXT NOT NULL,
  to_agent_id    TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  task_id        TEXT,
  seq            TEXT,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

-- Unique constraint: same sender→receiver+content within TTL window is a duplicate
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_dedup_route_hash
  ON message_dedup(from_agent_id, to_agent_id, content_hash);

-- Index for TTL cleanup
CREATE INDEX IF NOT EXISTS idx_message_dedup_expires
  ON message_dedup(expires_at);

-- Cleanup function: called at startup and periodically by scheduler
-- DELETE FROM message_dedup WHERE expires_at < NOW();
