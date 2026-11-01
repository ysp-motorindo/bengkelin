-- Extend in place: triggers enforce required foreign keys without rebuilding history.
ALTER TABLE stock_ledger_entries ADD COLUMN stock_location_id TEXT REFERENCES stock_locations(id);
ALTER TABLE invoices ADD COLUMN stock_location_id TEXT REFERENCES stock_locations(id);
ALTER TABLE invoices ADD COLUMN stock_location_code_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN stock_location_label_snapshot TEXT;

INSERT INTO stock_locations (id, code, label, is_default)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), '01', 'Gudang', 1
WHERE (EXISTS (SELECT 1 FROM invoices) OR EXISTS (SELECT 1 FROM stock_ledger_entries))
  AND NOT EXISTS (SELECT 1 FROM stock_locations WHERE code = '01');

DROP TRIGGER stock_ledger_entries_no_update;
DROP TRIGGER invoices_void_immutable;
DROP TRIGGER invoices_discarded_frozen;
UPDATE stock_ledger_entries SET stock_location_id = (SELECT id FROM stock_locations WHERE code = '01');
UPDATE invoices SET stock_location_id = (SELECT id FROM stock_locations WHERE code = '01'),
  stock_location_code_snapshot = CASE WHEN status <> 'DRAFT' THEN '01' END,
  stock_location_label_snapshot = CASE WHEN status <> 'DRAFT' THEN (SELECT label FROM stock_locations WHERE code = '01') END;
CREATE TRIGGER stock_ledger_entries_no_update BEFORE UPDATE ON stock_ledger_entries
BEGIN SELECT RAISE(ABORT, 'stock_ledger_entries is append-only'); END;
CREATE TRIGGER invoices_discarded_frozen BEFORE UPDATE ON invoices
WHEN OLD.discarded_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a discarded draft cannot change'); END;
CREATE TRIGGER invoices_void_immutable BEFORE UPDATE ON invoices
WHEN OLD.status = 'VOID'
BEGIN SELECT RAISE(ABORT, 'a void invoice cannot change'); END;

DROP INDEX stock_ledger_one_opening_balance;
CREATE UNIQUE INDEX stock_ledger_one_opening_balance ON stock_ledger_entries(catalog_item_id, stock_location_id)
WHERE movement_type = 'OPENING_BALANCE';
CREATE INDEX stock_ledger_location_item ON stock_ledger_entries(stock_location_id, catalog_item_id);

CREATE TRIGGER stock_ledger_location_required BEFORE INSERT ON stock_ledger_entries
WHEN NEW.stock_location_id IS NULL
BEGIN SELECT RAISE(ABORT, 'stock location is required'); END;
CREATE TRIGGER invoices_location_required_insert BEFORE INSERT ON invoices
WHEN NEW.stock_location_id IS NULL
BEGIN SELECT RAISE(ABORT, 'stock location is required'); END;
CREATE TRIGGER invoices_location_required_update BEFORE UPDATE OF stock_location_id ON invoices
WHEN NEW.stock_location_id IS NULL
BEGIN SELECT RAISE(ABORT, 'stock location is required'); END;
CREATE TRIGGER invoices_issued_location_immutable BEFORE UPDATE ON invoices
WHEN OLD.status <> 'DRAFT' AND (
 NEW.stock_location_id IS NOT OLD.stock_location_id OR
 NEW.stock_location_code_snapshot IS NOT OLD.stock_location_code_snapshot OR
 NEW.stock_location_label_snapshot IS NOT OLD.stock_location_label_snapshot)
BEGIN SELECT RAISE(ABORT, 'issued invoice location cannot change'); END;
CREATE TRIGGER invoices_location_snapshot_required BEFORE UPDATE OF status ON invoices
WHEN NEW.status = 'FINALIZED' AND (NEW.stock_location_code_snapshot IS NULL OR NEW.stock_location_label_snapshot IS NULL)
BEGIN SELECT RAISE(ABORT, 'issued invoice location snapshot is required'); END;
CREATE TRIGGER stock_ledger_sale_location_matches_invoice BEFORE INSERT ON stock_ledger_entries
WHEN NEW.movement_type = 'SALE' AND NOT EXISTS (
 SELECT 1 FROM invoices WHERE id = NEW.reference_id AND NEW.reference_type = 'INVOICE' AND stock_location_id = NEW.stock_location_id)
BEGIN SELECT RAISE(ABORT, 'sale location must match invoice'); END;
CREATE TRIGGER stock_ledger_reversal_location_matches_sale BEFORE INSERT ON stock_ledger_entries
WHEN NEW.movement_type = 'VOID_REVERSAL' AND NOT EXISTS (
 SELECT 1 FROM stock_ledger_entries WHERE id = NEW.reverses_entry_id AND stock_location_id = NEW.stock_location_id)
BEGIN SELECT RAISE(ABORT, 'reversal location must match sale'); END;
CREATE TRIGGER invoices_location_snapshot_required_insert BEFORE INSERT ON invoices
WHEN NEW.status <> 'DRAFT' AND (NEW.stock_location_code_snapshot IS NULL OR NEW.stock_location_label_snapshot IS NULL)
BEGIN SELECT RAISE(ABORT, 'issued invoice location snapshot is required'); END;
CREATE TRIGGER invoices_sale_location_matches BEFORE UPDATE OF stock_location_id ON invoices
WHEN EXISTS (SELECT 1 FROM stock_ledger_entries s WHERE s.movement_type = 'SALE'
 AND s.reference_type = 'INVOICE' AND s.reference_id = OLD.id AND s.stock_location_id IS NOT NEW.stock_location_id)
BEGIN SELECT RAISE(ABORT, 'sale location must match invoice'); END;
