-- 002: channels and units reference tables, printer settings columns, and the
-- "cashiers are deactivated, never deleted" guard. Rows are seeded exactly once
-- by first-run setup (inside its transaction), never by this migration.

-- Sales channels (spec 13). `code` is the stable key; `label` is editable.
CREATE TABLE channels (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(code) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

-- Units of measure (spec 9).
CREATE TABLE units (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(code) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

-- Print settings (spec 31) captured by the optional wizard step. All NULL means
-- "never configured"; consumers apply their own defaults (thermal width 58 mm).
ALTER TABLE settings ADD COLUMN default_thermal_printer_name TEXT;
ALTER TABLE settings ADD COLUMN default_a4_printer_name TEXT;
ALTER TABLE settings ADD COLUMN thermal_paper_width_mm INTEGER
  CHECK (thermal_paper_width_mm IS NULL OR thermal_paper_width_mm IN (58, 80));

CREATE TRIGGER cashiers_no_delete BEFORE DELETE ON cashiers
BEGIN
  SELECT RAISE(ABORT, 'cashiers cannot be deleted; deactivate them instead');
END;
