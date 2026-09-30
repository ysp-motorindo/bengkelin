-- Task 13: daily report range scans (spec 33).
--
-- Sales activity is bucketed by finalized_at (existing index
-- invoices_finalized_order (finalized_at, id), migration 008) and payment
-- activity by paid_at (existing index payments_paid_at, migration 007).
-- Void activity is bucketed by voided_at, which had no index: a report
-- query `voided_at >= ? AND voided_at < ?` implies `voided_at IS NOT NULL`,
-- so this partial index (only VOID invoices) serves it.
CREATE INDEX invoices_voided_at ON invoices (voided_at) WHERE voided_at IS NOT NULL;
