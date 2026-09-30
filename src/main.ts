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
import { disableRemoteDebugging } from './main/platform/debugging';
import { createMainWindow } from './main/platform/window';
import { installCloseGuard } from './main/platform/close-guard';
import { createFileDialogs } from './main/platform/dialogs';
import { createElectronPrintDriver } from './main/features/printing/electron-driver';
import { BackupScheduler } from './main/features/backups/scheduler';
import { recoverInterruptedRestore } from './main/features/backups/restore-recovery';
import { recordRestoreNotice } from './main/features/backups/restore-notice';
import {
  routePrintsToPdf,
  testPrintToPdfDir,
} from './main/features/printing/test-print-route';
import { installCrashLogging } from './main/platform/crash-logging';
import {
  createStartupFailureHandler,
  shouldLogLoadFailure,
} from './main/platform/startup-errors';
import {
  installApplicationMenu,
  MENU_REFRESH_CHANNELS,
  type ApplicationMenu,
} from './main/platform/menu';

// Must run before the single-instance lock and before anything reads userData.
applyDataDirOverride(app);
// Packaged builds: no Chromium DevTools protocol endpoint (the fuses only
// cover Node's inspector). Before `ready`, when Chromium starts that server.
disableRemoteDebugging(app);

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let services: ApplicationServices | null = null;
let backupScheduler: BackupScheduler | null = null;
let applicationMenu: ApplicationMenu | null = null;

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
      // Shown once to the next ADMIN who signs in (T17 ruling).
      recordRestoreNotice({
        dataDir: app.getPath('userData'),
        recovery,
        at: clock.now(),
        logger: log(),
      });
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
    const migration = migrateDatabase(database);
    log().info('startup', { version: app.getVersion() });
    // Spec 48: migration outcomes.
    log().info('startup.migrations', { ...migration });
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

/**
 * The real print driver. Unpackaged test runs may route paper prints to
 * PDF files (BENGKELIN_TEST_PRINT_TO_PDF_DIR, T17 ruling, like R3).
 */
function printDriver() {
  const driver = createElectronPrintDriver();
  const testDir = testPrintToPdfDir(app);
  return testDir ? routePrintsToPdf(driver, testDir) : driver;
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
  if (services) {
    applicationMenu?.dispose();
    applicationMenu = installApplicationMenu({
      window: mainWindow,
      services,
      appName: 'Bengkelin',
    });
  }

  // Sessions are bound to the window: end them when it closes or crashes.
  const { webContents } = mainWindow;
  const windowId = webContents.id;
  // Spec 48: whether the app document loaded (the packaged smoke test and
  // support read this; no URL or path is logged).
  webContents.once('did-finish-load', () => log().info('window.loaded'));
  webContents.on('did-fail-load', (_event, code, description, _url, main) => {
    // ERR_ABORTED (-3) is a superseded navigation, not a failure.
    if (shouldLogLoadFailure(code, main)) {
      log().error('window.load_failed', { code, description });
    }
  });
  const endSession = () => services?.sessions.endWindow(windowId);
  mainWindow.once('closed', () => {
    applicationMenu?.dispose();
    applicationMenu = null;
  });
  webContents.once('render-process-gone', endSession);
  mainWindow.once('closed', endSession);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  // Offline app (spec A.5: no runtime network dependencies): Chromium's
  // session spellchecker downloads a dictionary for the OS locale from
  // Google (redirector.gvt1.com) as soon as a renderer starts, even with
  // `spellcheck: false` on the window. No dictionary languages and the
  // checker off, for every session (default, print partition), prevents it.
  app.on('session-created', (session) => {
    session.setSpellCheckerLanguages([]);
    session.setSpellCheckerEnabled(false);
  });

  // Spec 46/48: unexpected failures outside commands are logged (sanitized);
  // an uncaught exception is also explained once to the user.
  let explained = false;
  installCrashLogging({
    process,
    app,
    logger: log(),
    onUncaughtException: () => {
      if (explained) return;
      explained = true;
      dialog.showErrorBox(
        'Bengkelin',
        [
          'Terjadi kesalahan tak terduga. Transaksi yang sudah disimpan tetap aman; tutup dan buka kembali aplikasi bila ada yang tidak berfungsi.',
          'An unexpected error occurred. Saved transactions are safe; close and reopen the app if something stops working.',
        ].join('\n\n'),
      );
    },
  });

  void app
    .whenReady()
    .then(() => {
      if (!startDatabase()) return;
      if (!database) return;
      services = createApplicationServices({
        db: database,
        clock,
        logDir: logDirectory(),
        logger: log(),
        openPath: (target) => shell.openPath(target),
        printDriver: printDriver(),
        appVersion: app.getVersion(),
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
      registerApplicationIpc(services, (channel) => {
        if (MENU_REFRESH_CHANNELS.has(channel)) applicationMenu?.refresh();
      });
      showMainWindow();
      // Daily automatic backup: a catch-up check on the next tick (never
      // delaying the window), then every 15 minutes while the app is open.
      backupScheduler = new BackupScheduler({ backups: services.backups });
      backupScheduler.start();

      // macOS: re-create the window when the dock icon is clicked.
      app.on('activate', showMainWindow);
    })
    .catch(
      // A throw here would leave a windowless process holding the
      // single-instance lock: log (sanitized), explain, exit.
      createStartupFailureHandler({
        logger: log,
        showErrorBox: (title, content) => dialog.showErrorBox(title, content),
        exit: (code) => app.exit(code),
      }),
    );

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
