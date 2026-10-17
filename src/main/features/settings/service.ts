import { randomUUID } from 'node:crypto';
import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin, requireSession } from '@/main/features/auth/authorize';
import { hashPassword } from '@/main/features/auth/passwords';
import { CashierRepository } from '@/main/features/auth/repository';
import type { Session } from '@/main/features/auth/sessions';
import type {
  PreferencesInput,
  PublicSettings,
  SetupData,
  ShopSettingsData,
  ShopSettingsDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { SettingsRepository, type SeedRow } from './repository';

/** Seed data for first-run setup (spec 9, 13, 56). `code` is the stable key. */
export const SEED_CHANNELS = [
  { code: 'BENGKEL', label: 'Bengkel' },
  { code: 'ONLINE', label: 'Online' },
  { code: 'MARKETPLACE', label: 'Marketplace' },
] as const;
export const SEED_UNITS = [
  { code: 'PCS', label: 'Pcs' },
  { code: 'BOTTLE', label: 'Bottle' },
  { code: 'SET', label: 'Set' },
  { code: 'PAIR', label: 'Pair' },
  { code: 'BOX', label: 'Box' },
  { code: 'SERVICE', label: 'Service' },
] as const;

export interface SettingsServiceDeps {
  db: AppDatabase;
  clock: Clock;
  newId?: () => string;
}

export class SettingsService {
  private readonly repo: SettingsRepository;
  private readonly cashiers: CashierRepository;
  private readonly newId: () => string;

  constructor(private readonly deps: SettingsServiceDeps) {
    this.repo = new SettingsRepository(deps.db);
    this.cashiers = new CashierRepository(deps.db);
    this.newId = deps.newId ?? randomUUID;
  }

  /** Public on purpose: the login screen needs language and theme. */
  getPublic(): PublicSettings {
    return this.repo.getPublic();
  }

  /** Shop identity and timezone for any signed-in cashier. */
  getShop(session: Session | undefined): ShopSettingsDto {
    requireSession(session);
    return this.repo.getShop();
  }

  /**
   * First-run setup, one write transaction: settings, first ADMIN, seeded
   * channels/units and the audit row commit together or not at all. Only
   * allowed while setup is incomplete. `input` is already schema-parsed.
   */
  async completeSetup(input: SetupData): Promise<PublicSettings> {
    if (this.repo.isSetupCompleted()) throw alreadyCompleted();
    const passwordHash = await hashPassword(input.admin.password);
    const { db, clock } = this.deps;

    withWriteTransaction(db, () => {
      // Re-check under the write lock: two racing calls cannot both pass.
      if (this.repo.isSetupCompleted()) throw alreadyCompleted();
      const now = clock.now();
      const adminId = this.newId();

      this.repo.writeSetup(input.shop, input.preferences, input.printer, now);
      this.cashiers.insert({
        id: adminId,
        username: input.admin.username,
        displayName: input.admin.displayName,
        passwordHash,
        role: 'ADMIN',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        language: input.preferences.language,
        appearance: input.preferences.appearance,
      });
      for (const channel of SEED_CHANNELS) {
        this.repo.insertChannel(this.seed(channel));
      }
      for (const unit of SEED_UNITS) {
        this.repo.insertUnit(this.seed(unit));
      }
      appendAudit(db, clock, {
        cashierId: adminId,
        action: 'SETUP_COMPLETED',
        entityType: 'settings',
        entityId: '1',
        metadata: {
          language: input.preferences.language,
          appearance: input.preferences.appearance,
          timezone: input.shop.timezone,
          printerConfigured: input.printer !== undefined,
        },
      });
    });
    return this.repo.getPublic();
  }

  updateShop(session: Session | undefined, input: ShopSettingsData): void {
    const actor = requireAdmin(session);
    withWriteTransaction(this.deps.db, () => {
      this.repo.updateShop(input);
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'SHOP_SETTINGS_UPDATED',
        entityType: 'settings',
        entityId: '1',
        metadata: { timezone: input.timezone },
      });
    });
  }

  updatePreferences(
    session: Session | undefined,
    input: PreferencesInput,
  ): PreferencesInput {
    const actor = requireSession(session);
    const changed: Record<string, unknown> = {};
    if (actor.language !== input.language)
      changed.language = { from: actor.language, to: input.language };
    if (actor.appearance !== input.appearance)
      changed.appearance = { from: actor.appearance, to: input.appearance };
    withWriteTransaction(this.deps.db, () => {
      this.cashiers.updatePreferences(
        actor.cashierId,
        input.language,
        input.appearance,
        this.deps.clock.now(),
      );
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'PREFERENCES_UPDATED',
        entityType: 'cashier',
        entityId: actor.cashierId,
        metadata: changed,
      });
    });
    actor.language = input.language;
    actor.appearance = input.appearance;
    return input;
  }

  private seed(row: { code: string; label: string }): SeedRow {
    return { id: this.newId(), code: row.code, label: row.label };
  }
}

function alreadyCompleted(): DomainError {
  return new DomainError(
    'SETUP_ALREADY_COMPLETED',
    'Setup was already completed',
  );
}
