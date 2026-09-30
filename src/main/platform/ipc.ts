import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { isTrustedAppUrl } from './trust';
import { getTrustedAppLocation } from './window';

/**
 * Application services handed to IPC handlers. Feature tasks add their
 * services here; the shell itself needs none yet.
 */
// oxlint-disable-next-line typescript/no-empty-object-type
export interface ApplicationServices {}

/** Throws unless the invoking frame is the app's own top-level document. */
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  const trusted =
    frame !== null &&
    frame === event.sender.mainFrame &&
    isTrustedAppUrl(frame.url, getTrustedAppLocation());
  if (!trusted) {
    throw new Error('Rejected IPC from untrusted frame');
  }
}

/**
 * The only way handlers are registered: every invocation is checked against
 * the sender frame before the handler runs.
 */
export function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: Args
  ) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...(args as Args));
  });
}

export function registerApplicationIpc(_services: ApplicationServices): void {
  // Baseline health check; proves the trusted-sender gate on a real channel.
  handleTrusted('bengkelin:app:ping', () => 'pong');
}
