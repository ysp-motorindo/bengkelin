import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Result } from '@/shared/primitives';
import { executeCommand, type Command } from './command';
import { buildCommands } from './commands';
import type { Logger } from './logger';
import type { ApplicationServices } from './services';
import { isTrustedAppUrl } from './trust';
import { getTrustedAppLocation } from './window';

export type { ApplicationServices } from './services';

type SenderEvent = Pick<IpcMainInvokeEvent, 'senderFrame' | 'sender'>;

/** True when the sending frame is the app's own top-level document. */
export function isTrustedSender(event: SenderEvent): boolean {
  const frame = event.senderFrame;
  return (
    frame !== null &&
    frame === event.sender.mainFrame &&
    isTrustedAppUrl(frame.url, getTrustedAppLocation())
  );
}

/** Throws unless the invoking frame is the app's own top-level document. */
export function assertTrustedSender(event: SenderEvent): void {
  if (!isTrustedSender(event)) {
    throw new Error('Rejected IPC from untrusted frame');
  }
}

/**
 * The only way handlers are registered. Every invocation is (1) checked
 * against the sender frame, then (2) validated against the command's Zod
 * schema, then (3) run with errors mapped to a `Result` (see executeCommand).
 * Untrusted senders get a rejected promise, not a Result: they get no
 * information about the API.
 */
export function handleTrusted(
  cmd: Command,
  logger: Logger,
  afterCommand?: AfterCommand,
): void {
  ipcMain.handle(
    cmd.channel,
    async (event, ...args): Promise<Result<unknown>> => {
      assertTrustedSender(event);
      const windowId = event.sender.id;
      const result = await executeCommand(cmd, { windowId }, args[0], logger);
      if (result.ok && afterCommand) {
        try {
          afterCommand(cmd.channel, windowId);
        } catch (error) {
          logger.warn('ipc.after_command_failed', {
            channel: cmd.channel,
            error,
          });
        }
      }
      return result;
    },
  );
}

/** Called after a command succeeded (e.g. the menu rebuilds on language change). */
export type AfterCommand = (channel: string, windowId: number) => void;

export function registerApplicationIpc(
  services: ApplicationServices,
  afterCommand?: AfterCommand,
): void {
  for (const cmd of buildCommands(services)) {
    handleTrusted(cmd, services.logger, afterCommand);
  }
}
