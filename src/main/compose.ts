import type { AppDatabase } from '@/main/database/connection';
import { CashierService } from '@/main/features/auth/cashier-service';
import { AuthService } from '@/main/features/auth/service';
import { SessionStore } from '@/main/features/auth/sessions';
import { CatalogService } from '@/main/features/catalog/service';
import { InventoryService } from '@/main/features/inventory/service';
import { DraftService } from '@/main/features/drafts/service';
import { AdHocReferenceService } from '@/main/features/ad-hoc-references/service';
import { InvoiceService } from '@/main/features/invoices/service';
import { CustomerService } from '@/main/features/customers/service';
import { ReferenceService } from '@/main/features/references/service';
import { VehicleService } from '@/main/features/vehicles/service';
import { SettingsService } from '@/main/features/settings/service';
import { LogoService } from '@/main/features/settings/logo-service';
import {
  noFileDialogs,
  unavailablePrintDriver,
  type FileDialogs,
  type PrintDriver,
} from '@/main/features/printing/driver';
import { PrintingService } from '@/main/features/printing/service';
import { ReportService } from '@/main/features/reports/service';
import { BackupService } from '@/main/features/backups/service';
import { CatalogTransferService } from '@/main/features/catalog-transfer/service';
import path from 'node:path';
import { AppService } from '@/main/platform/app-service';
import { createLogger, type Logger } from '@/main/platform/logger';
import type { ApplicationServices } from '@/main/platform/services';
import type { Clock } from '@/shared/time';

export interface CompositionDeps {
  db: AppDatabase;
  clock: Clock;
  logDir: string;
  openPath: (target: string) => Promise<string>;
  logger?: Logger;
  /** Real Electron driver in the app; a fake in tests. */
  printDriver?: PrintDriver;
  /** Native open/save dialogs shown by main. */
  dialogs?: FileDialogs;
  /** Content-addressed assets (logo); default: `<logDir>/../assets`. */
  assetsDir?: string;
  /** Default backup folder; default: `<logDir>/../backups`. */
  backupsDir?: string;
}

/** The one place services are constructed and wired (app and tests alike). */
export function createApplicationServices(
  deps: CompositionDeps,
): ApplicationServices {
  const { db, clock } = deps;
  const logger = deps.logger ?? createLogger({ dir: deps.logDir, clock });
  const sessions = new SessionStore();
  const catalog = new CatalogService({ db, clock });
  const inventory = new InventoryService({ db, clock });
  // Once stock has moved, whether an item tracks inventory is locked.
  catalog.setTrackingChangeGuard(inventory.trackingChangeGuard);
  const dialogs = deps.dialogs ?? noFileDialogs;
  const assetsDir =
    deps.assetsDir ?? path.join(path.dirname(deps.logDir), 'assets');
  const printing = new PrintingService({
    db,
    clock,
    driver: deps.printDriver ?? unavailablePrintDriver,
    dialogs,
    assetsDir,
    logger,
  });
  const backups = new BackupService({
    db,
    clock,
    logger,
    dialogs,
    defaultDir:
      deps.backupsDir ?? path.join(path.dirname(deps.logDir), 'backups'),
  });
  return {
    logger,
    sessions,
    auth: new AuthService({ db, clock, sessions }),
    settings: new SettingsService({ db, clock }),
    cashiers: new CashierService({ db, clock, sessions }),
    references: new ReferenceService({ db, clock }),
    customers: new CustomerService({ db, clock }),
    catalog,
    vehicles: new VehicleService({ db, clock }),
    inventory,
    drafts: new DraftService({ db, clock, catalog }),
    adHocReferences: new AdHocReferenceService({ db }),
    // Production composition never passes the test-only `onStep` hook.
    invoices: new InvoiceService({ db, clock }),
    printing,
    reports: new ReportService({ db, clock, printing, dialogs, logger }),
    logo: new LogoService({ db, clock, dialogs, assetsDir, logger }),
    backups,
    catalogTransfer: new CatalogTransferService({
      db,
      clock,
      dialogs,
      backups,
      trackingChangeGuard: inventory.trackingChangeGuard,
      logger,
    }),
    app: new AppService({ logDir: deps.logDir, openPath: deps.openPath }),
  };
}
