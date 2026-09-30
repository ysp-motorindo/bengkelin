import type { CashierService } from '@/main/features/auth/cashier-service';
import type { AuthService } from '@/main/features/auth/service';
import type { SessionStore } from '@/main/features/auth/sessions';
import type { CatalogService } from '@/main/features/catalog/service';
import type { InventoryService } from '@/main/features/inventory/service';
import type { DraftService } from '@/main/features/drafts/service';
import type { AdHocReferenceService } from '@/main/features/ad-hoc-references/service';
import type { InvoiceService } from '@/main/features/invoices/service';
import type { CustomerService } from '@/main/features/customers/service';
import type { ReferenceService } from '@/main/features/references/service';
import type { VehicleService } from '@/main/features/vehicles/service';
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
  references: ReferenceService;
  customers: CustomerService;
  catalog: CatalogService;
  vehicles: VehicleService;
  inventory: InventoryService;
  drafts: DraftService;
  adHocReferences: AdHocReferenceService;
  invoices: InvoiceService;
  app: AppService;
}
