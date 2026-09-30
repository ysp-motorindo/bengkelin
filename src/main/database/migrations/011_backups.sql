-- 011: validated local backups (spec 42, 46, 47, 48).
-- The backup folder chosen by an ADMIN (native dialog in main). NULL means
-- the default `userData/backups`. A configured folder that is unavailable
-- (an unplugged USB drive) fails the backup; it is never silently replaced.
ALTER TABLE settings ADD COLUMN backup_directory TEXT
  CHECK (backup_directory IS NULL OR length(backup_directory) > 0);

-- One row per finished backup attempt (AUTO, MANUAL, SAFETY). The daily
-- automatic schedule and the ADMIN failure notice are derived from it: the
-- notice shows while the latest AUTO run FAILED and nothing succeeded since.
CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('AUTO', 'MANUAL', 'SAFETY')),
  started_at TEXT NOT NULL
    CHECK (started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  finished_at TEXT NOT NULL
    CHECK (finished_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  file_name TEXT CHECK (
    (outcome = 'SUCCEEDED' AND file_name IS NOT NULL AND length(file_name) > 0)
    OR (outcome = 'FAILED' AND file_name IS NULL)
  ),
  error_code TEXT CHECK (
    (outcome = 'FAILED' AND error_code IS NOT NULL AND length(error_code) > 0)
    OR (outcome = 'SUCCEEDED' AND error_code IS NULL)
  ),
  destination_dir TEXT NOT NULL CHECK (length(destination_dir) > 0),
  CHECK (finished_at >= started_at)
) STRICT;

CREATE INDEX backup_runs_kind ON backup_runs (kind, id);

CREATE TRIGGER backup_runs_no_update BEFORE UPDATE ON backup_runs
BEGIN
  SELECT RAISE(ABORT, 'backup_runs is append-only');
END;

CREATE TRIGGER backup_runs_no_delete BEFORE DELETE ON backup_runs
BEGIN
  SELECT RAISE(ABORT, 'backup_runs is append-only');
END;
