ALTER TABLE suppliers ADD COLUMN external_id TEXT CHECK(external_id IS NULL OR length(trim(external_id)) BETWEEN 1 AND 120);
CREATE UNIQUE INDEX suppliers_external_id ON suppliers(external_id);
CREATE TABLE supplier_opening_balances (
  supplier_id TEXT PRIMARY KEY REFERENCES suppliers(id),
  as_of_date TEXT NOT NULL CHECK (as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(as_of_date, '+0 days') = as_of_date),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at TEXT NOT NULL,
  imported_by_cashier_id TEXT NOT NULL REFERENCES cashiers(id)
) STRICT;
CREATE TABLE supplier_opening_payments (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  supplier_id TEXT NOT NULL REFERENCES supplier_opening_balances(supplier_id),
  method TEXT NOT NULL CHECK(method IN ('CASH','QRIS','BANK_TRANSFER','DEBIT_CARD','CREDIT_CARD','OTHER')),
  amount INTEGER NOT NULL CHECK(amount>0),
  created_at TEXT NOT NULL CHECK(created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reference TEXT CHECK(reference IS NULL OR length(trim(reference))>0),
  note TEXT CHECK(note IS NULL OR length(trim(note))>0),
  created_by TEXT NOT NULL REFERENCES cashiers(id),
  cashier_name_snapshot TEXT NOT NULL
) STRICT;
CREATE INDEX supplier_opening_payments_supplier ON supplier_opening_payments(supplier_id,created_at,id);
CREATE INDEX supplier_opening_payments_receipt ON supplier_opening_payments(created_at);
CREATE TRIGGER supplier_opening_balances_no_update BEFORE UPDATE ON supplier_opening_balances
BEGIN SELECT RAISE(ABORT,'opening balances are immutable'); END;
CREATE TRIGGER supplier_opening_balances_no_delete BEFORE DELETE ON supplier_opening_balances
BEGIN SELECT RAISE(ABORT,'opening balances are immutable'); END;
CREATE TRIGGER supplier_opening_payments_no_update BEFORE UPDATE ON supplier_opening_payments
BEGIN SELECT RAISE(ABORT,'opening repayments are append-only'); END;
CREATE TRIGGER supplier_opening_payments_no_delete BEFORE DELETE ON supplier_opening_payments
BEGIN SELECT RAISE(ABORT,'opening repayments are append-only'); END;
CREATE TRIGGER supplier_opening_payments_within_outstanding BEFORE INSERT ON supplier_opening_payments
WHEN NEW.amount > (SELECT amount FROM supplier_opening_balances WHERE supplier_id=NEW.supplier_id)
  - (SELECT COALESCE(SUM(amount),0) FROM supplier_opening_payments WHERE supplier_id=NEW.supplier_id)
BEGIN SELECT RAISE(ABORT,'payment exceeds the outstanding amount'); END;
