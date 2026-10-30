import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CHANNELS } from '@/shared/channels';
import type {
  CustomerDto,
  ReferenceDto,
  SaveCustomerResult,
  SaveVehicleResult,
  SearchCustomersResult,
  SearchVehiclesResult,
  VehicleDetailDto,
} from '@/shared/contracts';
import { toInstant } from '@/shared/time';
import {
  ADMIN_PASSWORD,
  createHarness,
  failure,
  validSetup,
  value,
  type Harness,
} from './helpers/harness';

const C = CHANNELS;
const ADMIN = 1;
const CASHIER = 2;
const T0 = Date.UTC(2026, 8, 30, 3, 0, 0);

let h: Harness;
let nowMs = T0;
const tick = (ms = 60_000) => {
  nowMs += ms;
  return toInstant(nowMs);
};

beforeEach(async () => {
  nowMs = T0;
  h = createHarness({ clock: { now: () => toInstant(nowMs) } });
  value(await h.call(C.settings.completeSetup, validSetup()));
  value(
    await h.call(
      C.auth.login,
      { username: 'admin', password: ADMIN_PASSWORD },
      ADMIN,
    ),
  );
  value(
    await h.call(C.cashiers.create, {
      username: 'siti',
      displayName: 'Siti',
      password: 'siti-password-1',
      role: 'CASHIER',
    }),
  );
  value(
    await h.call(
      C.auth.login,
      { username: 'siti', password: 'siti-password-1' },
      CASHIER,
    ),
  );
});
afterEach(() => h.close());

const rows = (sql: string, ...params: unknown[]) =>
  h.db.prepare(sql).all(...params) as Record<string, unknown>[];

async function ref(
  input: Record<string, unknown>,
  windowId = ADMIN,
): Promise<ReferenceDto> {
  return value(await h.call<ReferenceDto>(C.references.save, input, windowId));
}

async function newCustomer(
  input: Record<string, unknown> = {
    name: 'Budi',
    phoneNumber: '081234567890',
  },
  windowId = CASHIER,
) {
  const result = value(
    await h.call<SaveCustomerResult>(C.customers.save, input, windowId),
  );
  if (!result.saved) throw new Error('expected saved');
  return result.customer;
}

async function brandAndModel() {
  const brand = await ref({ entity: 'vehicleBrand', name: 'Honda' });
  const model = await ref({
    entity: 'vehicleModel',
    brandId: brand.id,
    name: 'Vario 160',
  });
  return { brand, model };
}

async function newVehicle(
  input: Record<string, unknown>,
  windowId = CASHIER,
): Promise<SaveVehicleResult> {
  return value(
    await h.call<SaveVehicleResult>(C.vehicles.save, input, windowId),
  );
}

const activeOwnerships = (vehicleId: string) =>
  rows(
    'SELECT * FROM vehicle_ownerships WHERE vehicle_id = ? AND effective_until IS NULL',
    vehicleId,
  );

describe('reference management', () => {
  test('ADMIN creates, edits, deactivates and reactivates; audit rows are written', async () => {
    const mechanic = await ref({
      entity: 'mechanic',
      name: 'Joko',
      phoneNumber: '0811',
    });
    expect(mechanic).toMatchObject({
      entity: 'mechanic',
      label: 'Joko',
      isActive: true,
    });
    const renamed = await ref({
      entity: 'mechanic',
      id: mechanic.id,
      name: 'Joko S',
    });
    expect(renamed.label).toBe('Joko S');

    const off = value(
      await h.call<ReferenceDto>(C.references.deactivate, {
        entity: 'mechanic',
        id: mechanic.id,
      }),
    );
    expect(off.isActive).toBe(false);
    const on = value(
      await h.call<ReferenceDto>(C.references.reactivate, {
        entity: 'mechanic',
        id: mechanic.id,
      }),
    );
    expect(on.isActive).toBe(true);

    const actions = rows(
      "SELECT action FROM audit_log WHERE entity_type = 'mechanic' ORDER BY id",
    ).map((r) => r.action);
    expect(actions).toEqual([
      'REFERENCE_CREATED',
      'REFERENCE_UPDATED',
      'REFERENCE_DEACTIVATED',
      'REFERENCE_REACTIVATED',
    ]);
    expect(
      JSON.stringify(rows('SELECT metadata FROM audit_log')),
    ).not.toContain('0811');
  });

  test('channel and unit code is stable, the label is editable, names are unique', async () => {
    const channels = value(
      await h.call<ReferenceDto[]>(C.references.list, { entity: 'channel' }),
    );
    const shopee = channels.find((c) => c.code === 'ONLINE')!;
    const edited = await ref({
      entity: 'channel',
      id: shopee.id,
      code: 'ONLINE',
      label: 'Online Mall',
    });
    expect(edited).toMatchObject({ code: 'ONLINE', label: 'Online Mall' });
    const changed = await h.call(C.references.save, {
      entity: 'channel',
      id: shopee.id,
      code: 'OTHER',
      label: 'x',
    });
    expect(failure(changed).code).toBe('REFERENCE_CODE_IMMUTABLE');

    const unit = await ref({ entity: 'unit', code: 'DRUM', label: 'Drum' });
    expect(unit.code).toBe('DRUM');
    const dup = await h.call(C.references.save, {
      entity: 'unit',
      code: 'drum',
      label: 'Drum 2',
    });
    expect(failure(dup).code).toBe('REFERENCE_DUPLICATE');

    await ref({ entity: 'vehicleBrand', name: 'Yamaha' });
    const dupBrand = await h.call(C.references.save, {
      entity: 'vehicleBrand',
      name: 'YAMAHA',
    });
    expect(failure(dupBrand).code).toBe('REFERENCE_DUPLICATE');
  });

  test('CASHIER (and anonymous) cannot manage references, but can list active ones', async () => {
    const { brand } = await brandAndModel();
    const inactive = await ref({ entity: 'vehicleBrand', name: 'Suzuki' });
    value(
      await h.call(C.references.deactivate, {
        entity: 'vehicleBrand',
        id: inactive.id,
      }),
    );

    const attempts = await Promise.all([
      h.call(C.references.list, { entity: 'unit' }, CASHIER),
      h.call(
        C.references.save,
        { entity: 'vehicleBrand', name: 'Kawasaki' },
        CASHIER,
      ),
      h.call(
        C.references.deactivate,
        { entity: 'vehicleBrand', id: brand.id },
        CASHIER,
      ),
      h.call(
        C.references.reactivate,
        { entity: 'vehicleBrand', id: inactive.id },
        CASHIER,
      ),
    ]);
    for (const attempt of attempts)
      expect(failure(attempt).code).toBe('FORBIDDEN');

    const active = value(
      await h.call<ReferenceDto[]>(
        C.references.listActive,
        { entity: 'vehicleBrand' },
        CASHIER,
      ),
    );
    expect(active.map((r) => r.label)).toEqual(['Honda']);

    const anonymous = await h.call(
      C.references.listActive,
      { entity: 'unit' },
      99,
    );
    expect(failure(anonymous).code).toBe('UNAUTHENTICATED');
    expect(
      rows("SELECT 1 FROM vehicle_brands WHERE name = 'Kawasaki'"),
    ).toEqual([]);
  });

  test('models are listed per brand', async () => {
    const { brand } = await brandAndModel();
    const other = await ref({ entity: 'vehicleBrand', name: 'Yamaha' });
    await ref({ entity: 'vehicleModel', brandId: other.id, name: 'NMAX' });
    const models = value(
      await h.call<ReferenceDto[]>(
        C.references.listActive,
        { entity: 'vehicleModel', brandId: brand.id },
        CASHIER,
      ),
    );
    expect(models.map((m) => m.label)).toEqual(['Vario 160']);
  });
});

describe('customers', () => {
  test('a new customer needs a name or a phone number', async () => {
    const empty = await h.call(C.customers.save, {}, CASHIER);
    expect(failure(empty).code).toBe('CUSTOMER_NAME_OR_PHONE_REQUIRED');
    const blank = await h.call(
      C.customers.save,
      { name: '  ', phoneNumber: '' },
      CASHIER,
    );
    expect(failure(blank).code).toBe('CUSTOMER_NAME_OR_PHONE_REQUIRED');
    const nameOnly = await newCustomer({ name: 'Ani' });
    expect(nameOnly.phoneNumber).toBeNull();
    const phoneOnly = await newCustomer({ phoneNumber: '0899 111 222' });
    expect(phoneOnly.name).toBeNull();
    expect(rows('SELECT id FROM customers')).toHaveLength(2);
  });

  test('duplicate phone warns, saves nothing until acknowledged, then permits', async () => {
    const first = await newCustomer({
      name: 'Budi',
      phoneNumber: '0812-3456-7890',
    });
    const attempt = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { name: 'Budi Lain', phoneNumber: '+62 812 3456 7890' },
        CASHIER,
      ),
    );
    expect(attempt.saved).toBe(false);
    if (attempt.saved) return;
    expect(attempt.warning.code).toBe('DUPLICATE_PHONE');
    expect(attempt.warning.matches.map((c) => c.id)).toEqual([first.id]);
    expect(rows('SELECT id FROM customers')).toHaveLength(1);

    const acknowledged = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        {
          name: 'Budi Lain',
          phoneNumber: '+62 812 3456 7890',
          acknowledgeDuplicates: true,
        },
        CASHIER,
      ),
    );
    expect(acknowledged.saved).toBe(true);
    const stored = rows('SELECT normalized_phone FROM customers');
    expect(stored).toHaveLength(2);
    expect(stored[0]!.normalized_phone).toBe('628123456789' + '0');
    expect(stored[1]!.normalized_phone).toBe(stored[0]!.normalized_phone);
  });

  test('editing keeps the display phone and only warns when the phone changes', async () => {
    const a = await newCustomer({ name: 'A', phoneNumber: '0811111' });
    await newCustomer({ name: 'B', phoneNumber: '0822222' });
    const rename = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { id: a.id, name: 'A2', phoneNumber: '0811111' },
        CASHIER,
      ),
    );
    expect(rename).toMatchObject({ saved: true, customer: { name: 'A2' } });
    const clash = value(
      await h.call<SaveCustomerResult>(
        C.customers.save,
        { id: a.id, name: 'A2', phoneNumber: '0822222' },
        CASHIER,
      ),
    );
    expect(clash.saved).toBe(false);
    const cleared = await h.call(
      C.customers.save,
      { id: a.id, name: '', phoneNumber: '' },
      CASHIER,
    );
    expect(failure(cleared).code).toBe('CUSTOMER_NAME_OR_PHONE_REQUIRED');
  });

  test('search matches name substrings case-insensitively and normalized phones, capped', async () => {
    await newCustomer({ name: 'Budi Santoso', phoneNumber: '0812-1111-2222' });
    await newCustomer({ name: 'Siti Budiarti' });
    await newCustomer({ name: 'Joko', phoneNumber: '0857 999' });
    const byName = value(
      await h.call<SearchCustomersResult>(
        C.customers.search,
        { query: 'bUDI' },
        CASHIER,
      ),
    );
    expect(byName.results.map((c) => c.name).sort()).toEqual([
      'Budi Santoso',
      'Siti Budiarti',
    ]);
    const byPhone = value(
      await h.call<SearchCustomersResult>(
        C.customers.search,
        { query: '+62 812 1111' },
        CASHIER,
      ),
    );
    expect(byPhone.results.map((c) => c.name)).toEqual(['Budi Santoso']);
    const capped = value(
      await h.call<SearchCustomersResult>(
        C.customers.search,
        { query: 'i', limit: 2 },
        CASHIER,
      ),
    );
    expect(capped.results).toHaveLength(2);
    // Wildcards in the query are literal.
    const wild = value(
      await h.call<SearchCustomersResult>(
        C.customers.search,
        { query: '%' },
        CASHIER,
      ),
    );
    expect(wild.results).toEqual([]);
  });

  test('creation is audited without customer PII; no anonymous customer row exists', async () => {
    const c = await newCustomer({
      name: 'Rahasia Nama',
      phoneNumber: '081377778888',
    });
    await newCustomer({
      id: c.id,
      name: 'Rahasia Baru',
      phoneNumber: '081377778888',
    });
    const audit = rows(
      "SELECT action, cashier_id, entity_id, metadata FROM audit_log WHERE entity_type = 'customer' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      'CUSTOMER_CREATED',
      'CUSTOMER_UPDATED',
    ]);
    expect(audit.every((a) => a.entity_id === c.id && a.cashier_id)).toBe(true);
    const text = JSON.stringify(audit);
    expect(text).not.toContain('Rahasia');
    expect(text).not.toContain('081377778888');
    expect(rows('SELECT id FROM customers')).toHaveLength(1);
  });

  test('anonymous callers are rejected', async () => {
    const r = await h.call(C.customers.search, { query: 'a' }, 77);
    expect(failure(r).code).toBe('UNAUTHENTICATED');
  });
});

describe('vehicles', () => {
  test('plate variants reuse the existing vehicle instead of creating a second row', async () => {
    const { brand, model } = await brandAndModel();
    const created = await newVehicle({
      plateNumber: 'B 1234 XYZ',
      brandId: brand.id,
      vehicleModelId: model.id,
      year: 2022,
    });
    expect(created.reusedExisting).toBe(false);
    expect(created.vehicle).toMatchObject({
      plateNumber: 'B 1234 XYZ',
      normalizedPlateNumber: 'B1234XYZ',
      brandName: 'Honda',
      modelName: 'Vario 160',
    });
    const existingVehicle = created.vehicle;

    for (const variant of ['b-1234-xyz', 'B1234XYZ', ' b 1234 xyz ']) {
      const again = await newVehicle({ plateNumber: variant });
      expect(again.reusedExisting).toBe(true);
      expect(again.warning).toBe('PLATE_EXISTS');
      expect(again.vehicle.id).toBe(existingVehicle.id);
    }
    expect(rows('SELECT id FROM vehicles')).toHaveLength(1);

    const plateSearch = value(
      await h.call<SearchVehiclesResult>(
        C.vehicles.searchByPlate,
        { query: 'b-1234-xyz' },
        CASHIER,
      ),
    );
    expect(plateSearch.results[0]!.id).toBe(existingVehicle.id);
    // Partial input finds it too.
    const partial = value(
      await h.call<SearchVehiclesResult>(
        C.vehicles.searchByPlate,
        { query: '1234' },
        CASHIER,
      ),
    );
    expect(partial.results.map((v) => v.id)).toEqual([existingVehicle.id]);
  });

  test('global lookup returns the current active owner regardless of who is asking', async () => {
    const owner = await newCustomer();
    const { vehicle } = await newVehicle({
      plateNumber: 'D 55 AB',
      ownerCustomerId: owner.id,
    });
    const found = value(
      await h.call<SearchVehiclesResult>(
        C.vehicles.searchByPlate,
        { query: 'd55ab' },
        CASHIER,
      ),
    );
    expect(found.results[0]).toMatchObject({
      id: vehicle.id,
      activeOwnerId: owner.id,
      activeOwner: { id: owner.id, name: 'Budi' },
    });
  });

  test('the model must belong to the chosen brand and be active', async () => {
    const { brand, model } = await brandAndModel();
    const yamaha = await ref({ entity: 'vehicleBrand', name: 'Yamaha' });
    const mismatch = await h.call(
      C.vehicles.save,
      { plateNumber: 'B 1 A', brandId: yamaha.id, vehicleModelId: model.id },
      CASHIER,
    );
    expect(failure(mismatch).code).toBe('INVALID_BRAND_MODEL');
    const noBrand = await h.call(
      C.vehicles.save,
      { plateNumber: 'B 1 A', vehicleModelId: model.id },
      CASHIER,
    );
    expect(failure(noBrand).code).toBe('INVALID_BRAND_MODEL');
    const unknown = await h.call(
      C.vehicles.save,
      {
        plateNumber: 'B 1 A',
        brandId: brand.id,
        vehicleModelId: '0b7c3f0e-3c0e-4c86-9a5e-1a2b3c4d5e6f',
      },
      CASHIER,
    );
    expect(failure(unknown).code).toBe('REFERENCE_NOT_FOUND');

    value(
      await h.call(C.references.deactivate, {
        entity: 'vehicleModel',
        id: model.id,
      }),
    );
    const inactive = await h.call(
      C.vehicles.save,
      { plateNumber: 'B 1 A', brandId: brand.id, vehicleModelId: model.id },
      CASHIER,
    );
    expect(failure(inactive).code).toBe('REFERENCE_INACTIVE');
    expect(rows('SELECT id FROM vehicles')).toHaveLength(0);

    // Model is optional.
    const plain = await newVehicle({ plateNumber: 'B 1 A' });
    expect(plain.vehicle.modelName).toBeNull();
  });

  test('plate edits cannot collide with another vehicle', async () => {
    const a = await newVehicle({ plateNumber: 'B 1 A' });
    await newVehicle({ plateNumber: 'B 2 A' });
    const clash = await h.call(
      C.vehicles.save,
      { id: a.vehicle.id, plateNumber: 'b-2-a' },
      CASHIER,
    );
    expect(failure(clash).code).toBe('PLATE_EXISTS');
    const ok = await newVehicle({
      id: a.vehicle.id,
      plateNumber: 'B 1 A',
      color: 'Merah',
    });
    expect(ok.vehicle.color).toBe('Merah');
  });
});

describe('vehicle ownership', () => {
  test('a vehicle created for a customer starts with exactly one active ownership', async () => {
    const owner = await newCustomer();
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: owner.id,
    });
    expect(activeOwnerships(vehicle.id)).toHaveLength(1);
    const unowned = await newVehicle({ plateNumber: 'B 10 Z' });
    expect(unowned.vehicle.activeOwnerId).toBeNull();
    expect(activeOwnerships(unowned.vehicle.id)).toHaveLength(0);
  });

  test('the database itself refuses a second active ownership', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici' });
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: a.id,
    });
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, effective_from, effective_until)
           VALUES ('x1', ?, ?, '2026-10-01T00:00:00.000Z', NULL)`,
        )
        .run(vehicle.id, b.id),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      h.db
        .prepare(
          `INSERT INTO vehicle_ownerships (id, vehicle_id, customer_id, effective_from, effective_until)
           VALUES ('x2', ?, ?, '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        )
        .run(vehicle.id, b.id),
    ).toThrow(/CHECK/i);
  });

  test('transfer closes the previous ownership at exactly the transfer instant', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici', phoneNumber: '0855' });
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: a.id,
    });
    const transferInstant = tick();
    const detail = value(
      await h.call<VehicleDetailDto>(
        C.vehicles.transferOwnership,
        { vehicleId: vehicle.id, newCustomerId: b.id },
        CASHIER,
      ),
    );
    expect(detail.vehicle.activeOwnerId).toBe(b.id);
    expect(activeOwnerships(vehicle.id)).toHaveLength(1);

    const all = rows(
      'SELECT * FROM vehicle_ownerships WHERE vehicle_id = ? ORDER BY effective_from',
      vehicle.id,
    );
    expect(all).toHaveLength(2);
    const previousOwnership = detail.ownerships.find(
      (o) => o.customerId === a.id,
    )!;
    const current = detail.ownerships.find((o) => o.customerId === b.id)!;
    expect(previousOwnership.effectiveUntil).toBe(transferInstant);
    expect(current.effectiveFrom).toBe(transferInstant);
    expect(current.effectiveUntil).toBeNull();
    expect(all[0]!.effective_until).toBe(transferInstant);
    expect(all[1]!.effective_from).toBe(transferInstant);
    // History is newest first.
    expect(detail.ownerships[0]!.customerId).toBe(b.id);

    const audit = rows(
      "SELECT metadata FROM audit_log WHERE action = 'VEHICLE_OWNERSHIP_TRANSFERRED'",
    );
    expect(audit).toHaveLength(1);
    expect(String(audit[0]!.metadata)).not.toContain('Cici');
  });

  test('transferring to the current owner is rejected; unknown targets too', async () => {
    const a = await newCustomer();
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: a.id,
    });
    tick();
    const same = await h.call(
      C.vehicles.transferOwnership,
      { vehicleId: vehicle.id, newCustomerId: a.id },
      CASHIER,
    );
    expect(failure(same).code).toBe('ALREADY_OWNER');
    const nobody = await h.call(
      C.vehicles.transferOwnership,
      {
        vehicleId: vehicle.id,
        newCustomerId: '0b7c3f0e-3c0e-4c86-9a5e-1a2b3c4d5e6f',
      },
      CASHIER,
    );
    expect(failure(nobody).code).toBe('CUSTOMER_NOT_FOUND');
    const noVehicle = await h.call(
      C.vehicles.transferOwnership,
      {
        vehicleId: '0b7c3f0e-3c0e-4c86-9a5e-1a2b3c4d5e6f',
        newCustomerId: a.id,
      },
      CASHIER,
    );
    expect(failure(noVehicle).code).toBe('VEHICLE_NOT_FOUND');
    expect(activeOwnerships(vehicle.id)).toHaveLength(1);
  });

  test('a transfer within the same instant as the opening is refused, not a constraint crash', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici' });
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: a.id,
    });
    const r = await h.call(
      C.vehicles.transferOwnership,
      { vehicleId: vehicle.id, newCustomerId: b.id },
      CASHIER,
    );
    expect(failure(r).code).toBe('OWNERSHIP_TRANSFER_TOO_SOON');
    expect(activeOwnerships(vehicle.id)[0]!.customer_id).toBe(a.id);
  });

  test('an unowned vehicle gets its first owner via transfer; retries with a requestId replay', async () => {
    const a = await newCustomer();
    const { vehicle } = await newVehicle({ plateNumber: 'B 9 Z' });
    const requestId = '6f1a4f0e-3c0e-4c86-9a5e-1a2b3c4d5e6f';
    const input = { requestId, vehicleId: vehicle.id, newCustomerId: a.id };
    const first = value(
      await h.call<VehicleDetailDto>(
        C.vehicles.transferOwnership,
        input,
        CASHIER,
      ),
    );
    expect(first.ownerships).toHaveLength(1);
    const replay = value(
      await h.call<VehicleDetailDto>(
        C.vehicles.transferOwnership,
        input,
        CASHIER,
      ),
    );
    expect(replay).toEqual(first);
    expect(rows('SELECT id FROM vehicle_ownerships')).toHaveLength(1);

    // The same key for a different target is a client error, not a replay.
    const b = await newCustomer({ name: 'Cici' });
    const reused = await h.call(
      C.vehicles.transferOwnership,
      { requestId, vehicleId: vehicle.id, newCustomerId: b.id },
      CASHIER,
    );
    expect(failure(reused)).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      messageKey: 'errors.IDEMPOTENCY_KEY_REUSED',
    });
    expect(rows('SELECT id FROM vehicle_ownerships')).toHaveLength(1);
  });

  test('selecting or looking up a vehicle and customer never changes ownership', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici' });
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      ownerCustomerId: a.id,
    });
    tick();
    await h.call(C.vehicles.searchByPlate, { query: 'B9Z' }, CASHIER);
    await h.call(C.vehicles.get, { id: vehicle.id }, CASHIER);
    await h.call(C.customers.get, { id: b.id }, CASHIER);
    await newVehicle({ id: vehicle.id, plateNumber: 'B 9 Z', notes: 'x' });
    const still = activeOwnerships(vehicle.id);
    expect(still).toHaveLength(1);
    expect(still[0]!.customer_id).toBe(a.id);
    expect(rows('SELECT id FROM vehicle_ownerships')).toHaveLength(1);
  });

  test('customer detail lists the vehicles currently owned', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici' });
    const one = await newVehicle({
      plateNumber: 'B 1 A',
      ownerCustomerId: a.id,
    });
    await newVehicle({ plateNumber: 'B 2 A', ownerCustomerId: b.id });
    const detail = value(
      await h.call<{ customer: CustomerDto; vehicles: { id: string }[] }>(
        C.customers.get,
        { id: a.id },
        CASHIER,
      ),
    );
    expect(detail.vehicles.map((v) => v.id)).toEqual([one.vehicle.id]);
  });
});

describe('history protection', () => {
  test('master-data rows and ownership history cannot be deleted or rewritten', async () => {
    const a = await newCustomer();
    const b = await newCustomer({ name: 'Cici' });
    const { brand, model } = await brandAndModel();
    const { vehicle } = await newVehicle({
      plateNumber: 'B 9 Z',
      brandId: brand.id,
      vehicleModelId: model.id,
      ownerCustomerId: a.id,
    });
    tick();
    value(
      await h.call(
        C.vehicles.transferOwnership,
        { vehicleId: vehicle.id, newCustomerId: b.id },
        CASHIER,
      ),
    );
    for (const table of [
      'customers',
      'vehicles',
      'vehicle_ownerships',
      'vehicle_brands',
      'vehicle_models',
      'channels',
      'units',
    ]) {
      expect(() => h.db.prepare(`DELETE FROM ${table}`).run()).toThrow();
    }
    expect(() =>
      h.db
        .prepare(
          "UPDATE vehicle_ownerships SET effective_until = '2030-01-01T00:00:00.000Z' WHERE effective_until IS NOT NULL",
        )
        .run(),
    ).toThrow(/history/i);
  });
});

describe.each(['sales', 'expedition'] as const)('%s masters', (entity) => {
  test('stores contacts, normalizes immutable codes and allows duplicate names', async () => {
    const a = await ref({
      entity,
      code: '001a',
      label: 'Same name',
      address: ' Street ',
      city: ' City ',
      ...(entity === 'sales' ? { phoneNumber: '08123' } : {}),
    });
    expect(a).toMatchObject({ code: '001A', address: 'Street', city: 'City' });
    await ref({ entity, code: '002', label: 'Same name' });
    expect(
      failure(
        await h.call(C.references.save, {
          entity,
          code: '001A',
          label: 'Other',
        }),
      ).code,
    ).toBe('REFERENCE_DUPLICATE');
    expect(
      failure(
        await h.call(C.references.save, {
          entity,
          id: a.id,
          code: 'CHANGED',
          label: 'Changed',
        }),
      ).code,
    ).toBe('REFERENCE_CODE_IMMUTABLE');
    const cleared = await ref({
      entity,
      id: a.id,
      label: 'Updated',
      address: null,
      city: '',
    });
    expect(cleared).toMatchObject({ address: null, city: null });
    value(await h.call(C.references.deactivate, { entity, id: a.id }));
    const active = value(
      await h.call<ReferenceDto[]>(
        C.references.listActive,
        { entity },
        CASHIER,
      ),
    );
    expect(active.map((r) => r.id)).not.toContain(a.id);
    expect(
      failure(
        await h.call(
          C.references.save,
          { entity, code: '003', label: 'Forbidden' },
          CASHIER,
        ),
      ).code,
    ).toBe('FORBIDDEN');
    value(await h.call(C.references.reactivate, { entity, id: a.id }));
  });
});
