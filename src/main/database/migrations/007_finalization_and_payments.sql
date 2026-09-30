-- 007: finalization (spec 17, 22, 23, 26; Part A "Persistence additions").
--
-- payments                 money actually received for a FINALIZED invoice.
--                          Append-only. Checkout payments come from the
--                          draft's allocations at finalization (source
--                          CHECKOUT); later payments are source LATER (T11).
-- invoice_daily_counters   the last sequence handed out per finalization
--                          business day (shop timezone). Counters only ever
--                          increase, so a number is never reused, even after
--                          a void; restore keeps the maximum (T16).
--
-- Finalization runs in ONE write transaction. Its write order satisfies
-- every trigger here and in 006 (see features/invoices/finalization.ts):
--   snapshots (DRAFT) -> allocations deleted (DRAFT) -> counter +1 ->
--   stock SALE rows -> status FINALIZED + number -> payments (FINALIZED).

CREATE TABLE payments (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'QRIS', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'OTHER')),
  -- The applied amount only; cash tendered and change are UI state.
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- The actual receipt time (never backdated in v1).
  paid_at TEXT NOT NULL CHECK (paid_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reference TEXT CHECK (reference IS NULL OR length(trim(reference)) > 0),
  note TEXT CHECK (note IS NULL OR length(trim(note)) > 0),
  received_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  source TEXT NOT NULL CHECK (source IN ('CHECKOUT', 'LATER')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

CREATE INDEX payments_invoice ON payments (invoice_id);
-- Daily report payment activity (T13) filters by receipt time.
CREATE INDEX payments_paid_at ON payments (paid_at);

CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments are append-only');
END;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments are append-only');
END;

-- Payments exist only on FINALIZED invoices (never DRAFT or VOID).
CREATE TRIGGER payments_require_finalized BEFORE INSERT ON payments
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS NOT 'FINALIZED'
BEGIN
  SELECT RAISE(ABORT, 'payments can only be recorded for a FINALIZED invoice');
END;

-- No overpayment: the running sum never exceeds the invoice amount.
CREATE TRIGGER payments_within_outstanding BEFORE INSERT ON payments
WHEN (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = NEW.invoice_id) + NEW.amount
     > (SELECT amount FROM invoices WHERE id = NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'payment exceeds the outstanding amount');
END;

CREATE TABLE invoice_daily_counters (
  -- The finalization business day (LocalDate in the shop timezone).
  business_date TEXT PRIMARY KEY CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
) STRICT;

CREATE TRIGGER invoice_daily_counters_forward_only BEFORE UPDATE ON invoice_daily_counters
WHEN NEW.business_date IS NOT OLD.business_date OR NEW.last_sequence < OLD.last_sequence
BEGIN
  SELECT RAISE(ABORT, 'invoice counters only move forward');
END;

CREATE TRIGGER invoice_daily_counters_no_delete BEFORE DELETE ON invoice_daily_counters
BEGIN
  SELECT RAISE(ABORT, 'invoice counters cannot be deleted');
END;

-- Official numbers are INV-YYYYMMDD-NNNN: at least four digits, never wrapping
-- (10000 -> INV-YYYYMMDD-10000). 006 only required a non-empty number.
CREATE TRIGGER invoices_number_format_insert BEFORE INSERT ON invoices
WHEN NEW.invoice_number IS NOT NULL AND NOT (
  NEW.invoice_number GLOB 'INV-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]*'
  AND substr(NEW.invoice_number, 14) NOT GLOB '*[^0-9]*'
)
BEGIN
  SELECT RAISE(ABORT, 'invoice numbers must be INV-YYYYMMDD-NNNN');
END;

CREATE TRIGGER invoices_number_format_update BEFORE UPDATE OF invoice_number ON invoices
WHEN NEW.invoice_number IS NOT NULL AND NOT (
  NEW.invoice_number GLOB 'INV-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]*'
  AND substr(NEW.invoice_number, 14) NOT GLOB '*[^0-9]*'
)
BEGIN
  SELECT RAISE(ABORT, 'invoice numbers must be INV-YYYYMMDD-NNNN');
END;
