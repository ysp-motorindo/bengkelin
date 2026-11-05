CREATE TABLE customer_opening_balances (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  as_of_date TEXT NOT NULL CHECK (as_of_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(as_of_date, '+0 days') = as_of_date),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at TEXT NOT NULL,
  imported_by_cashier_id TEXT NOT NULL REFERENCES cashiers(id)
) STRICT;
CREATE TABLE customer_opening_payments (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  customer_id TEXT NOT NULL REFERENCES customer_opening_balances(customer_id),
  method TEXT NOT NULL CHECK(method IN ('CASH','QRIS','BANK_TRANSFER','DEBIT_CARD','CREDIT_CARD','OTHER')),
  amount INTEGER NOT NULL CHECK(amount>0),
  paid_at TEXT NOT NULL CHECK(paid_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reference TEXT CHECK(reference IS NULL OR length(trim(reference))>0),
  note TEXT CHECK(note IS NULL OR length(trim(note))>0),
  received_by_cashier_id TEXT NOT NULL REFERENCES cashiers(id),
  received_by_name_snapshot TEXT NOT NULL
) STRICT;
CREATE INDEX customer_opening_payments_customer ON customer_opening_payments(customer_id,paid_at,id);
CREATE INDEX customer_opening_payments_receipt ON customer_opening_payments(paid_at);
CREATE TRIGGER customer_opening_balances_no_update BEFORE UPDATE ON customer_opening_balances
BEGIN SELECT RAISE(ABORT,'opening balances are immutable'); END;
CREATE TRIGGER customer_opening_balances_no_delete BEFORE DELETE ON customer_opening_balances
BEGIN SELECT RAISE(ABORT,'opening balances are immutable'); END;
CREATE TRIGGER customer_opening_payments_no_update BEFORE UPDATE ON customer_opening_payments
BEGIN SELECT RAISE(ABORT,'opening repayments are append-only'); END;
CREATE TRIGGER customer_opening_payments_no_delete BEFORE DELETE ON customer_opening_payments
BEGIN SELECT RAISE(ABORT,'opening repayments are append-only'); END;
CREATE TRIGGER customer_opening_payments_within_outstanding BEFORE INSERT ON customer_opening_payments
WHEN NEW.amount > (SELECT amount FROM customer_opening_balances WHERE customer_id=NEW.customer_id)
  - (SELECT COALESCE(SUM(amount),0) FROM customer_opening_payments WHERE customer_id=NEW.customer_id)
BEGIN SELECT RAISE(ABORT,'payment exceeds the outstanding amount'); END;
