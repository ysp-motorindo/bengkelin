import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { openDatabase, type AppDatabase } from './main/database/connection';
import { migrateDatabase } from './main/database/migrate';
import { registerApplicationIpc } from './main/platform/ipc';
import { applyDataDirOverride } from './main/platform/paths';
import { createMainWindow } from './main/platform/window';

// Must run before the single-instance lock and before anything reads userData.
applyDataDirOverride(app);

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;

/** Opens and migrates the database; on failure shows a native error and quits. */
function startDatabase(): boolean {
  try {
    database = openDatabase(
      path.join(app.getPath('userData'), 'bengkelin.sqlite'),
    );
    migrateDatabase(database);
    return true;
  } catch (error) {
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
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  void app.whenReady().then(() => {
    if (!startDatabase()) return;
    registerApplicationIpc({});
    showMainWindow();

    // macOS: re-create the window when the dock icon is clicked.
    app.on('activate', showMainWindow);
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
