import { PrintSettingsSection } from './PrintSettingsSection';
import { ShopLogoSection } from './ShopLogoSection';

/**
 * ADMIN settings (spec 31, 32): the shop logo and print settings. Shop
 * identity editing and the other admin screens arrive with T17.
 */
export function SettingsScreen() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <ShopLogoSection />
      <PrintSettingsSection />
    </div>
  );
}
