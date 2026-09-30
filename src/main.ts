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

// Must run before the single-instance lock and before anything reads userData.
applyDataDirOverride(app);

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let services: ApplicationServices | null = null;

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

/** Opens and migrates the database; on failure shows a native error and quits. */
function startDatabase(): boolean {
  try {
    database = openDatabase(
      path.join(app.getPath('userData'), 'bengkelin.sqlite'),
    );
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
    });
    registerApplicationIpc(services);
    showMainWindow();

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
