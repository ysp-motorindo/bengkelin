-- Optional transaction references; existing invoices remain unset.
CREATE TABLE sales (
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
 label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
 address TEXT CHECK (address IS NULL OR length(address) <= 300),
 city TEXT CHECK (city IS NULL OR length(city) <= 100),
 phone_number TEXT CHECK (phone_number IS NULL OR length(phone_number) <= 40),
 is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'reference records cannot be deleted'); END;
CREATE TRIGGER sales_code_immutable BEFORE UPDATE OF code ON sales
WHEN NEW.code IS NOT OLD.code
BEGIN SELECT RAISE(ABORT, 'reference codes cannot change'); END;
CREATE TABLE expeditions (
 id TEXT PRIMARY KEY,
 code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
 label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
 address TEXT CHECK (address IS NULL OR length(address) <= 300),
 city TEXT CHECK (city IS NULL OR length(city) <= 100),

 is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TRIGGER expeditions_no_delete BEFORE DELETE ON expeditions
BEGIN SELECT RAISE(ABORT, 'reference records cannot be deleted'); END;
CREATE TRIGGER expeditions_code_immutable BEFORE UPDATE OF code ON expeditions
WHEN NEW.code IS NOT OLD.code
BEGIN SELECT RAISE(ABORT, 'reference codes cannot change'); END;
ALTER TABLE invoices ADD COLUMN sales_id TEXT REFERENCES sales(id);
ALTER TABLE invoices ADD COLUMN sales_name_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN expedition_id TEXT REFERENCES expeditions(id);
ALTER TABLE invoices ADD COLUMN expedition_name_snapshot TEXT;
CREATE TRIGGER invoices_finalized_references_immutable BEFORE UPDATE ON invoices
WHEN OLD.status = 'FINALIZED' AND (
 NEW.sales_id IS NOT OLD.sales_id OR NEW.expedition_id IS NOT OLD.expedition_id
 OR NEW.sales_name_snapshot IS NOT OLD.sales_name_snapshot
 OR NEW.expedition_name_snapshot IS NOT OLD.expedition_name_snapshot)
BEGIN SELECT RAISE(ABORT, 'finalized invoice references cannot change'); END;
