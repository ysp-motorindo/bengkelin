import { useTranslation } from 'react-i18next';
import { BackupSection } from '@/renderer/features/backups/BackupSection';
import { RestoreSection } from '@/renderer/features/backups/RestoreSection';
import type { PublicSettings } from '@/shared/contracts';
import { PrintSettingsSection } from './PrintSettingsSection';
import { ShopLogoSection } from './ShopLogoSection';
import { ShopSettingsSection } from './ShopSettingsSection';

/**
 * ADMIN settings (spec 31, 32, 42, 43): shop identity and timezone, the
 * logo, print settings, backups and restore.
 */
export function SettingsScreen({
  onShopSaved,
}: {
  onShopSaved?: ((settings: PublicSettings) => void) | undefined;
} = {}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold leading-tight tracking-tight">
        {t('shell.nav.settings')}
      </h1>
      <ShopSettingsSection onSaved={onShopSaved} />
      <ShopLogoSection />
      <PrintSettingsSection />
      <BackupSection />
      <RestoreSection />
    </div>
  );
}
