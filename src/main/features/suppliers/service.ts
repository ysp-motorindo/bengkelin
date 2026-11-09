import { randomUUID } from 'node:crypto';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { runIdempotent } from '@/main/database/idempotency';
import { appendAudit } from '@/main/database/audit';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { normalizePhone } from '@/main/features/vehicles/normalization';
import { likePattern } from '@/main/features/customers/repository';
import type {
  SaveSupplierData,
  SaveSupplierResult,
  SearchSuppliersInput,
  SupplierDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
export interface SupplierRow {
  external_id: string | null;
  version: bigint;
  id: string;
  name: string;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  is_active: bigint;
  created_at: string;
  updated_at: string;
}
export const toSupplierDto = (r: SupplierRow): SupplierDto => ({
  id: r.id,
  externalId: r.external_id,
  version: Number(r.version),
  name: r.name,
  phoneNumber: r.phone_number,
  email: r.email,
  address: r.address,
  isActive: r.is_active === 1n,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export class SupplierService {
  constructor(private readonly deps: { db: AppDatabase; clock: Clock }) {}
  search(
    session: Session | undefined,
    input: SearchSuppliersInput,
  ): { results: SupplierDto[] } {
    requireSession(session);
    const q = likePattern(input.query);
    const phone = likePattern(normalizePhone(input.query));
    return {
      results: (
        this.deps.db
          .prepare(
            `SELECT * FROM suppliers WHERE (? OR is_active=1) AND (external_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR phone_number LIKE ? ESCAPE '\\' OR (?<>'' AND normalized_phone LIKE ? ESCAPE '\\')) ORDER BY name COLLATE NOCASE,id LIMIT ?`,
          )
          .all(
            input.includeInactive ? 1 : 0,
            q,
            q,
            q,
            normalizePhone(input.query),
            phone,
            input.limit ?? 25,
          ) as SupplierRow[]
      ).map(toSupplierDto),
    };
  }
  get(session: Session | undefined, input: { id: string }): SupplierDto {
    requireSession(session);
    const r = this.deps.db
      .prepare('SELECT * FROM suppliers WHERE id=?')
      .get(input.id) as SupplierRow | undefined;
    if (!r) throw new DomainError('SUPPLIER_NOT_FOUND');
    return toSupplierDto(r);
  }
  save(
    session: Session | undefined,
    input: SaveSupplierData,
  ): SaveSupplierResult {
    const actor = requireSession(session);
    const { requestId, ...payload } = input;
    const { db, clock } = this.deps;
    return withWriteTransaction(db, () =>
      runIdempotent(
        db,
        {
          requestId,
          command: 'suppliers.save',
          payload,
          actorCashierId: actor.cashierId,
          clock,
        },
        () => {
          const prior = input.id ? this.get(actor, { id: input.id }) : null;
          if (prior && prior.version !== input.expectedVersion)
            throw new DomainError('SUPPLIER_VERSION_CONFLICT');
          const phone = input.phoneNumber
            ? normalizePhone(input.phoneNumber)
            : '';
          const matches =
            phone &&
            phone !==
              (prior?.phoneNumber ? normalizePhone(prior.phoneNumber) : '')
              ? (
                  db
                    .prepare(
                      'SELECT * FROM suppliers WHERE normalized_phone=? AND id<>?',
                    )
                    .all(phone, input.id ?? '') as SupplierRow[]
                ).map(toSupplierDto)
              : [];
          if (matches.length && !input.acknowledgeDuplicates)
            return {
              saved: false,
              warning: { code: 'DUPLICATE_PHONE', matches },
            };
          const id = input.id ?? randomUUID();
          const now = clock.now();
          db.prepare(
            `INSERT INTO suppliers(id,name,phone_number,normalized_phone,email,address,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=suppliers.version+1,name=excluded.name,phone_number=excluded.phone_number,normalized_phone=excluded.normalized_phone,email=excluded.email,address=excluded.address,is_active=excluded.is_active,updated_at=excluded.updated_at`,
          ).run(
            id,
            input.name,
            input.phoneNumber,
            phone,
            input.email,
            input.address,
            (input.isActive ?? prior?.isActive ?? true) ? 1 : 0,
            now,
            now,
          );
          appendAudit(db, clock, {
            cashierId: actor.cashierId,
            action: prior ? 'SUPPLIER_UPDATED' : 'SUPPLIER_CREATED',
            entityType: 'supplier',
            entityId: id,
          });
          return { saved: true, supplier: this.get(actor, { id }) };
        },
      ),
    );
  }
}
