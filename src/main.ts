import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import { registerApplicationIpc } from './main/platform/ipc';
import { applyDataDirOverride } from './main/platform/paths';
import { createMainWindow } from './main/platform/window';

// Must run before the single-instance lock and before anything reads userData.
applyDataDirOverride(app);

let mainWindow: BrowserWindow | null = null;

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
    registerApplicationIpc({});
    showMainWindow();

    // macOS: re-create the window when the dock icon is clicked.
    app.on('activate', showMainWindow);
  });

  // Quit when all windows are closed, except on macOS.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
