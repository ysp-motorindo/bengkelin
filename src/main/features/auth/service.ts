import type { AppDatabase } from '@/main/database/connection';
import { withWriteTransaction } from '@/main/database/connection';
import { appendAudit } from '@/main/database/audit';
import type { CashierSession, LoginInput } from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { verifyAgainstDummy, verifyPassword } from './passwords';
import { CashierRepository } from './repository';
import { toSessionDto, type Session, type SessionStore } from './sessions';

export interface AuthServiceDeps {
  db: AppDatabase;
  clock: Clock;
  sessions: SessionStore;
}

export class AuthService {
  private readonly cashiers: CashierRepository;

  constructor(private readonly deps: AuthServiceDeps) {
    this.cashiers = new CashierRepository(deps.db);
  }

  /**
   * Unknown user, wrong password and disabled cashier are indistinguishable:
   * same code, and an scrypt run in every branch so timing matches too.
   */
  async login(input: LoginInput, windowId: number): Promise<CashierSession> {
    const record = this.cashiers.findByUsername(input.username);
    let authenticated = false;
    if (record) {
      authenticated = await verifyPassword(input.password, record.passwordHash);
    } else {
      await verifyAgainstDummy(input.password);
    }

    if (!record || !authenticated || !record.isActive) {
      this.audit(null, 'LOGIN_FAILED', { username: input.username });
      throw new DomainError('INVALID_CREDENTIALS', 'Invalid credentials');
    }

    const session: Session = this.deps.sessions.start({
      windowId,
      cashierId: record.id,
      username: record.username,
      displayName: record.displayName,
      role: record.role,
      language: record.language,
      appearance: record.appearance,
    });
    this.audit(record.id, 'LOGIN_SUCCEEDED', {});
    return toSessionDto(session);
  }

  /** No-op without a session; otherwise ends it and audits. */
  logout(windowId: number): void {
    const ended = this.deps.sessions.endWindow(windowId);
    if (ended) this.audit(ended.cashierId, 'LOGOUT', {});
  }

  currentSession(session: Session | undefined): CashierSession | null {
    return session ? toSessionDto(session) : null;
  }

  private audit(
    cashierId: string | null,
    action: string,
    metadata: Record<string, unknown>,
  ): void {
    withWriteTransaction(this.deps.db, () =>
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId,
        action,
        entityType: cashierId ? 'cashier' : undefined,
        entityId: cashierId ?? undefined,
        metadata,
      }),
    );
  }
}
