ALTER TABLE cashiers ADD COLUMN language TEXT NOT NULL DEFAULT 'id'
  CHECK (language IN ('id', 'en'));
ALTER TABLE cashiers ADD COLUMN appearance TEXT NOT NULL DEFAULT 'SYSTEM'
  CHECK (appearance IN ('LIGHT', 'DARK', 'SYSTEM'));

UPDATE cashiers
SET language = (SELECT language FROM settings WHERE id = 1),
    appearance = (SELECT appearance FROM settings WHERE id = 1);
