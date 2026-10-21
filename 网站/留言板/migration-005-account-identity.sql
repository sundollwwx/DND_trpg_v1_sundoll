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
