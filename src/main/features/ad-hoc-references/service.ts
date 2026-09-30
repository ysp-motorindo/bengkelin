import type { AppDatabase } from '@/main/database/connection';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type {
  SearchAdHocReferencesInput,
  SearchAdHocReferencesResult,
} from '@/shared/contracts';
import { AdHocReferenceRepository } from './repository';

const DEFAULT_LIMIT = 25;

/**
 * Reusable free-form line references (spec 12). They are created and reused
 * by `drafts.apply({ kind: 'addCustomLine' })`; this service only offers the
 * autocomplete, for any signed-in cashier.
 */
export class AdHocReferenceService {
  private readonly repo: AdHocReferenceRepository;

  constructor(deps: { db: AppDatabase }) {
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
}
