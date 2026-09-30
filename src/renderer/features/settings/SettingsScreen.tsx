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
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <ShopSettingsSection onSaved={onShopSaved} />
      <ShopLogoSection />
      <PrintSettingsSection />
      <BackupSection />
      <RestoreSection />
    </div>
  );
}
