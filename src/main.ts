import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { openDatabase, type AppDatabase } from './main/database/connection';
import { migrateDatabase } from './main/database/migrate';
import { createApplicationServices } from './main/compose';
import { registerApplicationIpc } from './main/platform/ipc';
import { createLogger, type Logger } from './main/platform/logger';
import type { ApplicationServices } from './main/platform/services';
import { toInstant } from './shared/time';
import { applyDataDirOverride } from './main/platform/paths';
import { createMainWindow } from './main/platform/window';
import { installCloseGuard } from './main/platform/close-guard';
import { createFileDialogs } from './main/platform/dialogs';
import { createElectronPrintDriver } from './main/features/printing/electron-driver';
import { BackupScheduler } from './main/features/backups/scheduler';
import { recoverInterruptedRestore } from './main/features/backups/restore-recovery';

// Must run before the single-instance lock and before anything reads userData.
applyDataDirOverride(app);

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let services: ApplicationServices | null = null;
let backupScheduler: BackupScheduler | null = null;

const clock = { now: () => toInstant(new Date()) };
// Created lazily: userData may be redirected (test override) before this runs.
let logger: Logger | null = null;
function log(): Logger {
  logger ??= createLogger({ dir: logDirectory(), clock });
  return logger;
}
function logDirectory(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function databasePath(): string {
  return path.join(app.getPath('userData'), 'bengkelin.sqlite');
}

/**
 * Finishes or undoes an interrupted restore BEFORE the database is opened
 * (T16). When no complete database can be recovered, shows where the safety
 * backup and the moved-aside files are and quits: a fresh empty database
 * must never be created over them.
 */
function recoverRestore(): boolean {
  const recovery = recoverInterruptedRestore({
    dataDir: app.getPath('userData'),
    databasePath: databasePath(),
    logger: log(),
  });
  if (recovery.outcome !== 'FATAL') {
    if (recovery.outcome !== 'NO_MARKER') {
      log().info('startup.restore_recovery', { outcome: recovery.outcome });
    }
    return true;
  }
  const lines = [
    'Pemulihan database tidak dapat diselesaikan. Aplikasi ditutup tanpa mengubah file berikut.',
    'The database restore could not be completed. The application will close without touching these files.',
    '',
    `Cadangan pengaman / Safety backup: ${recovery.safetyBackup ?? '-'}`,
    ...(recovery.asideFiles.length > 0
      ? [
          'Database sebelumnya / Previous database:',
          ...recovery.asideFiles.map((file) => `  ${file}`),
        ]
      : []),
  ];
  dialog.showErrorBox('Bengkelin', lines.join('\n'));
  app.quit();
  return false;
}

/**
 * The app restarts after a restore. In UNPACKAGED builds only, e2e tests
 * set BENGKELIN_TEST_RESTORE_EXIT=1 to exit instead (Playwright cannot
 * follow a relaunched process); the harness launches the app again.
 */
function relaunchAfterRestore(): void {
  // Let the renderer receive the result ("restarting...") first.
  setTimeout(() => {
    if (app.isPackaged || !process.env.BENGKELIN_TEST_RESTORE_EXIT) {
      app.relaunch();
    }
    app.exit(0);
  }, 300);
}

/** Opens and migrates the database; on failure shows a native error and quits. */
function startDatabase(): boolean {
  if (!recoverRestore()) return false;
  try {
    database = openDatabase(databasePath());
    migrateDatabase(database);
    log().info('startup', { version: app.getVersion() });
    return true;
  } catch (error) {
    log().error('startup.database_failed', { error });
    database?.close();
    database = null;
    dialog.showErrorBox(
      'Bengkelin',
      `Database tidak dapat dibuka / The database could not be opened.\n\n${(error as Error).message}`,
    );
    app.quit();
    return false;
  }
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow = createMainWindow();
  // Normal exit waits (briefly) for the renderer to flush draft input.
  installCloseGuard(mainWindow);

  // Sessions are bound to the window: end them when it closes or crashes.
  const { webContents } = mainWindow;
  const windowId = webContents.id;
  const endSession = () => services?.sessions.endWindow(windowId);
  webContents.once('render-process-gone', endSession);
  mainWindow.once('closed', endSession);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  void app.whenReady().then(() => {
    if (!startDatabase()) return;
    if (!database) return;
    services = createApplicationServices({
      db: database,
      clock,
      logDir: logDirectory(),
      logger: log(),
      openPath: (target) => shell.openPath(target),
      printDriver: createElectronPrintDriver(),
      dialogs: createFileDialogs(app),
      assetsDir: path.join(app.getPath('userData'), 'assets'),
      backupsDir: path.join(app.getPath('userData'), 'backups'),
      dataDir: app.getPath('userData'),
      databasePath: databasePath(),
      restore: {
        relaunch: relaunchAfterRestore,
        // The restore closes the connection itself: stop its other users.
        onDatabaseClosing: () => {
          backupScheduler?.stop();
          database = null;
        },
      },
    });
    registerApplicationIpc(services);
    showMainWindow();
    // Daily automatic backup: a catch-up check on the next tick (never
    // delaying the window), then every 15 minutes while the app is open.
    backupScheduler = new BackupScheduler({ backups: services.backups });
    backupScheduler.start();

    // macOS: re-create the window when the dock icon is clicked.
    app.on('activate', showMainWindow);
  });

  // A quit (menu, Cmd+Q, test harness) first closes the window, which the
  // close guard holds for the flush; finish the quit once it has closed.
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('browser-window-created', (_event, window) => {
    window.once('closed', () => {
      if (quitting && BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  });

  app.on('will-quit', () => {
    backupScheduler?.stop();
    database?.close();
    database = null;
  });

  // Quit when all windows are closed, except on macOS.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
