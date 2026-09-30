-- 005_inventory: append-only stock ledger (spec 24, 25, 29, 45) and the
-- idempotency payload hash.
--
-- Stock is ALWAYS SUM(quantity_delta) per item; nothing stores a total.
-- Instants are canonical UTC ISO text. Quantities are plain integers.

CREATE TABLE stock_ledger_entries (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items (id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('OPENING_BALANCE', 'STOCK_IN', 'SALE', 'VOID_REVERSAL', 'ADJUSTMENT')),
  quantity_delta INTEGER NOT NULL,
  -- What caused the movement, e.g. ('INVOICE', <invoice id>) for SALE and
  -- VOID_REVERSAL. No foreign key: the reference may point to any table.
  reference_type TEXT CHECK (reference_type IS NULL OR length(reference_type) > 0),
  reference_id TEXT CHECK (reference_id IS NULL OR length(reference_id) > 0),
  note TEXT,
  -- A VOID_REVERSAL points at the SALE it undoes; UNIQUE = reversed at most once.
  reverses_entry_id TEXT UNIQUE REFERENCES stock_ledger_entries (id),
  created_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  created_at TEXT NOT NULL
    CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Sign rules per movement type. Only OPENING_BALANCE may be zero.
  CHECK (
    (movement_type = 'OPENING_BALANCE' AND quantity_delta >= 0)
    OR (movement_type = 'STOCK_IN' AND quantity_delta > 0)
    OR (movement_type = 'SALE' AND quantity_delta < 0)
    OR (movement_type = 'VOID_REVERSAL' AND quantity_delta > 0)
    OR (movement_type = 'ADJUSTMENT' AND quantity_delta <> 0)
  ),
  -- A manual adjustment always carries its reason.
  CHECK (movement_type <> 'ADJUSTMENT' OR (note IS NOT NULL AND length(trim(note)) > 0)),
  CHECK ((reference_type IS NULL) = (reference_id IS NULL)),
  -- SALE and VOID_REVERSAL are always tied to their document.
  CHECK (movement_type NOT IN ('SALE', 'VOID_REVERSAL') OR reference_id IS NOT NULL),
  -- Exactly the reversals carry a reversal link.
  CHECK ((movement_type = 'VOID_REVERSAL') = (reverses_entry_id IS NOT NULL)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
) STRICT;

-- Stock sums and item history.
CREATE INDEX stock_ledger_entries_item ON stock_ledger_entries (catalog_item_id);
CREATE INDEX stock_ledger_entries_reference
  ON stock_ledger_entries (reference_type, reference_id);

-- One opening balance per item.
CREATE UNIQUE INDEX stock_ledger_one_opening_balance
  ON stock_ledger_entries (catalog_item_id)
  WHERE movement_type = 'OPENING_BALANCE';

-- One SALE per (document, item): finalization aggregates demand per item.
CREATE UNIQUE INDEX stock_ledger_one_sale_per_reference_item
  ON stock_ledger_entries (reference_type, reference_id, catalog_item_id)
  WHERE movement_type = 'SALE';

-- Append-only.
CREATE TRIGGER stock_ledger_entries_no_update BEFORE UPDATE ON stock_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger_entries is append-only');
END;

CREATE TRIGGER stock_ledger_entries_no_delete BEFORE DELETE ON stock_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger_entries is append-only');
END;

-- Services and other non-inventory items never move stock.
CREATE TRIGGER stock_ledger_entries_tracked_items_only BEFORE INSERT ON stock_ledger_entries
WHEN (SELECT track_inventory FROM catalog_items WHERE id = NEW.catalog_item_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'item does not track inventory');
END;

-- A reversal must undo one SALE of the same item and document, exactly.
CREATE TRIGGER stock_ledger_entries_reversal_matches_sale BEFORE INSERT ON stock_ledger_entries
WHEN NEW.movement_type = 'VOID_REVERSAL'
BEGIN
  SELECT RAISE(ABORT, 'a void reversal must exactly negate the sale it reverses')
  WHERE NOT EXISTS (
    SELECT 1 FROM stock_ledger_entries s
    WHERE s.id = NEW.reverses_entry_id
      AND s.movement_type = 'SALE'
      AND s.catalog_item_id = NEW.catalog_item_id
      AND s.quantity_delta = -NEW.quantity_delta
      AND s.reference_type IS NEW.reference_type
      AND s.reference_id IS NEW.reference_id
  );
END;

-- Once stock has moved, whether an item tracks inventory can no longer change.
CREATE TRIGGER catalog_items_tracking_locked_by_ledger
BEFORE UPDATE OF track_inventory ON catalog_items
WHEN NEW.track_inventory <> OLD.track_inventory
  AND EXISTS (SELECT 1 FROM stock_ledger_entries WHERE catalog_item_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'inventory tracking is locked by ledger entries');
END;

-- Idempotency hardening: SHA-256 (hex) of the canonical request payload.
-- NULL for receipts written before this migration.
ALTER TABLE command_receipts ADD COLUMN payload_hash TEXT
  CHECK (payload_hash IS NULL OR length(payload_hash) = 64);
