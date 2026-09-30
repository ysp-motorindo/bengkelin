import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import type {
  CashierDto,
  CashierNameDto,
  CashierIdInput,
  ChangeRoleInput,
  CreateCashierInput,
  ResetPasswordInput,
  UpdateDisplayNameInput,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { requireAdmin, requireSession } from './authorize';
import { hashPassword } from './passwords';
import {
  CashierRepository,
  toCashierDto,
  type CashierRecord,
} from './repository';
import type { Session, SessionStore } from './sessions';

export interface CashierServiceDeps {
  db: AppDatabase;
  clock: Clock;
  sessions: SessionStore;
  newId?: () => string;
}

/** ADMIN-only cashier management (spec 55). Cashiers are never deleted. */
export class CashierService {
  private readonly repo: CashierRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: CashierServiceDeps) {
    this.repo = new CashierRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  list(session: Session | undefined): CashierDto[] {
    requireAdmin(session);
    return this.repo.list().map(toCashierDto);
  }

  /**
   * Names only, for filters in any session (T11 carry: a CASHIER can
   * filter history and the daily report by any cashier).
   */
  listNames(session: Session | undefined): CashierNameDto[] {
    requireSession(session);
    return this.repo.list().map((record) => ({
      id: record.id,
      displayName: record.displayName,
      isActive: record.isActive,
    }));
  }

  async create(
    session: Session | undefined,
    input: CreateCashierInput,
  ): Promise<CashierDto> {
    const actor = requireAdmin(session);
    // Hash outside the transaction: scrypt is async, transactions are sync.
    const passwordHash = await hashPassword(input.password);
    return this.write((now) => {
      if (this.repo.findByUsername(input.username)) {
        throw new DomainError('USERNAME_TAKEN', 'Username already exists');
      }
      const record: CashierRecord = {
        id: this.newId(),
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      this.repo.insert(record);
      this.audit(actor, 'CASHIER_CREATED', record.id, {
        username: record.username,
        role: record.role,
      });
      return toCashierDto(record);
    });
  }

  updateDisplayName(
    session: Session | undefined,
    input: UpdateDisplayNameInput,
  ): CashierDto {
    const actor = requireAdmin(session);
    return this.write((now) => {
      const target = this.mustFind(input.cashierId);
      this.repo.update(target.id, { displayName: input.displayName }, now);
      this.audit(actor, 'CASHIER_DISPLAY_NAME_CHANGED', target.id, {});
      return this.dto(target.id);
    });
  }

  changeRole(session: Session | undefined, input: ChangeRoleInput): CashierDto {
    const actor = requireAdmin(session);
    const dto = this.write((now) => {
      const target = this.mustFind(input.cashierId);
      if (
        target.role === 'ADMIN' &&
        target.isActive &&
        input.role !== 'ADMIN'
      ) {
        this.assertNotLastAdmin(target);
      }
      this.repo.update(target.id, { role: input.role }, now);
      this.audit(actor, 'CASHIER_ROLE_CHANGED', target.id, {
        from: target.role,
        to: input.role,
      });
      return this.dto(target.id);
    });
    // A role change takes effect on the next sign-in, not mid-session.
    this.deps.sessions.invalidateCashier(input.cashierId);
    return dto;
  }

  deactivate(session: Session | undefined, input: CashierIdInput): CashierDto {
    const actor = requireAdmin(session);
    const dto = this.write((now) => {
      const target = this.mustFind(input.cashierId);
      if (target.role === 'ADMIN' && target.isActive) {
        this.assertNotLastAdmin(target);
      }
      this.repo.update(target.id, { isActive: false }, now);
      this.audit(actor, 'CASHIER_DEACTIVATED', target.id, {});
      return this.dto(target.id);
    });
    this.deps.sessions.invalidateCashier(input.cashierId);
    return dto;
  }

  reactivate(session: Session | undefined, input: CashierIdInput): CashierDto {
    const actor = requireAdmin(session);
    return this.write((now) => {
      const target = this.mustFind(input.cashierId);
      this.repo.update(target.id, { isActive: true }, now);
      this.audit(actor, 'CASHIER_REACTIVATED', target.id, {});
      return this.dto(target.id);
    });
  }

  async resetPassword(
    session: Session | undefined,
    input: ResetPasswordInput,
  ): Promise<void> {
    const actor = requireAdmin(session);
    const passwordHash = await hashPassword(input.newPassword);
    this.write((now) => {
      const target = this.mustFind(input.cashierId);
      this.repo.update(target.id, { passwordHash }, now);
      this.audit(actor, 'CASHIER_PASSWORD_RESET', target.id, {});
    });
    this.deps.sessions.invalidateCashier(input.cashierId);
  }

  private write<T>(work: (now: string) => T): T {
    return withWriteTransaction(this.deps.db, () =>
      work(this.deps.clock.now()),
    );
  }

  private mustFind(id: string): CashierRecord {
    const record = this.repo.findById(id);
    if (!record)
      throw new DomainError('CASHIER_NOT_FOUND', 'Cashier not found');
    return record;
  }

  private dto(id: string): CashierDto {
    return toCashierDto(this.mustFind(id));
  }

  private assertNotLastAdmin(target: CashierRecord): void {
    if (this.repo.countOtherActiveAdmins(target.id) === 0) {
      throw new DomainError(
        'LAST_ACTIVE_ADMIN',
        'The last active administrator cannot be deactivated or demoted',
      );
    }
  }

  private audit(
    actor: Session,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): void {
    appendAudit(this.deps.db, this.deps.clock, {
      cashierId: actor.cashierId,
      action,
      entityType: 'cashier',
      entityId,
      metadata,
    });
  }
}
