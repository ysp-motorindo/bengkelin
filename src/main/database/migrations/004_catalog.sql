-- 004: catalog items, barcodes and START-ONLY channel prices (spec 10, 11, 13,
-- Part A "Start-only pricing rules"). Rows are deactivated, never deleted.
-- Instants are canonical UTC ISO text, like every earlier migration.
--
-- A price point has a start and nothing else: it stays effective until a later
-- point starts. There is deliberately NO end column. Superseding a point is
-- audit metadata for an explicit correction, not a validity end.

CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  type TEXT NOT NULL CHECK (type IN ('STOCK_ITEM', 'SERVICE')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  description TEXT,
  sku TEXT COLLATE NOCASE UNIQUE CHECK (sku IS NULL OR length(sku) > 0),
  unit_id TEXT NOT NULL REFERENCES units (id),
  -- Grams. Optional.
  weight INTEGER CHECK (weight IS NULL OR weight >= 0),
  track_inventory INTEGER NOT NULL CHECK (track_inventory IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Services are non-inventory in v1.
  CHECK (type <> 'SERVICE' OR track_inventory = 0)
) STRICT;

CREATE INDEX catalog_items_title ON catalog_items (title COLLATE NOCASE);
CREATE INDEX catalog_items_unit ON catalog_items (unit_id);

CREATE TRIGGER catalog_items_no_delete BEFORE DELETE ON catalog_items
BEGIN
  SELECT RAISE(ABORT, 'catalog items cannot be deleted; deactivate them instead');
END;

-- The barcode text is kept as typed (leading zeros!). UNIQUE across ALL rows,
-- active or not, so one value never belongs to two items.
CREATE TABLE catalog_item_barcodes (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items (id),
  barcode TEXT NOT NULL UNIQUE CHECK (length(barcode) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

CREATE INDEX catalog_item_barcodes_item ON catalog_item_barcodes (catalog_item_id);

CREATE TRIGGER catalog_item_barcodes_no_delete BEFORE DELETE ON catalog_item_barcodes
BEGIN
  SELECT RAISE(ABORT, 'barcodes cannot be deleted; deactivate them instead');
END;

CREATE TABLE catalog_item_prices (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_items (id),
  channel_id TEXT NOT NULL REFERENCES channels (id),
  effective_start_at TEXT NOT NULL CHECK (effective_start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  currency TEXT NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  price INTEGER NOT NULL CHECK (price >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  created_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  -- Revision metadata: set once, when an explicit correction replaces this point.
  superseded_at TEXT CHECK (superseded_at IS NULL OR superseded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  superseded_by_cashier_id TEXT REFERENCES cashiers (id),
  -- On the REPLACING point: which revision it corrects, and why.
  supersedes_price_id TEXT REFERENCES catalog_item_prices (id),
  correction_reason TEXT CHECK (correction_reason IS NULL OR length(correction_reason) > 0),
  CHECK ((superseded_at IS NULL) = (superseded_by_cashier_id IS NULL)),
  CHECK (supersedes_price_id IS NULL OR correction_reason IS NOT NULL)
) STRICT;

-- One non-superseded point per item, channel and start. This partial index is
-- also the access path of the resolution query
-- (... AND effective_start_at <= ? AND superseded_at IS NULL ORDER BY effective_start_at DESC LIMIT 1).
CREATE UNIQUE INDEX catalog_item_prices_live_start
  ON catalog_item_prices (catalog_item_id, channel_id, effective_start_at)
  WHERE superseded_at IS NULL;

-- Whole history (timeline, fingerprints, revisions) for an item and channel.
CREATE INDEX catalog_item_prices_history
  ON catalog_item_prices (catalog_item_id, channel_id, effective_start_at, created_at);

CREATE INDEX catalog_item_prices_supersedes
  ON catalog_item_prices (supersedes_price_id) WHERE supersedes_price_id IS NOT NULL;

-- Append-only: nothing about a point may change except the one-time
-- NULL -> value move of its superseded_* pair.
CREATE TRIGGER catalog_item_prices_immutable BEFORE UPDATE ON catalog_item_prices
WHEN NEW.id IS NOT OLD.id
  OR NEW.catalog_item_id IS NOT OLD.catalog_item_id
  OR NEW.channel_id IS NOT OLD.channel_id
  OR NEW.effective_start_at IS NOT OLD.effective_start_at
  OR NEW.currency IS NOT OLD.currency
  OR NEW.price IS NOT OLD.price
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by_cashier_id IS NOT OLD.created_by_cashier_id
  OR NEW.supersedes_price_id IS NOT OLD.supersedes_price_id
  OR NEW.correction_reason IS NOT OLD.correction_reason
  OR (OLD.superseded_at IS NOT NULL
      AND (NEW.superseded_at IS NOT OLD.superseded_at
           OR NEW.superseded_by_cashier_id IS NOT OLD.superseded_by_cashier_id))
BEGIN
  SELECT RAISE(ABORT, 'catalog_item_prices is append-only');
END;

CREATE TRIGGER catalog_item_prices_no_delete BEFORE DELETE ON catalog_item_prices
BEGIN
  SELECT RAISE(ABORT, 'catalog_item_prices is append-only');
END;
