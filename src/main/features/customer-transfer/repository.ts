import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/main/database/connection';
import { canonicalJson } from '@/main/database/idempotency';
import { CustomerRepository } from '@/main/features/customers/repository';
export class CustomerTransferRepository {
  readonly customers: CustomerRepository;
  constructor(private readonly db: AppDatabase) {
    this.customers = new CustomerRepository(db);
  }
  all() {
    return this.customers.all();
  }
  fingerprint(): string {
    return createHash('sha256')
      .update(
        canonicalJson(
          this.db.prepare('SELECT * FROM customers ORDER BY id').all(),
        )!,
      )
      .digest('hex');
  }
}
