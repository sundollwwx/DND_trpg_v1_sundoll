CREATE TABLE IF NOT EXISTS message_owners (
  record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('message', 'reply')),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64)
);
