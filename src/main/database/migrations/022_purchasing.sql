-- Purchasing is independent from sales. Posted values are immutable; later
-- deliveries, settlements and credits append their own records.
CREATE TABLE suppliers (
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 id TEXT PRIMARY KEY CHECK(length(id)>0), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 phone_number TEXT, normalized_phone TEXT NOT NULL DEFAULT '', email TEXT, address TEXT,
 is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX suppliers_phone ON suppliers(normalized_phone);
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers BEGIN SELECT RAISE(ABORT,'suppliers cannot be deleted'); END;

CREATE TABLE purchases (
 id TEXT PRIMARY KEY CHECK(length(id)>0), status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','FINALIZED','VOID')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), supplier_id TEXT REFERENCES suppliers(id),
 supplier_bill_reference TEXT, bill_date TEXT NOT NULL, top_days INTEGER NOT NULL DEFAULT 0 CHECK(top_days BETWEEN 0 AND 3650),
 due_date TEXT NOT NULL, note TEXT, vat_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(vat_rate_bps BETWEEN 0 AND 10000),
 subtotal INTEGER CHECK(subtotal>=0), discount_amount INTEGER CHECK(discount_amount>=0),
 amount INTEGER CHECK(amount>=0), tax_subtotal INTEGER CHECK(tax_subtotal>=0), vat_amount INTEGER CHECK(vat_amount>=0),
 document_number TEXT UNIQUE, supplier_snapshot TEXT, shop_snapshot TEXT,
 created_by TEXT NOT NULL REFERENCES cashiers(id), updated_by TEXT NOT NULL REFERENCES cashiers(id),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finalized_at TEXT, finalized_by TEXT REFERENCES cashiers(id),
 discarded_at TEXT, voided_at TEXT, voided_by TEXT REFERENCES cashiers(id), void_reason TEXT, void_amount INTEGER CHECK(void_amount>=0),
 CHECK(amount IS NULL OR (tax_subtotal IS NOT NULL AND vat_amount IS NOT NULL AND amount=tax_subtotal+vat_amount)),
 CHECK(status='DRAFT' OR (supplier_id IS NOT NULL AND document_number IS NOT NULL AND amount IS NOT NULL
   AND supplier_snapshot IS NOT NULL AND shop_snapshot IS NOT NULL AND finalized_at IS NOT NULL)),
 CHECK(status<>'VOID' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason))>0 AND void_amount IS NOT NULL))
) STRICT;
CREATE INDEX purchases_supplier ON purchases(supplier_id,status,bill_date,id);
CREATE INDEX purchases_finalized ON purchases(finalized_at,id);
CREATE INDEX purchases_voided ON purchases(voided_at,id);
CREATE TRIGGER purchases_no_delete BEFORE DELETE ON purchases BEGIN SELECT RAISE(ABORT,'purchases cannot be deleted'); END;
CREATE TRIGGER purchases_status_guard BEFORE UPDATE OF status ON purchases
WHEN NOT (NEW.status=OLD.status OR (OLD.status='DRAFT' AND NEW.status='FINALIZED') OR (OLD.status='FINALIZED' AND NEW.status='VOID'))
BEGIN SELECT RAISE(ABORT,'invalid purchase status transition'); END;
CREATE TRIGGER purchases_discarded_frozen BEFORE UPDATE ON purchases WHEN OLD.discarded_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'discarded purchases are frozen'); END;
CREATE TRIGGER purchases_posted_frozen BEFORE UPDATE ON purchases WHEN OLD.status<>'DRAFT' AND (
 NEW.supplier_id IS NOT OLD.supplier_id OR NEW.supplier_bill_reference IS NOT OLD.supplier_bill_reference OR NEW.bill_date IS NOT OLD.bill_date
 OR NEW.top_days IS NOT OLD.top_days OR NEW.due_date IS NOT OLD.due_date OR NEW.note IS NOT OLD.note
 OR NEW.vat_rate_bps IS NOT OLD.vat_rate_bps OR NEW.subtotal IS NOT OLD.subtotal OR NEW.discount_amount IS NOT OLD.discount_amount
 OR NEW.amount IS NOT OLD.amount OR NEW.tax_subtotal IS NOT OLD.tax_subtotal OR NEW.vat_amount IS NOT OLD.vat_amount
 OR NEW.document_number IS NOT OLD.document_number OR NEW.supplier_snapshot IS NOT OLD.supplier_snapshot OR NEW.shop_snapshot IS NOT OLD.shop_snapshot
 OR NEW.finalized_at IS NOT OLD.finalized_at OR NEW.finalized_by IS NOT OLD.finalized_by OR NEW.discarded_at IS NOT OLD.discarded_at
 OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'posted purchase values are immutable'); END;
CREATE TRIGGER purchases_void_frozen BEFORE UPDATE ON purchases WHEN OLD.status='VOID'
BEGIN SELECT RAISE(ABORT,'void purchases are frozen'); END;

CREATE TABLE purchase_items (
 id TEXT PRIMARY KEY CHECK(length(id)>0), purchase_id TEXT NOT NULL REFERENCES purchases(id), position INTEGER NOT NULL CHECK(position>=0),
 catalog_item_id TEXT REFERENCES catalog_items(id), ad_hoc_item_reference_id TEXT REFERENCES ad_hoc_item_references(id),
 type TEXT NOT NULL CHECK(type IN ('STOCK_ITEM','NON_STOCK_ITEM','SERVICE')), title TEXT NOT NULL CHECK(length(trim(title))>0),
 item_code TEXT, unit_label TEXT NOT NULL, track_inventory INTEGER NOT NULL DEFAULT 0 CHECK(track_inventory IN (0,1)),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000), unit_price INTEGER CHECK(unit_price>=0),
 amount INTEGER CHECK(amount>=0), tax_subtotal INTEGER CHECK(tax_subtotal>=0), vat_amount INTEGER CHECK(vat_amount>=0), removed_at TEXT,
 CHECK(track_inventory=0 OR (catalog_item_id IS NOT NULL AND type='STOCK_ITEM')),
 CHECK(amount IS NULL OR (tax_subtotal IS NOT NULL AND vat_amount IS NOT NULL AND amount=tax_subtotal+vat_amount))
) STRICT;
CREATE INDEX purchase_items_parent ON purchase_items(purchase_id,position,id);
CREATE TABLE purchase_discounts (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), purchase_item_id TEXT REFERENCES purchase_items(id),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 4), percentage_bps INTEGER NOT NULL CHECK(percentage_bps BETWEEN 0 AND 10000)
) STRICT;
CREATE UNIQUE INDEX purchase_discount_stages ON purchase_discounts(purchase_id,COALESCE(purchase_item_id,''),sequence);
CREATE TABLE purchase_checkout_allocations (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id),
 method TEXT NOT NULL CHECK(method IN ('CASH','QRIS','BANK_TRANSFER','DEBIT_CARD','CREDIT_CARD','OTHER')),
 amount INTEGER NOT NULL CHECK(amount>0), reference TEXT, note TEXT
) STRICT;
CREATE TABLE purchase_daily_counters (
 kind TEXT NOT NULL CHECK(kind IN ('PUR','RCV','PCN')), business_date TEXT NOT NULL, last_sequence INTEGER NOT NULL CHECK(last_sequence>0),
 PRIMARY KEY(kind,business_date)
) STRICT;
CREATE TRIGGER purchase_counters_forward BEFORE UPDATE ON purchase_daily_counters
WHEN NEW.last_sequence<=OLD.last_sequence OR NEW.kind<>OLD.kind OR NEW.business_date<>OLD.business_date
BEGIN SELECT RAISE(ABORT,'purchase counters only move forward'); END;
CREATE TRIGGER purchase_counters_no_delete BEFORE DELETE ON purchase_daily_counters BEGIN SELECT RAISE(ABORT,'purchase counters cannot be deleted'); END;

CREATE TABLE purchase_payments (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), method TEXT NOT NULL CHECK(method IN ('CASH','QRIS','BANK_TRANSFER','DEBIT_CARD','CREDIT_CARD','OTHER')),
 amount INTEGER NOT NULL CHECK(amount>0), reference TEXT, note TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES cashiers(id),
 cashier_name_snapshot TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('CHECKOUT','LATER'))
) STRICT;
CREATE TABLE purchase_refunds (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), method TEXT NOT NULL CHECK(method IN ('CASH','QRIS','BANK_TRANSFER','DEBIT_CARD','CREDIT_CARD','OTHER')),
 amount INTEGER NOT NULL CHECK(amount>0), reference TEXT, note TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES cashiers(id), cashier_name_snapshot TEXT NOT NULL
) STRICT;
CREATE TABLE purchase_receipts (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), document_number TEXT NOT NULL UNIQUE,
 stock_location_id TEXT NOT NULL REFERENCES stock_locations(id), location_snapshot TEXT NOT NULL, note TEXT,
 created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES cashiers(id), cashier_name_snapshot TEXT NOT NULL
) STRICT;
CREATE TABLE purchase_receipt_items (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES purchase_receipts(id), purchase_item_id TEXT NOT NULL REFERENCES purchase_items(id),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000), ledger_entry_id TEXT UNIQUE REFERENCES stock_ledger_entries(id),
 UNIQUE(receipt_id,purchase_item_id)
) STRICT;
CREATE TABLE purchase_receipt_reversals (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), receipt_id TEXT NOT NULL UNIQUE REFERENCES purchase_receipts(id),
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES cashiers(id), cashier_name_snapshot TEXT NOT NULL
) STRICT;
CREATE TABLE purchase_credits (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), document_number TEXT NOT NULL UNIQUE,
 amount INTEGER NOT NULL CHECK(amount>=0), tax_subtotal INTEGER NOT NULL CHECK(tax_subtotal>=0), vat_amount INTEGER NOT NULL CHECK(vat_amount>=0),
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES cashiers(id), cashier_name_snapshot TEXT NOT NULL,
 CHECK(amount=tax_subtotal+vat_amount)
) STRICT;
CREATE TABLE purchase_credit_items (
 id TEXT PRIMARY KEY, credit_id TEXT NOT NULL REFERENCES purchase_credits(id), purchase_item_id TEXT NOT NULL REFERENCES purchase_items(id),
 receipt_item_id TEXT REFERENCES purchase_receipt_items(id), quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 amount INTEGER NOT NULL CHECK(amount>=0), tax_subtotal INTEGER NOT NULL CHECK(tax_subtotal>=0), vat_amount INTEGER NOT NULL CHECK(vat_amount>=0),
 ledger_entry_id TEXT UNIQUE REFERENCES stock_ledger_entries(id), CHECK(amount=tax_subtotal+vat_amount)
) STRICT;
CREATE TABLE purchase_print_jobs (
 id INTEGER PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchases(id), document_type TEXT NOT NULL CHECK(document_type IN ('BILL','RECEIPT','CREDIT')),
 document_id TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('A4','THERMAL_58','THERMAL_80')), action TEXT NOT NULL CHECK(action IN ('PRINT','PDF_EXPORT')),
 outcome TEXT NOT NULL CHECK(outcome IN ('PRINTED','CANCELLED','FAILED')), error_code TEXT, is_reprint INTEGER NOT NULL CHECK(is_reprint IN (0,1)),
 requested_at TEXT NOT NULL, requested_by TEXT NOT NULL REFERENCES cashiers(id)
) STRICT;
CREATE UNIQUE INDEX stock_ledger_purchase_source ON stock_ledger_entries(reference_type,reference_id)
WHERE reference_type IN ('PURCHASE_RECEIPT_ITEM','PURCHASE_RETURN_ITEM','PURCHASE_RECEIPT_REVERSAL_ITEM');
CREATE TRIGGER purchases_prices_required BEFORE UPDATE OF status ON purchases WHEN NEW.status='FINALIZED' AND (
 NOT EXISTS(SELECT 1 FROM purchase_items WHERE purchase_id=NEW.id AND removed_at IS NULL)
 OR EXISTS(SELECT 1 FROM purchase_items WHERE purchase_id=NEW.id AND removed_at IS NULL AND (unit_price IS NULL OR amount IS NULL)))
BEGIN SELECT RAISE(ABORT,'purchase prices are required'); END;

CREATE TRIGGER purchase_items_draft_insert BEFORE INSERT ON purchase_items
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_items_draft_update BEFORE UPDATE ON purchase_items
WHEN NEW.purchase_id IS NOT OLD.purchase_id OR NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_items_draft_delete BEFORE DELETE ON purchase_items
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=OLD.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_discounts_draft_insert BEFORE INSERT ON purchase_discounts
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_discounts_draft_update BEFORE UPDATE ON purchase_discounts
WHEN NEW.purchase_id IS NOT OLD.purchase_id OR NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_discounts_draft_delete BEFORE DELETE ON purchase_discounts
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=OLD.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_checkout_allocations_draft_insert BEFORE INSERT ON purchase_checkout_allocations
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_checkout_allocations_draft_update BEFORE UPDATE ON purchase_checkout_allocations
WHEN NEW.purchase_id IS NOT OLD.purchase_id OR NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_checkout_allocations_draft_delete BEFORE DELETE ON purchase_checkout_allocations
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=OLD.purchase_id AND status='DRAFT' AND discarded_at IS NULL)
BEGIN SELECT RAISE(ABORT,'only open purchase drafts are editable'); END;

CREATE TRIGGER purchase_payments_no_update BEFORE UPDATE ON purchase_payments BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_payments_no_delete BEFORE DELETE ON purchase_payments BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_refunds_no_update BEFORE UPDATE ON purchase_refunds BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_refunds_no_delete BEFORE DELETE ON purchase_refunds BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipts_no_update BEFORE UPDATE ON purchase_receipts BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipts_no_delete BEFORE DELETE ON purchase_receipts BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipt_items_no_update BEFORE UPDATE ON purchase_receipt_items BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipt_items_no_delete BEFORE DELETE ON purchase_receipt_items BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipt_reversals_no_update BEFORE UPDATE ON purchase_receipt_reversals BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_receipt_reversals_no_delete BEFORE DELETE ON purchase_receipt_reversals BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_credits_no_update BEFORE UPDATE ON purchase_credits BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_credits_no_delete BEFORE DELETE ON purchase_credits BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_credit_items_no_update BEFORE UPDATE ON purchase_credit_items BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_credit_items_no_delete BEFORE DELETE ON purchase_credit_items BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_print_jobs_no_update BEFORE UPDATE ON purchase_print_jobs BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_print_jobs_no_delete BEFORE DELETE ON purchase_print_jobs BEGIN SELECT RAISE(ABORT,'purchase events are append-only'); END;

CREATE TRIGGER purchase_payments_issued_only BEFORE INSERT ON purchase_payments
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='FINALIZED')
BEGIN SELECT RAISE(ABORT,'purchase must be finalized'); END;

CREATE TRIGGER purchase_refunds_issued_only BEFORE INSERT ON purchase_refunds
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='FINALIZED')
BEGIN SELECT RAISE(ABORT,'purchase must be finalized'); END;

CREATE TRIGGER purchase_receipts_issued_only BEFORE INSERT ON purchase_receipts
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='FINALIZED')
BEGIN SELECT RAISE(ABORT,'purchase must be finalized'); END;

CREATE TRIGGER purchase_receipt_reversals_issued_only BEFORE INSERT ON purchase_receipt_reversals
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='FINALIZED')
BEGIN SELECT RAISE(ABORT,'purchase must be finalized'); END;

CREATE TRIGGER purchase_credits_issued_only BEFORE INSERT ON purchase_credits
WHEN NOT EXISTS(SELECT 1 FROM purchases WHERE id=NEW.purchase_id AND status='FINALIZED')
BEGIN SELECT RAISE(ABORT,'purchase must be finalized'); END;

CREATE INDEX purchase_payments_parent ON purchase_payments(purchase_id,created_at,id);
CREATE INDEX purchase_payments_time ON purchase_payments(created_at,id);

CREATE INDEX purchase_refunds_parent ON purchase_refunds(purchase_id,created_at,id);
CREATE INDEX purchase_refunds_time ON purchase_refunds(created_at,id);

CREATE INDEX purchase_receipts_parent ON purchase_receipts(purchase_id,created_at,id);
CREATE INDEX purchase_receipts_time ON purchase_receipts(created_at,id);

CREATE INDEX purchase_credits_parent ON purchase_credits(purchase_id,created_at,id);
CREATE INDEX purchase_credits_time ON purchase_credits(created_at,id);
