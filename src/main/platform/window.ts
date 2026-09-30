import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';
import { isTrustedAppUrl, type TrustedAppLocation } from './trust';

const isDevelopment = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);

const rendererIndexPath = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
);

export function getTrustedAppLocation(): TrustedAppLocation {
  return isDevelopment
    ? { devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL }
    : { indexFileUrl: pathToFileURL(rendererIndexPath).href };
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // DevTools exist only in development builds.
      devTools: isDevelopment,
    },
  });

  const { webContents } = window;
  const location = getTrustedAppLocation();

  // No popups or extra windows, ever.
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Only the application document may load, in the window or any frame.
  const blockUntrustedNavigation = (event: {
    url: string;
    preventDefault(): void;
  }) => {
    if (!isTrustedAppUrl(event.url, location)) {
      event.preventDefault();
    }
  };
  webContents.on('will-navigate', blockUntrustedNavigation);
  webContents.on('will-frame-navigate', blockUntrustedNavigation);
  webContents.on('will-redirect', blockUntrustedNavigation);
  webContents.on('will-attach-webview', (event) => event.preventDefault());

  // The app needs no browser permissions (camera, geolocation, etc.).
  webContents.session.setPermissionRequestHandler((_wc, _permission, done) =>
    done(false),
  );
  webContents.session.setPermissionCheckHandler(() => false);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(rendererIndexPath);
  }

  return window;
}
