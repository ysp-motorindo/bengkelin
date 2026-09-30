import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type {
  AdHocReferenceDto,
  AdHocReferenceIdInput,
  ListAdHocReferencesInput,
  SearchAdHocReferencesInput,
  SearchAdHocReferencesResult,
  UpdateAdHocReferenceData,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { AdHocReferenceRepository } from './repository';

const DEFAULT_LIMIT = 25;

/**
 * Reusable free-form line references (spec 12). They are created and reused
 * by `drafts.apply({ kind: 'addCustomLine' })`. Any signed-in cashier gets
 * the autocomplete (active rows only); ADMIN lists every reference, edits
 * its description and deactivates or reactivates it. Deactivation only
 * hides it from autocomplete: lines that used it keep their link and
 * snapshot title. References are never deleted.
 */
export class AdHocReferenceService {
  private readonly repo: AdHocReferenceRepository;

  constructor(private readonly deps: { db: AppDatabase; clock: Clock }) {
    this.repo = new AdHocReferenceRepository(deps.db);
  }

  search(
    session: Session | undefined,
    input: SearchAdHocReferencesInput,
  ): SearchAdHocReferencesResult {
    requireSession(session);
    return {
      results: this.repo.search(
        input.query.trim(),
        input.type,
        Math.min(input.limit ?? DEFAULT_LIMIT, 50),
      ),
    };
  }

  list(
    session: Session | undefined,
    input: ListAdHocReferencesInput,
  ): AdHocReferenceDto[] {
    requireAdmin(session);
    return this.repo.list(input.query?.trim() ?? '');
  }

  update(
    session: Session | undefined,
    input: UpdateAdHocReferenceData,
  ): AdHocReferenceDto {
    const actor = requireAdmin(session);
    return this.write(actor, input.id, 'AD_HOC_REFERENCE_UPDATED', (now) =>
      this.repo.setDescription(input.id, input.description, now),
    );
  }

  deactivate(
    session: Session | undefined,
    input: AdHocReferenceIdInput,
  ): AdHocReferenceDto {
    const actor = requireAdmin(session);
    return this.write(actor, input.id, 'AD_HOC_REFERENCE_DEACTIVATED', (now) =>
      this.repo.setActive(input.id, false, now),
    );
  }

  reactivate(
    session: Session | undefined,
    input: AdHocReferenceIdInput,
  ): AdHocReferenceDto {
    const actor = requireAdmin(session);
    return this.write(actor, input.id, 'AD_HOC_REFERENCE_REACTIVATED', (now) =>
      this.repo.setActive(input.id, true, now),
    );
  }

  /** One write transaction: existence check, change, audit (ids only). */
  private write(
    actor: Session,
    id: string,
    action: string,
    change: (now: string) => void,
  ): AdHocReferenceDto {
    const { db, clock } = this.deps;
    return withWriteTransaction(db, () => {
      if (!this.repo.find(id)) {
        throw new DomainError(
          'AD_HOC_REFERENCE_NOT_FOUND',
          'Reference not found',
        );
      }
      change(clock.now());
      appendAudit(db, clock, {
        cashierId: actor.cashierId,
        action,
        entityType: 'adHocReference',
        entityId: id,
        metadata: {},
      });
      return this.repo.find(id)!;
    });
  }
}
