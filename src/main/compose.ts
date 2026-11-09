import { PurchasePrintingService } from '@/main/features/purchases/printing';
import { PurchaseService } from '@/main/features/purchases/service';
import { SupplierService } from '@/main/features/suppliers/service';
import { PurchaseDraftService } from '@/main/features/purchases/drafts';
import { OpeningImportService } from '@/main/features/customer-receivables/import-service';
import { CustomerReceivablesService } from '@/main/features/customer-receivables/service';
import { ReferenceTransferService } from '@/main/features/reference-transfer/service';
import { CustomerTransferService } from '@/main/features/customer-transfer/service';
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
import {
  RestoreService,
  type RestoreHooks,
} from '@/main/features/backups/restore';
import type { RestoreFs } from '@/main/features/backups/restore-fs';
import { CatalogTransferService } from '@/main/features/catalog-transfer/service';
import { RestoreNoticeService } from '@/main/features/backups/restore-notice';
import path from 'node:path';
import { AppService } from '@/main/platform/app-service';
import { createLogger, type Logger } from '@/main/platform/logger';
import { MaintenanceGate } from '@/main/platform/maintenance';
import { MenuState } from '@/main/platform/menu-state';
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
  /** userData (restore staging and marker); default: `<logDir>/..`. */
  dataDir?: string;
  /** The live database file; default: the connection's file name. */
  databasePath?: string;
  restore?: RestoreCompositionDeps;
  /** Help > About (the app passes `app.getVersion()`). */
  appVersion?: string;
  systemNumberLocale?: string;
}

/** Restore wiring: the app passes relaunch/close hooks; tests add seams. */
export interface RestoreCompositionDeps {
  /** app.relaunch() + app.exit(0) in main; a stub in tests. */
  relaunch?: () => void;
  /** Stops background database users (the backup scheduler). */
  onDatabaseClosing?: () => void;
  hooks?: RestoreHooks;
  fs?: RestoreFs;
  tokenTtlMs?: number;
}

/** The one place services are constructed and wired (app and tests alike). */
export function createApplicationServices(
  deps: CompositionDeps,
): ApplicationServices {
  const { db, clock } = deps;
  const logger = deps.logger ?? createLogger({ dir: deps.logDir, clock });
  const sessions = new SessionStore();
  // The printable context belongs to a signed-in window: forget it when
  // the window's session ends.
  const menu = new MenuState();
  sessions.onChange((windowId) => {
    if (!sessions.get(windowId)) menu.clear(windowId);
  });
  const dataDir = deps.dataDir ?? path.dirname(deps.logDir);
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
    systemNumberLocale: deps.systemNumberLocale ?? 'id-ID',
  });
  // Restore's maintenance flag: the command table refuses writes while set.
  const maintenance = new MaintenanceGate();
  const backups = new BackupService({
    db,
    clock,
    logger,
    dialogs,
    defaultDir:
      deps.backupsDir ?? path.join(path.dirname(deps.logDir), 'backups'),
    isPaused: () => maintenance.active,
  });
  const restoreDeps = deps.restore ?? {};
  const restore = new RestoreService({
    db,
    clock,
    logger,
    dialogs,
    backups,
    maintenance,
    dataDir,
    databasePath: deps.databasePath ?? db.name,
    relaunch:
      restoreDeps.relaunch ??
      (() => logger.warn('restore.relaunch_unavailable', {})),
    ...(restoreDeps.onDatabaseClosing
      ? { onDatabaseClosing: restoreDeps.onDatabaseClosing }
      : {}),
    ...(restoreDeps.hooks ? { hooks: restoreDeps.hooks } : {}),
    ...(restoreDeps.fs ? { fs: restoreDeps.fs } : {}),
    ...(restoreDeps.tokenTtlMs ? { tokenTtlMs: restoreDeps.tokenTtlMs } : {}),
  });
  return {
    purchasePrinting: new PurchasePrintingService({
      db,
      logger,
      clock,
      printing,
      driver: deps.printDriver ?? unavailablePrintDriver,
      dialogs,
      systemNumberLocale: deps.systemNumberLocale ?? 'id-ID',
    }),
    purchases: new PurchaseService({ db, clock }),
    suppliers: new SupplierService({ db, clock }),
    purchaseDrafts: new PurchaseDraftService({ db, clock, catalog }),
    logger,
    sessions,
    maintenance,
    auth: new AuthService({ db, clock, sessions }),
    settings: new SettingsService({
      db,
      clock,
      systemNumberLocale: deps.systemNumberLocale ?? 'id-ID',
    }),
    cashiers: new CashierService({ db, clock, sessions }),
    references: new ReferenceService({ db, clock }),
    customers: new CustomerService({ db, clock }),
    referenceTransfer: new ReferenceTransferService({
      db,
      clock,
      dialogs,
      backups,
      logger,
      sessions,
    }),
    customerReceivables: new CustomerReceivablesService(
      { db, clock },
      new OpeningImportService({
        db,
        clock,
        dialogs,
        backups,
        logger,
        sessions,
      }),
    ),
    customerTransfer: new CustomerTransferService({
      db,
      clock,
      dialogs,
      backups,
      logger,
      sessions,
    }),
    catalog,
    vehicles: new VehicleService({ db, clock }),
    inventory,
    drafts: new DraftService({ db, clock, catalog }),
    adHocReferences: new AdHocReferenceService({ db, clock }),
    // Production composition never passes the test-only `onStep` hook.
    invoices: new InvoiceService({ db, clock }),
    printing,
    reports: new ReportService({
      db,
      clock,
      printing,
      dialogs,
      logger,
      systemNumberLocale: deps.systemNumberLocale ?? 'id-ID',
    }),
    logo: new LogoService({ db, clock, dialogs, assetsDir, logger }),
    backups,
    restore,
    catalogTransfer: new CatalogTransferService({
      db,
      clock,
      dialogs,
      backups,
      trackingChangeGuard: inventory.trackingChangeGuard,
      logger,
    }),
    restoreNotice: new RestoreNoticeService({ dataDir, logger }),
    app: new AppService({
      logDir: deps.logDir,
      openPath: deps.openPath,
      db,
      appVersion: deps.appVersion ?? '0.0.0',
    }),
    menu,
  };
}
