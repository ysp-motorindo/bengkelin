import type { AppDatabase } from '@/main/database/connection';
import type { StockLocationDto } from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';

export function requireActiveStockLocation(
  db: AppDatabase,
  id: string,
): StockLocationDto {
  const row = db
    .prepare(
      'SELECT id, code, label, is_active FROM stock_locations WHERE id = ?',
    )
    .get(id) as (StockLocationDto & { is_active: bigint }) | undefined;
  if (!row)
    throw new DomainError(
      'STOCK_LOCATION_NOT_FOUND',
      'Stock location not found. Choose an active location.',
    );
  if (row.is_active !== 1n)
    throw new DomainError(
      'STOCK_LOCATION_INACTIVE',
      'Stock location is inactive. Choose an active location.',
    );
  return { id: row.id, code: row.code, label: row.label };
}

export function resolveStockLocation(
  db: AppDatabase,
  id?: string,
): StockLocationDto {
  if (id !== undefined) return requireActiveStockLocation(db, id);
  const row = db
    .prepare(`SELECT id, code, label FROM stock_locations WHERE is_active = 1
    ORDER BY is_default DESC, label COLLATE NOCASE, code, id LIMIT 1`)
    .get() as StockLocationDto | undefined;
  if (!row)
    throw new DomainError(
      'STOCK_LOCATION_REQUIRED',
      'Set up an active stock location in Reference Data before continuing.',
    );
  return row;
}
