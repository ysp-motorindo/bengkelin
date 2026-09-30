-- 006: invoices (the transaction aggregate), invoice lines, discounts, line
-- price-change history, draft checkout allocations and ad-hoc item references
-- (spec 12, 15, 16, 18, 19, 20, 28; Part A "Persistence additions").
--
-- The FULL invoices table is created here, including the columns finalization
-- (T10) and void (T11) fill in, because tables cannot be rebuilt later.
-- A draft is an invoice with status DRAFT. Drafts are never deleted: a
-- discarded draft keeps its row with discarded_at set, and removed draft
-- lines are tombstoned (removed_at) so their price history survives.
--
-- Money is INTEGER whole rupiah. Instants are canonical UTC ISO text; dates
-- are YYYY-MM-DD.
--
-- STATUS GUARD (see the triggers below):
--   DRAFT      editable through the draft commands; lines, discounts and
--              allocations may change. Once discarded, frozen.
--   FINALIZED  frozen, except the single FINALIZED -> VOID transition, which
--              may set status, voided_at, voided_by_cashier_id, void_reason,
--              version and updated_at, and nothing else.
--   VOID       terminal; nothing may change.
-- Allowed status moves: DRAFT -> FINALIZED, FINALIZED -> VOID.
-- Child rows (lines, discounts, price changes, allocations) may only be
-- written while their invoice is a non-discarded DRAFT, so finalization must
-- write any line-level snapshot BEFORE it flips the status.

CREATE TABLE ad_hoc_item_references (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  type TEXT NOT NULL CHECK (type IN ('SERVICE', 'NON_STOCK_ITEM')),
  title TEXT NOT NULL COLLATE NOCASE CHECK (length(title) > 0),
  description TEXT,
  unit_id TEXT REFERENCES units (id),
  default_price INTEGER CHECK (default_price IS NULL OR default_price >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  UNIQUE (type, title)
) STRICT;

CREATE INDEX ad_hoc_item_references_title ON ad_hoc_item_references (title COLLATE NOCASE);

CREATE TRIGGER ad_hoc_item_references_no_delete BEFORE DELETE ON ad_hoc_item_references
BEGIN
  SELECT RAISE(ABORT, 'ad-hoc item references cannot be deleted; deactivate them instead');
END;

CREATE TABLE invoices (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'FINALIZED', 'VOID')),

  customer_id TEXT REFERENCES customers (id),
  vehicle_id TEXT REFERENCES vehicles (id),
  channel_id TEXT NOT NULL REFERENCES channels (id),

  -- Calendar date for TOP (spec 16). May be in the future while a draft;
  -- finalization rejects that.
  invoice_date TEXT NOT NULL CHECK (invoice_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- The one instant that selects catalog prices for new lines (Part A).
  pricing_at TEXT NOT NULL CHECK (pricing_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  top_days INTEGER NOT NULL DEFAULT 0 CHECK (top_days >= 0),
  due_date TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  odometer_km INTEGER CHECK (odometer_km IS NULL OR odometer_km >= 0),
  note TEXT,

  -- Authoritative totals, recomputed by every draft command.
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  item_discount_amount INTEGER NOT NULL CHECK (item_discount_amount >= 0),
  invoice_discount_amount INTEGER NOT NULL CHECK (invoice_discount_amount >= 0),
  discount_amount INTEGER NOT NULL CHECK (discount_amount >= 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),

  created_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  last_edited_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  -- Optimistic concurrency: every accepted command increments it.
  version INTEGER NOT NULL CHECK (version >= 1),
  discarded_at TEXT CHECK (discarded_at IS NULL OR discarded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  discarded_by_cashier_id TEXT REFERENCES cashiers (id),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),

  -- ---- Finalization (T10) ----
  invoice_number TEXT UNIQUE CHECK (invoice_number IS NULL OR length(invoice_number) > 0),
  -- The finalizing cashier: the sale is attributed to them.
  cashier_id TEXT REFERENCES cashiers (id),
  finalized_at TEXT CHECK (finalized_at IS NULL OR finalized_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  customer_name_snapshot TEXT,
  customer_phone_snapshot TEXT,
  plate_number_snapshot TEXT,
  vehicle_description_snapshot TEXT,
  channel_label_snapshot TEXT,
  cashier_name_snapshot TEXT,
  -- Printable shop identity (name, address, phone, footer...) as JSON.
  shop_identity_snapshot TEXT CHECK (shop_identity_snapshot IS NULL OR json_valid(shop_identity_snapshot)),

  -- ---- Void (T11) ----
  voided_at TEXT CHECK (voided_at IS NULL OR voided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  voided_by_cashier_id TEXT REFERENCES cashiers (id),
  void_reason TEXT,

  -- Totals are internally consistent.
  CHECK (discount_amount = item_discount_amount + invoice_discount_amount),
  CHECK (amount = subtotal - discount_amount),
  -- Only drafts are ever discarded, and the pair is set together.
  CHECK ((discarded_at IS NULL) = (discarded_by_cashier_id IS NULL)),
  CHECK (discarded_at IS NULL OR status = 'DRAFT'),
  -- Drafts carry no official number and no finalization or void data.
  CHECK (
    status <> 'DRAFT' OR (
      invoice_number IS NULL AND cashier_id IS NULL AND finalized_at IS NULL
      AND voided_at IS NULL AND voided_by_cashier_id IS NULL AND void_reason IS NULL
    )
  ),
  -- Finalized and void invoices always carry their number, finalizer and the
  -- snapshots that do not depend on optional data.
  CHECK (
    status = 'DRAFT' OR (
      invoice_number IS NOT NULL AND cashier_id IS NOT NULL AND finalized_at IS NOT NULL
      AND channel_label_snapshot IS NOT NULL AND cashier_name_snapshot IS NOT NULL
      AND shop_identity_snapshot IS NOT NULL
    )
  ),
  -- Void data exists exactly on VOID invoices, with a non-blank reason.
  CHECK (
    (status = 'VOID') = (voided_at IS NOT NULL)
    AND (voided_at IS NULL) = (voided_by_cashier_id IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL)
    AND (void_reason IS NULL OR length(trim(void_reason)) > 0)
  )
) STRICT;

-- Open drafts list (status + discarded filter, newest first).
CREATE INDEX invoices_status_updated ON invoices (status, updated_at);
CREATE INDEX invoices_customer ON invoices (customer_id);
CREATE INDEX invoices_vehicle ON invoices (vehicle_id);

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
BEGIN
  SELECT RAISE(ABORT, 'invoices cannot be deleted');
END;

-- A discarded draft is frozen: it can never be edited or "recreated".
CREATE TRIGGER invoices_discarded_frozen BEFORE UPDATE ON invoices
WHEN OLD.discarded_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a discarded draft cannot change');
END;

-- Only DRAFT -> FINALIZED and FINALIZED -> VOID.
CREATE TRIGGER invoices_status_transition BEFORE UPDATE OF status ON invoices
WHEN NEW.status IS NOT OLD.status
  AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'FINALIZED')
  AND NOT (OLD.status = 'FINALIZED' AND NEW.status = 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'invalid invoice status transition');
END;

-- VOID is terminal.
CREATE TRIGGER invoices_void_immutable BEFORE UPDATE ON invoices
WHEN OLD.status = 'VOID'
BEGIN
  SELECT RAISE(ABORT, 'a void invoice cannot change');
END;

-- A FINALIZED invoice keeps every financial, header and snapshot column. Only
-- the void columns, status, version and updated_at may move (to VOID).
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
)
BEGIN
  SELECT RAISE(ABORT, 'a finalized invoice cannot change except to become void');
END;

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  -- Display order within the invoice (1-based, never reused).
  position INTEGER NOT NULL CHECK (position >= 1),

  catalog_item_id TEXT REFERENCES catalog_items (id),
  ad_hoc_item_reference_id TEXT REFERENCES ad_hoc_item_references (id),

  item_type_snapshot TEXT NOT NULL CHECK (item_type_snapshot IN ('STOCK_ITEM', 'SERVICE', 'NON_STOCK_ITEM')),
  title_snapshot TEXT NOT NULL CHECK (length(title_snapshot) > 0),
  unit_id TEXT REFERENCES units (id),
  unit_snapshot TEXT,

  mechanic_id TEXT REFERENCES mechanics (id),
  mechanic_name_snapshot TEXT,

  quantity INTEGER NOT NULL CHECK (quantity >= 1),

  -- The catalog price resolved when the line was added or refreshed; NULL
  -- for custom lines and when no price was configured.
  listed_unit_price INTEGER CHECK (listed_unit_price IS NULL OR listed_unit_price >= 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),

  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  discount_amount INTEGER NOT NULL CHECK (discount_amount >= 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),

  -- Price provenance (Part A).
  resolved_price_id TEXT REFERENCES catalog_item_prices (id),
  price_resolved_at TEXT CHECK (price_resolved_at IS NULL OR price_resolved_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  manual_price_override INTEGER NOT NULL DEFAULT 0 CHECK (manual_price_override IN (0, 1)),

  -- Tombstone for a removed draft line (history is kept).
  removed_at TEXT CHECK (removed_at IS NULL OR removed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  removed_by_cashier_id TEXT REFERENCES cashiers (id),

  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),

  UNIQUE (invoice_id, position),
  -- A line comes from a catalog item, an ad-hoc reference, or neither.
  CHECK (catalog_item_id IS NULL OR ad_hoc_item_reference_id IS NULL),
  CHECK (catalog_item_id IS NULL OR item_type_snapshot IN ('STOCK_ITEM', 'SERVICE')),
  CHECK (catalog_item_id IS NOT NULL OR item_type_snapshot IN ('SERVICE', 'NON_STOCK_ITEM')),
  CHECK (resolved_price_id IS NULL OR (catalog_item_id IS NOT NULL AND listed_unit_price IS NOT NULL)),
  CHECK (catalog_item_id IS NOT NULL OR (listed_unit_price IS NULL AND price_resolved_at IS NULL)),
  -- Mechanics are assigned to service lines only.
  CHECK (mechanic_id IS NULL OR item_type_snapshot = 'SERVICE'),
  CHECK ((mechanic_id IS NULL) = (mechanic_name_snapshot IS NULL)),
  CHECK ((removed_at IS NULL) = (removed_by_cashier_id IS NULL)),
  CHECK (subtotal = quantity * unit_price),
  CHECK (amount = subtotal - discount_amount)
) STRICT;

CREATE INDEX invoice_items_catalog_item ON invoice_items (catalog_item_id);
CREATE INDEX invoice_items_ad_hoc ON invoice_items (ad_hoc_item_reference_id);

CREATE TABLE invoice_item_discounts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_item_id TEXT NOT NULL REFERENCES invoice_items (id),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4),
  percentage_bps INTEGER NOT NULL CHECK (percentage_bps BETWEEN 0 AND 10000),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  UNIQUE (invoice_item_id, sequence)
) STRICT;

CREATE TABLE invoice_discounts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4),
  percentage_bps INTEGER NOT NULL CHECK (percentage_bps BETWEEN 0 AND 10000),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  UNIQUE (invoice_id, sequence)
) STRICT;

-- Every price change on a line (spec 19). Append-only. previous_price is NULL
-- exactly for a manual entry where no catalog price was configured.
CREATE TABLE invoice_item_price_changes (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_item_id TEXT NOT NULL REFERENCES invoice_items (id),
  -- Order of the changes on one line (1, 2, ...).
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('MANUAL_OVERRIDE', 'MISSING_PRICE_ENTRY', 'PRICE_REFRESH')),
  previous_price INTEGER CHECK (previous_price IS NULL OR previous_price >= 0),
  new_price INTEGER NOT NULL CHECK (new_price >= 0),
  changed_by_cashier_id TEXT NOT NULL REFERENCES cashiers (id),
  changed_at TEXT NOT NULL CHECK (changed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
  UNIQUE (invoice_item_id, sequence),
  CHECK ((kind = 'MISSING_PRICE_ENTRY') = (previous_price IS NULL))
) STRICT;

CREATE TRIGGER invoice_item_price_changes_no_update BEFORE UPDATE ON invoice_item_price_changes
BEGIN
  SELECT RAISE(ABORT, 'invoice_item_price_changes is append-only');
END;

CREATE TRIGGER invoice_item_price_changes_no_delete BEFORE DELETE ON invoice_item_price_changes
BEGIN
  SELECT RAISE(ABORT, 'invoice_item_price_changes is append-only');
END;

-- Planned payment split chosen at checkout (Part A). NOT payments: nothing
-- here is money received. Finalization (T10) consumes these.
CREATE TABLE draft_checkout_allocations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'QRIS', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'OTHER')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT,
  note TEXT,
  UNIQUE (invoice_id, sequence)
) STRICT;

-- ---- Child rows change only while the invoice is an open (non-discarded) draft ----

CREATE TRIGGER invoice_items_draft_insert BEFORE INSERT ON invoice_items
WHEN (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = NEW.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invoice lines change only on an open draft');
END;

CREATE TRIGGER invoice_items_draft_update BEFORE UPDATE ON invoice_items
WHEN NEW.invoice_id IS NOT OLD.invoice_id
  OR (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = OLD.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invoice lines change only on an open draft');
END;

-- Removed lines are tombstoned, never deleted.
CREATE TRIGGER invoice_items_no_delete BEFORE DELETE ON invoice_items
BEGIN
  SELECT RAISE(ABORT, 'invoice lines cannot be deleted');
END;

CREATE TRIGGER invoice_item_discounts_draft_insert BEFORE INSERT ON invoice_item_discounts
WHEN (SELECT i.status = 'DRAFT' AND i.discarded_at IS NULL
      FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.id = NEW.invoice_item_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'line discounts change only on an open draft');
END;

CREATE TRIGGER invoice_item_discounts_draft_update BEFORE UPDATE ON invoice_item_discounts
WHEN NEW.invoice_item_id IS NOT OLD.invoice_item_id
  OR (SELECT i.status = 'DRAFT' AND i.discarded_at IS NULL
      FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.id = OLD.invoice_item_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'line discounts change only on an open draft');
END;

CREATE TRIGGER invoice_item_discounts_draft_delete BEFORE DELETE ON invoice_item_discounts
WHEN (SELECT i.status = 'DRAFT' AND i.discarded_at IS NULL
      FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.id = OLD.invoice_item_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'line discounts change only on an open draft');
END;

CREATE TRIGGER invoice_discounts_draft_insert BEFORE INSERT ON invoice_discounts
WHEN (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = NEW.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invoice discounts change only on an open draft');
END;

CREATE TRIGGER invoice_discounts_draft_update BEFORE UPDATE ON invoice_discounts
WHEN NEW.invoice_id IS NOT OLD.invoice_id
  OR (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = OLD.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invoice discounts change only on an open draft');
END;

CREATE TRIGGER invoice_discounts_draft_delete BEFORE DELETE ON invoice_discounts
WHEN (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = OLD.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'invoice discounts change only on an open draft');
END;

CREATE TRIGGER invoice_item_price_changes_draft_insert BEFORE INSERT ON invoice_item_price_changes
WHEN (SELECT i.status = 'DRAFT' AND i.discarded_at IS NULL
      FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.id = NEW.invoice_item_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'price changes are recorded only on an open draft');
END;

CREATE TRIGGER draft_checkout_allocations_draft_insert BEFORE INSERT ON draft_checkout_allocations
WHEN (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = NEW.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'checkout allocations change only on an open draft');
END;

CREATE TRIGGER draft_checkout_allocations_draft_update BEFORE UPDATE ON draft_checkout_allocations
WHEN NEW.invoice_id IS NOT OLD.invoice_id
  OR (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = OLD.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'checkout allocations change only on an open draft');
END;

CREATE TRIGGER draft_checkout_allocations_draft_delete BEFORE DELETE ON draft_checkout_allocations
WHEN (SELECT status = 'DRAFT' AND discarded_at IS NULL FROM invoices WHERE id = OLD.invoice_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'checkout allocations change only on an open draft');
END;
