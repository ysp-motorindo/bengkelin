import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import type {
  ListReferencesInput,
  ReferenceDto,
  ReferenceIdInput,
  SaveReferenceData,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { ReferenceRepository } from './repository';

export interface ReferenceServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Reference data (spec 5, 7.1, 7.2, 9, 13). Management is ADMIN-only (spec
 * 55); any signed-in cashier may list ACTIVE entries for pickers. Entries are
 * deactivated, never deleted. Channel/unit `code` is stable after creation.
 */
export class ReferenceService {
  private readonly repo: ReferenceRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: ReferenceServiceDeps) {
    this.repo = new ReferenceRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  listActive(
    session: Session | undefined,
    input: ListReferencesInput,
  ): ReferenceDto[] {
    requireSession(session);
    return this.repo.list(input.entity, {
      activeOnly: true,
      brandId: input.brandId,
    });
  }

  list(
    session: Session | undefined,
    input: ListReferencesInput,
  ): ReferenceDto[] {
    requireAdmin(session);
    return this.repo.list(input.entity, {
      activeOnly: false,
      brandId: input.brandId,
    });
  }

  save(session: Session | undefined, input: SaveReferenceData): ReferenceDto {
    const actor = requireAdmin(session);
    return this.write((now) => {
      const existing = input.id
        ? this.mustFind(input.entity, input.id)
        : undefined;
      const id = existing?.id ?? this.newId();
      try {
        this.persist(input, id, existing, now);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainError(
            'REFERENCE_DUPLICATE',
            'A reference with that name or code already exists',
          );
        }
        throw error;
      }
      this.audit(
        actor,
        existing ? 'REFERENCE_UPDATED' : 'REFERENCE_CREATED',
        input.entity,
        id,
        input.entity === 'channel' || input.entity === 'unit'
          ? { code: existing?.code ?? input.code }
          : {},
      );
      return this.mustFind(input.entity, id);
    });
  }

  deactivate(session: Session | undefined, input: ReferenceIdInput) {
    return this.setActive(session, input, false);
  }

  reactivate(session: Session | undefined, input: ReferenceIdInput) {
    return this.setActive(session, input, true);
  }

  private setActive(
    session: Session | undefined,
    input: ReferenceIdInput,
    isActive: boolean,
  ): ReferenceDto {
    const actor = requireAdmin(session);
    return this.write((now) => {
      this.mustFind(input.entity, input.id);
      this.repo.setActive(input.entity, input.id, isActive, now);
      this.audit(
        actor,
        isActive ? 'REFERENCE_REACTIVATED' : 'REFERENCE_DEACTIVATED',
        input.entity,
        input.id,
        {},
      );
      return this.mustFind(input.entity, input.id);
    });
  }

  private persist(
    input: SaveReferenceData,
    id: string,
    existing: ReferenceDto | undefined,
    now: string,
  ): void {
    switch (input.entity) {
      case 'mechanic':
        if (existing) {
          this.repo.updateMechanic(id, input.name, input.phoneNumber, now);
        } else {
          this.repo.insertMechanic(id, input.name, input.phoneNumber, now);
        }
        return;
      case 'vehicleBrand':
        if (existing) this.repo.updateBrand(id, input.name);
        else this.repo.insertBrand(id, input.name);
        return;
      case 'vehicleModel':
        if (existing) {
          if (existing.brandId !== input.brandId) {
            throw new DomainError(
              'INVALID_BRAND_MODEL',
              'A model cannot move to another brand',
            );
          }
          this.repo.updateModel(id, input.name);
          return;
        }
        {
          const brand = this.mustFind('vehicleBrand', input.brandId);
          if (!brand.isActive) {
            throw new DomainError('REFERENCE_INACTIVE', 'Brand is inactive');
          }
          this.repo.insertModel(id, input.brandId, input.name);
        }
        return;
      case 'sales':
      case 'expedition':
        if (
          existing &&
          input.code !== undefined &&
          input.code !== existing.code
        ) {
          throw new DomainError(
            'REFERENCE_CODE_IMMUTABLE',
            'The code cannot be changed after creation',
          );
        }
        this.repo.saveContact(
          input.entity,
          id,
          existing?.code ?? (input.code as string),
          input.label,
          input.address,
          input.city,
          input.entity === 'sales' ? input.phoneNumber : null,
          now,
        );
        return;
      case 'channel':
      case 'unit':
        if (existing) {
          if (
            input.code !== undefined &&
            input.code.toUpperCase() !== (existing.code ?? '').toUpperCase()
          ) {
            throw new DomainError(
              'REFERENCE_CODE_IMMUTABLE',
              'The code cannot be changed after creation',
            );
          }
          this.repo.updateCodedLabel(input.entity, id, input.label);
        } else {
          this.repo.insertCoded(
            input.entity,
            id,
            input.code as string,
            input.label,
          );
        }
        return;
    }
  }

  private write<T>(work: (now: string) => T): T {
    return withWriteTransaction(this.deps.db, () =>
      work(this.deps.clock.now()),
    );
  }

  private mustFind(
    entity: ReferenceIdInput['entity'],
    id: string,
  ): ReferenceDto {
    const found = this.repo.find(entity, id);
    if (!found) {
      throw new DomainError('REFERENCE_NOT_FOUND', 'Reference not found');
    }
    return found;
  }

  /** Metadata carries ids and stable codes only: no names or phone numbers. */
  private audit(
    actor: Session,
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): void {
    appendAudit(this.deps.db, this.deps.clock, {
      cashierId: actor.cashierId,
      action,
      entityType: entity,
      entityId,
      metadata,
    });
  }
}
