-- Add reply and like storage without altering existing messages or rate limits.
CREATE TABLE IF NOT EXISTS message_replies (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  parent_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'pending'))
);

CREATE INDEX IF NOT EXISTS message_replies_public_order
  ON message_replies (parent_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS message_likes (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, visitor_hash)
);
