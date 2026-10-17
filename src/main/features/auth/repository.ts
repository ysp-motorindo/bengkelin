import type { AppDatabase } from '@/main/database/connection';
import { bool, flag, toNumber } from '@/main/database/rows';
import type {
  Appearance,
  NumberFormat,
  CashierDto,
  Language,
  Role,
} from '@/shared/contracts';
import type { Instant } from '@/shared/primitives';

interface CashierRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  is_active: bigint;
  created_at: string;
  updated_at: string;
  language?: string;
  appearance?: string;
  number_format?: string;
}

/** Internal record: includes the hash, never crosses IPC. */
export interface CashierRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
  language: Language;
  appearance: Appearance;
  numberFormat: NumberFormat;
}

function toRecord(row: CashierRow): CashierRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role as Role,
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    language: (row.language ?? 'id') as Language,
    appearance: (row.appearance ?? 'SYSTEM') as Appearance,
    numberFormat: (row.number_format ?? 'ID') as NumberFormat,
  };
}

export function toCashierDto(record: CashierRecord): CashierDto {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class CashierRepository {
  private readonly hasPreferences: boolean;
  private readonly hasNumberFormat: boolean;

  constructor(private readonly db: AppDatabase) {
    const columns = db.prepare('PRAGMA table_info(cashiers)').all() as {
      name: string;
    }[];
    this.hasPreferences = columns.some((column) => column.name === 'language');
    this.hasNumberFormat = columns.some(
      (column) => column.name === 'number_format',
    );
  }

  private columns(): string {
    return (
      'id, username, display_name, password_hash, role, is_active, created_at, updated_at' +
      (this.hasPreferences ? ', language, appearance' : '') +
      (this.hasNumberFormat ? ', number_format' : '')
    );
  }

  findById(id: string): CashierRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${this.columns()} FROM cashiers WHERE id = ?`)
      .get(id) as CashierRow | undefined;
    return row && toRecord(row);
  }

  /** Case-insensitive: the column is COLLATE NOCASE. */
  findByUsername(username: string): CashierRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${this.columns()} FROM cashiers WHERE username = ?`)
      .get(username) as CashierRow | undefined;
    return row && toRecord(row);
  }

  list(): CashierRecord[] {
    return (
      this.db
        .prepare(`SELECT ${this.columns()} FROM cashiers ORDER BY username`)
        .all() as CashierRow[]
    ).map(toRecord);
  }

  insert(record: CashierRecord): void {
    if (!this.hasPreferences) {
      this.db
        .prepare(
          'INSERT INTO cashiers (id, username, display_name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.id,
          record.username,
          record.displayName,
          record.passwordHash,
          record.role,
          flag(record.isActive),
          record.createdAt,
          record.updatedAt,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO cashiers (${this.columns()}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${this.hasNumberFormat ? ', ?' : ''})`,
      )
      .run(
        record.id,
        record.username,
        record.displayName,
        record.passwordHash,
        record.role,
        flag(record.isActive),
        record.createdAt,
        record.updatedAt,
        record.language,
        record.appearance,
        ...(this.hasNumberFormat ? [record.numberFormat] : []),
      );
  }

  update(
    id: string,
    changes: Partial<
      Pick<CashierRecord, 'displayName' | 'role' | 'isActive' | 'passwordHash'>
    >,
    updatedAt: Instant,
  ): void {
    const current = this.findById(id);
    if (!current) return;
    const next = { ...current, ...changes };
    this.db
      .prepare(
        `UPDATE cashiers SET display_name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.displayName,
        next.role,
        flag(next.isActive),
        next.passwordHash,
        updatedAt,
        id,
      );
  }

  updatePreferences(
    id: string,
    language: Language,
    appearance: Appearance,
    numberFormat: NumberFormat,
    updatedAt: Instant,
  ): void {
    this.db
      .prepare(
        'UPDATE cashiers SET language = ?, appearance = ?, number_format = ?, updated_at = ? WHERE id = ?',
      )
      .run(language, appearance, numberFormat, updatedAt, id);
  }

  /** Active ADMINs other than `excludingId` (for last-admin protection). */
  countOtherActiveAdmins(excludingId: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM cashiers WHERE role = 'ADMIN' AND is_active = 1 AND id <> ?`,
      )
      .get(excludingId) as { n: bigint };
    return toNumber(row.n);
  }
}
