CREATE TABLE IF NOT EXISTS reply_targets (
  reply_id TEXT PRIMARY KEY NOT NULL REFERENCES message_replies (id) ON DELETE CASCADE,
  target_reply_id TEXT NOT NULL,
  target_nickname TEXT NOT NULL CHECK (length(target_nickname) BETWEEN 1 AND 24)
);

CREATE TABLE IF NOT EXISTS reply_likes (
  reply_id TEXT NOT NULL REFERENCES message_replies (id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, visitor_hash)
);
