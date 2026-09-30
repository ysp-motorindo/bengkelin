-- 008: snapshots for invoice history, later payments and voids (spec 22, 29,
-- 34, 35, 60; Part A "snapshots for cashier labels").
--
-- New columns
--   payments.received_by_name_snapshot           receiver's display name when
--                                                the payment was recorded.
--   invoices.voided_by_name_snapshot             voiding cashier's display name.
--   invoices.customer_phone_normalized_snapshot  normalizePhone(customer_phone_snapshot)
--   invoices.plate_number_normalized_snapshot    normalizePlate(plate_number_snapshot)
-- Renaming a cashier, customer or vehicle never changes an issued invoice,
-- its payments or the history search that matches it.
--
-- BACKFILL. Existing payments are append-only and issued invoices are frozen
-- by triggers, so this migration (one BEGIN IMMEDIATE transaction, see
-- migrate.ts) drops the guards that would block the backfill, fills the new
-- columns, and recreates them:
--   payments_no_update            recreated with the IDENTICAL 007 text.
--   invoices_void_immutable       recreated with the IDENTICAL 006 text.
--   invoices_finalized_immutable  recreated as the 006 text plus the two new
--                                 search snapshot columns (frozen too); the
--                                 void name is deliberately NOT listed, so the
--                                 FINALIZED -> VOID update may set it.
-- tests/integration/invoice-lifecycle.test.ts proves this on a populated
-- version-7 database.
--
-- The normalized values use the app's own normalizePhone / normalizePlate,
-- registered by migrateDatabase as the deterministic SQL functions
-- bengkelin_normalize_phone / bengkelin_normalize_plate (SQL alone cannot
-- reproduce them exactly). The functions are used by this migration only;
-- no trigger, index or view depends on them. Existing receiver and voider
-- names are taken from the cashier's display name at upgrade time (the best
-- value available; earlier renames were never recorded).

ALTER TABLE payments ADD COLUMN received_by_name_snapshot TEXT
  CHECK (received_by_name_snapshot IS NULL OR length(trim(received_by_name_snapshot)) > 0);

ALTER TABLE invoices ADD COLUMN voided_by_name_snapshot TEXT
  CHECK (voided_by_name_snapshot IS NULL OR (voided_at IS NOT NULL AND length(trim(voided_by_name_snapshot)) > 0));
ALTER TABLE invoices ADD COLUMN customer_phone_normalized_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN plate_number_normalized_snapshot TEXT;

-- ---- backfill payments ----

DROP TRIGGER payments_no_update;

UPDATE payments SET received_by_name_snapshot =
  (SELECT c.display_name FROM cashiers c WHERE c.id = payments.received_by_cashier_id);

CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments are append-only');
END;

-- ---- backfill issued invoices ----

DROP TRIGGER invoices_void_immutable;
DROP TRIGGER invoices_finalized_immutable;

UPDATE invoices SET
  customer_phone_normalized_snapshot = bengkelin_normalize_phone(customer_phone_snapshot),
  plate_number_normalized_snapshot = bengkelin_normalize_plate(plate_number_snapshot)
WHERE status <> 'DRAFT';

UPDATE invoices SET voided_by_name_snapshot =
  (SELECT c.display_name FROM cashiers c WHERE c.id = invoices.voided_by_cashier_id)
WHERE status = 'VOID';

CREATE TRIGGER invoices_void_immutable BEFORE UPDATE ON invoices
WHEN OLD.status = 'VOID'
BEGIN
  SELECT RAISE(ABORT, 'a void invoice cannot change');
END;

CREATE TRIGGER invoices_finalized_immutable BEFORE UPDATE ON invoices
WHEN OLD.status = 'FINALIZED' AND (
     NEW.id IS NOT OLD.id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.vehicle_id IS NOT OLD.vehicle_id
  OR NEW.channel_id IS NOT OLD.channel_id
  OR NEW.invoice_date IS NOT OLD.invoice_date
  OR NEW.pricing_at IS NOT OLD.pricing_at
  OR NEW.top_days IS NOT OLD.top_days
  OR NEW.due_date IS NOT OLD.due_date
  OR NEW.odometer_km IS NOT OLD.odometer_km
  OR NEW.note IS NOT OLD.note
  OR NEW.subtotal IS NOT OLD.subtotal
  OR NEW.item_discount_amount IS NOT OLD.item_discount_amount
  OR NEW.invoice_discount_amount IS NOT OLD.invoice_discount_amount
  OR NEW.discount_amount IS NOT OLD.discount_amount
  OR NEW.amount IS NOT OLD.amount
  OR NEW.created_by_cashier_id IS NOT OLD.created_by_cashier_id
  OR NEW.last_edited_by_cashier_id IS NOT OLD.last_edited_by_cashier_id
  OR NEW.discarded_at IS NOT OLD.discarded_at
  OR NEW.discarded_by_cashier_id IS NOT OLD.discarded_by_cashier_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.invoice_number IS NOT OLD.invoice_number
  OR NEW.cashier_id IS NOT OLD.cashier_id
  OR NEW.finalized_at IS NOT OLD.finalized_at
  OR NEW.customer_name_snapshot IS NOT OLD.customer_name_snapshot
  OR NEW.customer_phone_snapshot IS NOT OLD.customer_phone_snapshot
  OR NEW.plate_number_snapshot IS NOT OLD.plate_number_snapshot
  OR NEW.vehicle_description_snapshot IS NOT OLD.vehicle_description_snapshot
  OR NEW.channel_label_snapshot IS NOT OLD.channel_label_snapshot
  OR NEW.cashier_name_snapshot IS NOT OLD.cashier_name_snapshot
  OR NEW.shop_identity_snapshot IS NOT OLD.shop_identity_snapshot
  OR NEW.customer_phone_normalized_snapshot IS NOT OLD.customer_phone_normalized_snapshot
  OR NEW.plate_number_normalized_snapshot IS NOT OLD.plate_number_normalized_snapshot
)
BEGIN
  SELECT RAISE(ABORT, 'a finalized invoice cannot change except to become void');
END;

-- ---- guards for the new columns (new rows) ----

-- Every payment names its receiver as they were called at the time.
CREATE TRIGGER payments_receiver_name_required BEFORE INSERT ON payments
WHEN NEW.received_by_name_snapshot IS NULL
BEGIN
  SELECT RAISE(ABORT, 'payments need a receiver name snapshot');
END;

-- FINALIZED -> VOID must record the voiding cashier's name.
CREATE TRIGGER invoices_void_name_required BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'FINALIZED' AND NEW.status = 'VOID' AND NEW.voided_by_name_snapshot IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a void needs the void name snapshot');
END;

-- Part A "Voiding": any positive payment blocks the void (the service
-- checks first and answers PAID_INVOICE_CANNOT_BE_VOIDED; this is the
-- backstop).
CREATE TRIGGER invoices_void_requires_no_payments BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'FINALIZED' AND NEW.status = 'VOID'
  AND EXISTS (SELECT 1 FROM payments WHERE invoice_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'an invoice with payments cannot be voided');
END;

-- Finalization writes a normalized search snapshot exactly where there is a
-- phone or plate snapshot.
CREATE TRIGGER invoices_search_snapshots_on_finalize BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'DRAFT' AND NEW.status = 'FINALIZED' AND (
     (NEW.customer_phone_snapshot IS NULL) <> (NEW.customer_phone_normalized_snapshot IS NULL)
  OR (NEW.plate_number_snapshot IS NULL) <> (NEW.plate_number_normalized_snapshot IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'finalization needs the normalized search snapshots');
END;

-- ---- history and receivables indexes ----

-- History order: newest finalization first, ties by id.
CREATE INDEX invoices_finalized_order ON invoices (finalized_at, id);
-- Date range on the invoice's calendar date.
CREATE INDEX invoices_invoice_date ON invoices (invoice_date);
CREATE INDEX invoices_channel ON invoices (channel_id);
-- The finalizing cashier.
CREATE INDEX invoices_cashier ON invoices (cashier_id);
-- Receivables: FINALIZED invoices by due date.
CREATE INDEX invoices_status_due ON invoices (status, due_date);
