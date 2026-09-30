import type { AppDatabase } from '@/main/database/connection';
import { CashierService } from '@/main/features/auth/cashier-service';
import { AuthService } from '@/main/features/auth/service';
import { SessionStore } from '@/main/features/auth/sessions';
import { CatalogService } from '@/main/features/catalog/service';
import { CustomerService } from '@/main/features/customers/service';
import { ReferenceService } from '@/main/features/references/service';
import { VehicleService } from '@/main/features/vehicles/service';
import { SettingsService } from '@/main/features/settings/service';
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
}

/** The one place services are constructed and wired (app and tests alike). */
export function createApplicationServices(
  deps: CompositionDeps,
): ApplicationServices {
  const { db, clock } = deps;
  const logger = deps.logger ?? createLogger({ dir: deps.logDir, clock });
  const sessions = new SessionStore();
  return {
    logger,
    sessions,
    auth: new AuthService({ db, clock, sessions }),
    settings: new SettingsService({ db, clock }),
    cashiers: new CashierService({ db, clock, sessions }),
    references: new ReferenceService({ db, clock }),
    customers: new CustomerService({ db, clock }),
    catalog: new CatalogService({ db, clock }),
    vehicles: new VehicleService({ db, clock }),
    app: new AppService({ logDir: deps.logDir, openPath: deps.openPath }),
  };
}
