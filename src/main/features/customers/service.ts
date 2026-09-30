import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { normalizePhone } from '@/main/features/vehicles/normalization';
import { VehicleRepository } from '@/main/features/vehicles/repository';
import type {
  CustomerDetailDto,
  CustomerDto,
  CustomerIdInput,
  SaveCustomerData,
  SaveCustomerResult,
  SearchCustomersInput,
  SearchCustomersResult,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { CustomerRepository, type CustomerFields } from './repository';

export interface CustomerServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

const DEFAULT_LIMIT = 25;
const PHONE_LIKE = /^[+\d\s().-]+$/;

const EDITABLE: (keyof CustomerFields)[] = [
  'name',
  'phoneNumber',
  'email',
  'birthdate',
  'address',
  'rt',
  'rw',
  'kelurahan',
  'kecamatan',
  'cityOrRegency',
  'province',
  'postalCode',
];

/**
 * Customers (spec 6, 36, 51). Any signed-in cashier may create, edit and
 * search. There is no "Umum" record: anonymous is `customerId = null` in later
 * tasks. Duplicate phones warn (exact normalized match) and are permitted once
 * acknowledged.
 */
export class CustomerService {
  private readonly repo: CustomerRepository;
  private readonly vehicles: VehicleRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: CustomerServiceDeps) {
    this.repo = new CustomerRepository(deps.db);
    this.vehicles = new VehicleRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  search(
    session: Session | undefined,
    input: SearchCustomersInput,
  ): SearchCustomersResult {
    requireSession(session);
    const query = input.query.trim();
    if (query === '') return { results: [] };
    const phoneKey = PHONE_LIKE.test(query) ? normalizePhone(query) : '';
    return {
      results: this.repo.search(query, phoneKey, input.limit ?? DEFAULT_LIMIT),
    };
  }

  get(session: Session | undefined, input: CustomerIdInput): CustomerDetailDto {
    requireSession(session);
    return {
      customer: this.mustFind(input.id),
      vehicles: this.vehicles.listOwnedBy(input.id),
    };
  }

  save(
    session: Session | undefined,
    input: SaveCustomerData,
  ): SaveCustomerResult {
    const actor = requireSession(session);
    return withWriteTransaction(this.deps.db, () =>
      this.saveInTransaction(actor, input),
    );
  }

  private saveInTransaction(
    actor: Session,
    input: SaveCustomerData,
  ): SaveCustomerResult {
    const now = this.deps.clock.now();
    const fields: CustomerFields = {
      name: input.name,
      phoneNumber: input.phoneNumber,
      email: input.email,
      birthdate: input.birthdate,
      address: input.address,
      rt: input.rt,
      rw: input.rw,
      kelurahan: input.kelurahan,
      kecamatan: input.kecamatan,
      cityOrRegency: input.cityOrRegency,
      province: input.province,
      postalCode: input.postalCode,
    };
    if (!fields.name && !fields.phoneNumber) {
      throw new DomainError(
        'CUSTOMER_NAME_OR_PHONE_REQUIRED',
        'A customer needs a name or a phone number',
      );
    }
    const normalizedPhone = fields.phoneNumber
      ? normalizePhone(fields.phoneNumber)
      : '';

    const existing = input.id ? this.mustFind(input.id) : undefined;
    const phoneChanged =
      !existing || this.repo.normalizedPhoneOf(existing.id) !== normalizedPhone;
    const matches = phoneChanged
      ? this.repo.findByNormalizedPhone(normalizedPhone, existing?.id)
      : [];
    if (matches.length > 0 && input.acknowledgeDuplicates !== true) {
      return {
        saved: false,
        warning: { code: 'DUPLICATE_PHONE', matches },
      };
    }

    if (existing) {
      this.repo.update(existing.id, fields, normalizedPhone, now);
      this.audit(actor, 'CUSTOMER_UPDATED', existing.id, {
        changedFields: EDITABLE.filter((key) => existing[key] !== fields[key]),
      });
      return { saved: true, customer: this.mustFind(existing.id) };
    }
    const id = this.newId();
    this.repo.insert(id, fields, normalizedPhone, now);
    this.audit(actor, 'CUSTOMER_CREATED', id, {
      duplicatePhoneAcknowledged: matches.length > 0,
    });
    return { saved: true, customer: this.mustFind(id) };
  }

  private mustFind(id: string): CustomerDto {
    const found = this.repo.find(id);
    if (!found) {
      throw new DomainError('CUSTOMER_NOT_FOUND', 'Customer not found');
    }
    return found;
  }

  /** Metadata: ids, flags and field NAMES only. Never names, phones or addresses. */
  private audit(
    actor: Session,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): void {
    appendAudit(this.deps.db, this.deps.clock, {
      cashierId: actor.cashierId,
      action,
      entityType: 'customer',
      entityId,
      metadata,
    });
  }
}
