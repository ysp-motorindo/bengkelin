-- 001_foundation: shop settings, cashiers, audit log, command receipts.
-- Instants are canonical UTC ISO text (YYYY-MM-DDTHH:MM:SS.mmmZ).
-- Money columns in later migrations are INTEGER (read as bigint).

-- Single typed row (id = 1): shop identity (spec 32) and preferences (spec 54).
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone_number TEXT,
  email TEXT,
  logo BLOB,
  invoice_footer TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta' CHECK (length(timezone) > 0),
  language TEXT NOT NULL DEFAULT 'id' CHECK (language IN ('id', 'en')),
  appearance TEXT NOT NULL DEFAULT 'SYSTEM'
    CHECK (appearance IN ('LIGHT', 'DARK', 'SYSTEM')),
  setup_completed_at TEXT
    CHECK (setup_completed_at IS NULL OR setup_completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

INSERT INTO settings (id) VALUES (1);

CREATE TRIGGER settings_no_delete BEFORE DELETE ON settings
BEGIN
  SELECT RAISE(ABORT, 'settings row cannot be deleted');
END;

CREATE TABLE cashiers (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL
    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- Append-only business audit history (spec 47).
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier_id TEXT REFERENCES cashiers (id),
  action TEXT NOT NULL CHECK (length(action) > 0),
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at TEXT NOT NULL
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

CREATE INDEX audit_log_created_at ON audit_log (created_at);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Durable command idempotency (see idempotency.ts).
CREATE TABLE command_receipts (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) > 0),
  command TEXT NOT NULL CHECK (length(command) > 0),
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  actor_cashier_id TEXT REFERENCES cashiers (id)
) STRICT;
