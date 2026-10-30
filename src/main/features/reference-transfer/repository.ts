import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { canonicalJson } from '@/main/database/idempotency';
import { ReferenceRepository } from '@/main/features/references/repository';
import type { ReferenceImportEntity } from '@/shared/contracts';
export class ReferenceTransferRepository {
  readonly references: ReferenceRepository;
  constructor(private readonly db: AppDatabase) {
    this.references = new ReferenceRepository(db);
  }
  all(entity: ReferenceImportEntity) {
    return this.references.list(entity, { activeOnly: false });
  }
  fingerprint(entity: ReferenceImportEntity): string {
    return createHash('sha256')
      .update(canonicalJson(this.all(entity))!)
      .digest('hex');
  }
}
