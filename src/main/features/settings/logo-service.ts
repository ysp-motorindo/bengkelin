import { appendAudit } from '@/main/database/audit';
import {
  withWriteTransaction,
  type AppDatabase,
} from '@/main/database/connection';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { FileDialogs } from '@/main/features/printing/driver';
import type { Logger } from '@/main/platform/logger';
import type { LogoChoiceDto, LogoDto } from '@/shared/contracts';
import type { Clock } from '@/shared/time';
import { readLogoDataUrl, readLogoFile, storeLogo } from './logo';
import { SettingsRepository } from './repository';

export interface LogoServiceDeps {
  db: AppDatabase;
  clock: Clock;
  dialogs: FileDialogs;
  assetsDir: string;
  logger: Logger;
}

/**
 * ADMIN chooses the shop logo through a native open dialog shown by main;
 * the renderer never supplies a path. New finalizations snapshot the key.
 */
export class LogoService {
  private readonly repo: SettingsRepository;

  constructor(private readonly deps: LogoServiceDeps) {
    this.repo = new SettingsRepository(deps.db);
  }

  async chooseLogo(session: Session | undefined): Promise<LogoChoiceDto> {
    requireAdmin(session);
    const file = await this.deps.dialogs.chooseImage();
    if (file === null) return { outcome: 'CANCELLED', logo: null };
    const { bytes, type } = readLogoFile(file);
    const asset = storeLogo(this.deps.assetsDir, bytes, type);
    // The dialog awaited: re-check the role before writing.
    const actor = requireAdmin(session);
    withWriteTransaction(this.deps.db, () => {
      this.repo.setLogoAsset(asset);
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'SHOP_LOGO_UPDATED',
        entityType: 'settings',
        entityId: '1',
        metadata: { asset, bytes: bytes.length },
      });
    });
    return { outcome: 'UPDATED', logo: this.toDto(asset) };
  }

  removeLogo(session: Session | undefined): void {
    const actor = requireAdmin(session);
    withWriteTransaction(this.deps.db, () => {
      this.repo.setLogoAsset(null);
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'SHOP_LOGO_REMOVED',
        entityType: 'settings',
        entityId: '1',
      });
    });
  }

  getLogo(session: Session | undefined): LogoDto | null {
    requireAdmin(session);
    const asset = this.repo.logoAsset();
    return asset === null ? null : this.toDto(asset);
  }

  private toDto(asset: string): LogoDto | null {
    const dataUrl = readLogoDataUrl(this.deps.assetsDir, asset);
    if (dataUrl === null) {
      this.deps.logger.warn('settings.logo_missing', { asset });
      return null;
    }
    return { asset, dataUrl };
  }
}
