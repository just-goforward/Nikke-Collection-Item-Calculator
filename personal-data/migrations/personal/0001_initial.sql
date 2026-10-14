CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 1500000 CHECK (quota_bytes > 0),
  public_participation INTEGER NOT NULL DEFAULT 0 CHECK (public_participation IN (0, 1))
);
CREATE TRIGGER beta_admission BEFORE INSERT ON accounts
WHEN (SELECT count(*) FROM accounts) >= 150
BEGIN
  SELECT RAISE(ABORT, 'beta_full');
END;
CREATE INDEX accounts_inactivity ON accounts(last_active_at);

CREATE TABLE identities (
  issuer TEXT NOT NULL CHECK (issuer = 'https://accounts.google.com'),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES accounts(user_id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  max_expires_at INTEGER NOT NULL,
  CHECK (created_at < idle_expires_at AND idle_expires_at <= max_expires_at),
  CHECK (max_expires_at <= created_at + 7776000000)
);
CREATE INDEX sessions_account ON sessions(user_id);
CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64),
  verifier TEXT NOT NULL,
  return_path TEXT NOT NULL CHECK (substr(return_path, 1, 1) = '/' AND substr(return_path, 1, 2) != '//'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER
);
CREATE INDEX oauth_expiry ON oauth_transactions(expires_at);
CREATE TABLE workspaces (
  user_id TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_op_id TEXT,
  last_write_nonce TEXT,
  document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE TABLE operations (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  action TEXT NOT NULL CHECK (action IN ('save', 'archive')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX operations_retention ON operations(user_id, created_at);
CREATE TABLE stage_summaries (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (json_valid(summary)),
  PRIMARY KEY (user_id, item_id, stage)
);
CREATE TABLE pending_archives (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, archive_id)
);
CREATE TABLE self_percentiles (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  release_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (user_id, release_id, stage)
);

-- Logical UTF-8 content quota: reject only NEW archives; never remove existing data.
CREATE TRIGGER archive_quota BEFORE INSERT ON pending_archives
WHEN (
  COALESCE((SELECT length(CAST(document AS BLOB)) FROM workspaces WHERE user_id = NEW.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(summary AS BLOB))) FROM stage_summaries WHERE user_id = NEW.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM pending_archives WHERE user_id = NEW.user_id), 0)
  + COALESCE((SELECT sum(length(CAST(payload AS BLOB))) FROM self_percentiles WHERE user_id = NEW.user_id), 0)
  + length(CAST(NEW.payload AS BLOB))
) > (SELECT quota_bytes FROM accounts WHERE user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'archive_quota_reached');
END;
