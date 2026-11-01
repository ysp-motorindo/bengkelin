CREATE TABLE stock_locations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
) STRICT;
CREATE TRIGGER stock_locations_no_delete BEFORE DELETE ON stock_locations
BEGIN SELECT RAISE(ABORT, 'reference records cannot be deleted'); END;
CREATE TRIGGER stock_locations_code_immutable BEFORE UPDATE OF code ON stock_locations
WHEN NEW.code IS NOT OLD.code
BEGIN SELECT RAISE(ABORT, 'reference codes cannot change'); END;
