-- 009: invoice printing (spec 30, 31, 32, 47).
-- Print settings complete spec 31 on the single settings row. The T4 (002)
-- columns default_thermal_printer_name, default_a4_printer_name and
-- thermal_paper_width_mm are reused as they are (NULL width = 58 mm).

ALTER TABLE settings ADD COLUMN default_invoice_format TEXT NOT NULL DEFAULT 'THERMAL'
  CHECK (default_invoice_format IN ('A4', 'THERMAL'));
ALTER TABLE settings ADD COLUMN auto_print_after_finalize INTEGER NOT NULL DEFAULT 0
  CHECK (auto_print_after_finalize IN (0, 1));

-- Shop logo (spec 32): the content-addressed asset key `<sha256>.<ext>` of a
-- file under userData/assets. The 001 `logo` BLOB column stays unused.
ALTER TABLE settings ADD COLUMN logo_asset TEXT
  CHECK (logo_asset IS NULL OR (
    length(logo_asset) = 68
    AND substr(logo_asset, 1, 64) NOT GLOB '*[^0-9a-f]*'
    AND substr(logo_asset, 65) IN ('.png', '.jpg')
  ));

-- Every print or PDF export attempt, after the invoice was committed. The
-- REPRINT marking is derived from an earlier PRINTED print of the invoice.
CREATE TABLE print_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  format TEXT NOT NULL CHECK (format IN ('A4', 'THERMAL_58', 'THERMAL_80')),
  action TEXT NOT NULL CHECK (action IN ('PRINT', 'PDF_EXPORT')),
  requested_by TEXT NOT NULL REFERENCES cashiers (id),
  requested_at TEXT NOT NULL
    CHECK (requested_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  outcome TEXT NOT NULL CHECK (outcome IN ('PRINTED', 'CANCELLED', 'FAILED')),
  error_code TEXT CHECK (
    (outcome = 'FAILED' AND error_code IS NOT NULL AND length(error_code) > 0)
    OR (outcome <> 'FAILED' AND error_code IS NULL)
  ),
  is_reprint INTEGER NOT NULL CHECK (is_reprint IN (0, 1))
) STRICT;

CREATE INDEX print_jobs_invoice ON print_jobs (invoice_id, outcome);

CREATE TRIGGER print_jobs_no_update BEFORE UPDATE ON print_jobs
BEGIN
  SELECT RAISE(ABORT, 'print_jobs is append-only');
END;

CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
BEGIN
  SELECT RAISE(ABORT, 'print_jobs is append-only');
END;

-- Only issued invoices are printed.
CREATE TRIGGER print_jobs_issued_only BEFORE INSERT ON print_jobs
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) NOT IN ('FINALIZED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'only issued invoices are printed');
END;
