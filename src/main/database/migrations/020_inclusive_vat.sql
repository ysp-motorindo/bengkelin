ALTER TABLE invoices ADD COLUMN vat_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(vat_rate_bps BETWEEN 0 AND 10000);
ALTER TABLE invoices ADD COLUMN tax_subtotal INTEGER CHECK(tax_subtotal IS NULL OR tax_subtotal >= 0);
ALTER TABLE invoices ADD COLUMN vat_amount INTEGER CHECK(vat_amount IS NULL OR vat_amount >= 0);
ALTER TABLE invoice_items ADD COLUMN allocated_invoice_discount INTEGER CHECK(allocated_invoice_discount IS NULL OR allocated_invoice_discount >= 0);
ALTER TABLE invoice_items ADD COLUMN final_amount INTEGER CHECK(final_amount IS NULL OR final_amount >= 0);
ALTER TABLE invoice_items ADD COLUMN tax_subtotal INTEGER CHECK(tax_subtotal IS NULL OR tax_subtotal >= 0);
ALTER TABLE invoice_items ADD COLUMN vat_amount INTEGER CHECK(vat_amount IS NULL OR vat_amount >= 0);
CREATE TRIGGER invoices_vat_immutable BEFORE UPDATE ON invoices
WHEN OLD.status IN ('FINALIZED', 'VOID') AND (
 NEW.vat_rate_bps IS NOT OLD.vat_rate_bps OR
 NEW.tax_subtotal IS NOT OLD.tax_subtotal OR
 NEW.vat_amount IS NOT OLD.vat_amount)
BEGIN SELECT RAISE(ABORT, 'finalized invoice VAT cannot change'); END;
