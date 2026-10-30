ALTER TABLE invoices ADD COLUMN reserved_invoice_number TEXT;
CREATE UNIQUE INDEX invoices_reserved_number ON invoices(reserved_invoice_number);
ALTER TABLE invoices ADD COLUMN tax_invoice_number TEXT CHECK(tax_invoice_number IS NULL OR length(tax_invoice_number) <= 100);
CREATE TRIGGER invoices_reservation_immutable BEFORE UPDATE ON invoices
WHEN OLD.reserved_invoice_number IS NOT NULL AND NEW.reserved_invoice_number IS NOT OLD.reserved_invoice_number
BEGIN SELECT RAISE(ABORT, 'reserved invoice number cannot change'); END;
CREATE TRIGGER invoices_refinement_finalized_immutable BEFORE UPDATE ON invoices
WHEN OLD.status IN ('FINALIZED','VOID') AND (
 NEW.reserved_invoice_number IS NOT OLD.reserved_invoice_number OR
 NEW.tax_invoice_number IS NOT OLD.tax_invoice_number)
BEGIN SELECT RAISE(ABORT, 'finalized invoice metadata cannot change'); END;

ALTER TABLE invoice_items ADD COLUMN price_entry_confirmed INTEGER NOT NULL DEFAULT 1 CHECK(price_entry_confirmed IN (0,1));

ALTER TABLE invoices ADD COLUMN cash_received INTEGER CHECK(cash_received IS NULL OR cash_received >= 0);
CREATE TRIGGER invoices_cash_immutable BEFORE UPDATE ON invoices
WHEN OLD.status IN ('FINALIZED','VOID') AND NEW.cash_received IS NOT OLD.cash_received
BEGIN SELECT RAISE(ABORT, 'finalized invoice cash cannot change'); END;
