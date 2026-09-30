import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { CHANNELS } from '@/shared/channels';
import { isTrustedSender } from './ipc';

export const CLOSE_FLUSH_TIMEOUT_MS = 3000;

/**
 * Normal-exit flush handshake (T9 ruling). The first close of the window is
 * held: main sends `app.beforeClose`, the renderer flushes pending draft
 * input and answers `app.readyToClose`, then the window really closes. If the
 * renderer is gone, hung or never answers, the window closes after the
 * timeout anyway: committed state is already durable, only unsent debounced
 * text could be lost.
 */
export function installCloseGuard(
  window: BrowserWindow,
  timeoutMs: number = CLOSE_FLUSH_TIMEOUT_MS,
): void {
  const { webContents } = window;
  let approved = false;
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (approved) return;
    approved = true;
    if (timer) clearTimeout(timer);
    ipcMain.removeListener(CHANNELS.app.readyToClose, onReady);
    if (!window.isDestroyed()) window.close();
  };

  function onReady(event: IpcMainEvent) {
    if (event.sender !== webContents || !isTrustedSender(event)) return;
    if (waiting) release();
  }
  ipcMain.on(CHANNELS.app.readyToClose, onReady);

  window.on('close', (event) => {
    if (approved) return;
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    if (webContents.isDestroyed() || webContents.isCrashed()) {
      release();
      return;
    }
    timer = setTimeout(release, timeoutMs);
    webContents.send(CHANNELS.app.beforeClose);
  });
  window.once('closed', () => {
    if (timer) clearTimeout(timer);
    ipcMain.removeListener(CHANNELS.app.readyToClose, onReady);
  });
}
