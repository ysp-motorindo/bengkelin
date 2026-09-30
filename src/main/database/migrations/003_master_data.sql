-- 003: master data (spec 5-8, 13): mechanics, customers, vehicle brands/models,
-- vehicles and vehicle ownership history. Records are deactivated, never deleted;
-- BEFORE DELETE guards protect every row that history depends on.
-- Instants are canonical UTC ISO text, like every earlier migration.

CREATE TABLE mechanics (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  phone_number TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

-- Customer (spec 6). A customer needs a name or a phone number. The phone is
-- kept as typed for display; `normalized_phone` (62... digits, '' when none) is
-- the search and duplicate-warning key. It is indexed but NOT unique: the
-- cashier may knowingly keep two customers on one number.
CREATE TABLE customers (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT,
  phone_number TEXT,
  normalized_phone TEXT NOT NULL DEFAULT '',
  email TEXT,
  birthdate TEXT CHECK (birthdate IS NULL OR birthdate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  address TEXT,
  rt TEXT,
  rw TEXT,
  kelurahan TEXT,
  kecamatan TEXT,
  city_or_regency TEXT,
  province TEXT,
  postal_code TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (
    (name IS NOT NULL AND length(name) > 0)
    OR (phone_number IS NOT NULL AND length(phone_number) > 0)
  )
) STRICT;

CREATE INDEX customers_normalized_phone ON customers (normalized_phone);
CREATE INDEX customers_name ON customers (name COLLATE NOCASE);

CREATE TABLE vehicle_brands (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

CREATE TABLE vehicle_models (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  brand_id TEXT NOT NULL REFERENCES vehicle_brands (id),
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  UNIQUE (brand_id, name)
) STRICT;

-- Actual motorcycle (spec 7.3). The UUID is the identity; the plate is a
-- unique, normalized search key with the display text kept as entered.
CREATE TABLE vehicles (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vehicle_model_id TEXT REFERENCES vehicle_models (id),
  plate_number TEXT NOT NULL CHECK (length(plate_number) > 0),
  normalized_plate_number TEXT NOT NULL UNIQUE CHECK (length(normalized_plate_number) > 0),
  year INTEGER CHECK (year IS NULL OR (year >= 1900 AND year <= 2100)),
  color TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT;

CREATE INDEX vehicles_model ON vehicles (vehicle_model_id);

-- Ownership history (spec 8). The active owner has effective_until NULL; at
-- most one such row per vehicle. A transfer closes the old row and opens the
-- new one at the same instant.
CREATE TABLE vehicle_ownerships (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  vehicle_id TEXT NOT NULL REFERENCES vehicles (id),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  effective_from TEXT NOT NULL CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  effective_until TEXT CHECK (effective_until IS NULL OR effective_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
) STRICT;

CREATE UNIQUE INDEX vehicle_ownerships_one_active
  ON vehicle_ownerships (vehicle_id) WHERE effective_until IS NULL;
CREATE INDEX vehicle_ownerships_customer ON vehicle_ownerships (customer_id);
CREATE INDEX vehicle_ownerships_vehicle ON vehicle_ownerships (vehicle_id, effective_from);

-- The only permitted change to an ownership row is closing it once.
CREATE TRIGGER vehicle_ownerships_history_guard BEFORE UPDATE ON vehicle_ownerships
WHEN OLD.effective_until IS NOT NULL
  OR NEW.vehicle_id <> OLD.vehicle_id
  OR NEW.customer_id <> OLD.customer_id
  OR NEW.effective_from <> OLD.effective_from
BEGIN
  SELECT RAISE(ABORT, 'ownership history cannot be rewritten');
END;

CREATE TRIGGER mechanics_no_delete BEFORE DELETE ON mechanics
BEGIN
  SELECT RAISE(ABORT, 'mechanics cannot be deleted; deactivate them instead');
END;

CREATE TRIGGER customers_no_delete BEFORE DELETE ON customers
BEGIN
  SELECT RAISE(ABORT, 'customers cannot be deleted');
END;

CREATE TRIGGER vehicle_brands_no_delete BEFORE DELETE ON vehicle_brands
BEGIN
  SELECT RAISE(ABORT, 'vehicle brands cannot be deleted; deactivate them instead');
END;

CREATE TRIGGER vehicle_models_no_delete BEFORE DELETE ON vehicle_models
BEGIN
  SELECT RAISE(ABORT, 'vehicle models cannot be deleted; deactivate them instead');
END;

CREATE TRIGGER vehicles_no_delete BEFORE DELETE ON vehicles
BEGIN
  SELECT RAISE(ABORT, 'vehicles cannot be deleted');
END;

CREATE TRIGGER vehicle_ownerships_no_delete BEFORE DELETE ON vehicle_ownerships
BEGIN
  SELECT RAISE(ABORT, 'ownership history cannot be deleted');
END;

CREATE TRIGGER channels_no_delete BEFORE DELETE ON channels
BEGIN
  SELECT RAISE(ABORT, 'channels cannot be deleted; deactivate them instead');
END;

CREATE TRIGGER units_no_delete BEFORE DELETE ON units
BEGIN
  SELECT RAISE(ABORT, 'units cannot be deleted; deactivate them instead');
END;
