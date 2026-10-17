ALTER TABLE cashiers ADD COLUMN number_format TEXT NOT NULL DEFAULT 'ID'
  CHECK (number_format IN ('ID', 'US', 'SYSTEM'));
