import { BackupSection } from '@/renderer/features/backups/BackupSection';
import { RestoreSection } from '@/renderer/features/backups/RestoreSection';
import { PrintSettingsSection } from './PrintSettingsSection';
import { ShopLogoSection } from './ShopLogoSection';

/**
 * ADMIN settings (spec 31, 32, 42, 43): the shop logo, print settings,
 * backups and restore. Shop identity editing and the other admin screens
 * arrive with T17.
 */
export function SettingsScreen() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <ShopLogoSection />
      <PrintSettingsSection />
      <BackupSection />
      <RestoreSection />
    </div>
  );
}
