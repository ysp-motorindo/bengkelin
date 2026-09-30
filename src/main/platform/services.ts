import type { CashierService } from '@/main/features/auth/cashier-service';
import type { AuthService } from '@/main/features/auth/service';
import type { SessionStore } from '@/main/features/auth/sessions';
import type { SettingsService } from '@/main/features/settings/service';
import type { AppService } from './app-service';
import type { Logger } from './logger';

/**
 * Application services handed to the command table. Feature tasks add their
 * service here and wire it in `compose.ts`. Electron-free, so integration
 * tests build the same graph the app runs.
 */
export interface ApplicationServices {
  logger: Logger;
  sessions: SessionStore;
  auth: AuthService;
  settings: SettingsService;
  cashiers: CashierService;
  app: AppService;
}
