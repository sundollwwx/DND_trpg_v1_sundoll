CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'pending'))
);

CREATE INDEX IF NOT EXISTS messages_public_order
  ON messages (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  request_id TEXT PRIMARY KEY NOT NULL,
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_hash_time
  ON rate_limits (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS rate_limits_expiration
  ON rate_limits (expires_at);

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

CREATE TABLE IF NOT EXISTS message_owners (
  record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('message', 'reply')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64)
);

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

CREATE TABLE IF NOT EXISTS board_authors (
  record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('message', 'reply')),
  account_key TEXT NOT NULL CHECK (length(account_key) = 64 AND account_key NOT GLOB '*[^0-9a-f]*'),
  public_id TEXT NOT NULL CHECK (length(public_id) = 38 AND substr(public_id, 1, 6) = 'board_' AND substr(public_id, 7) NOT GLOB '*[^0-9a-f]*')
);

CREATE INDEX IF NOT EXISTS board_authors_account
  ON board_authors (account_key, record_type, record_id);

CREATE TABLE IF NOT EXISTS board_message_likes (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  account_key TEXT NOT NULL CHECK (length(account_key) = 64 AND account_key NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, account_key)
);

CREATE TABLE IF NOT EXISTS board_reply_likes (
  reply_id TEXT NOT NULL REFERENCES message_replies (id) ON DELETE CASCADE,
  account_key TEXT NOT NULL CHECK (length(account_key) = 64 AND account_key NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, account_key)
);
