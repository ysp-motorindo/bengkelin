import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { canonicalJson } from '@/main/database/idempotency';
import {
  toSupplierDto,
  type SupplierRow,
} from '@/main/features/suppliers/service';
export class SupplierTransferRepository {
  constructor(readonly db: AppDatabase) {}
  all() {
    return (
      this.db
        .prepare('SELECT * FROM suppliers ORDER BY id')
        .all() as SupplierRow[]
    ).map(toSupplierDto);
  }
  fingerprint() {
    return createHash('sha256')
      .update(
        canonicalJson([
          this.db.prepare('SELECT * FROM suppliers ORDER BY id').all(),
          this.db
            .prepare(
              'SELECT * FROM supplier_opening_balances ORDER BY supplier_id',
            )
            .all(),
        ])!,
      )
      .digest('hex');
  }
}
