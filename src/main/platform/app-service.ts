import { requireAdmin } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import { DomainError } from '@/shared/primitives';

export interface AppServiceDeps {
  /** Main-process-known log directory. The renderer never supplies a path. */
  logDir: string;
  /** Electron's `shell.openPath`: resolves to '' on success, else an error. */
  openPath: (target: string) => Promise<string>;
}

/** Help -> Open Log Folder (spec 48). ADMIN only. */
export class AppService {
  constructor(private readonly deps: AppServiceDeps) {}

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
