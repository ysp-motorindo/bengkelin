ALTER TABLE customers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE customers ADD COLUMN external_id TEXT CHECK (external_id IS NULL OR length(trim(external_id)) > 0);
CREATE UNIQUE INDEX customers_external_id ON customers(external_id);
