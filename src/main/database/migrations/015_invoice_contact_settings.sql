-- Current print-time contacts; invoice snapshots remain unchanged.
ALTER TABLE settings ADD COLUMN complaint_phone_number TEXT;
ALTER TABLE settings ADD COLUMN social_media_url TEXT;
