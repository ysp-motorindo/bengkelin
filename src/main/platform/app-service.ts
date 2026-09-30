import type { AppDatabase } from '@/main/database/connection';
import { readSchemaVersion } from '@/main/database/identity';
import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { AboutDto } from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';

export interface AppServiceDeps {
  /** Main-process-known log directory. The renderer never supplies a path. */
  logDir: string;
  /** Electron's `shell.openPath`: resolves to '' on success, else an error. */
  openPath: (target: string) => Promise<string>;
  /** For Help > About. */
  db: AppDatabase;
  appVersion: string;
}

/** Help menu: About (anyone) and Open Log Folder (spec 48, ADMIN only). */
export class AppService {
  constructor(private readonly deps: AppServiceDeps) {}

  /** Versions only: safe before login. */
  about(): AboutDto {
    return {
      appVersion: this.deps.appVersion,
      schemaVersion: readSchemaVersion(this.deps.db),
    };
  }

  async openLogFolder(session: Session | undefined): Promise<void> {
    requireAdmin(session);
    const failure = await this.deps.openPath(this.deps.logDir);
    if (failure) {
      throw new DomainError(
        'LOG_FOLDER_UNAVAILABLE',
        'Log folder could not be opened',
      );
    }
  }
}
