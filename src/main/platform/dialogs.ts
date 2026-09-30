import path from 'node:path';
import { BrowserWindow, dialog, type App } from 'electron';
import type { FileDialogs } from '@/main/features/printing/driver';

/**
 * Native open/save dialogs, always shown by main (Part A: the renderer
 * never supplies a path). In UNPACKAGED builds only, like
 * BENGKELIN_DATA_DIR (R3), end-to-end tests may answer them through
 * environment variables instead of driving an OS dialog:
 *  - BENGKELIN_TEST_OPEN_IMAGE_PATH: the chosen logo file;
 *  - BENGKELIN_TEST_SAVE_PDF_PATH: the chosen PDF destination;
 *  - BENGKELIN_TEST_SAVE_CSV_PATH: the chosen CSV destination;
 *  - BENGKELIN_TEST_BACKUP_DIR: the chosen backup folder.
 * Packaged builds ignore them all.
 */
export function createFileDialogs(
  app: Pick<App, 'isPackaged' | 'getPath'>,
  env: NodeJS.ProcessEnv = process.env,
): FileDialogs {
  const testOverride = (key: string): string | undefined =>
    app.isPackaged ? undefined : env[key] || undefined;
  const parent = () => BrowserWindow.getFocusedWindow() ?? undefined;

  return {
    async chooseImage() {
      const override = testOverride('BENGKELIN_TEST_OPEN_IMAGE_PATH');
      if (override) return path.resolve(override);
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
      };
      const window = parent();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    async choosePdfDestination(defaultFileName: string) {
      const override = testOverride('BENGKELIN_TEST_SAVE_PDF_PATH');
      if (override) return path.resolve(override);
      return save(defaultFileName, { name: 'PDF', extensions: ['pdf'] });
    },

    async chooseCsvDestination(defaultFileName: string) {
      const override = testOverride('BENGKELIN_TEST_SAVE_CSV_PATH');
      if (override) return path.resolve(override);
      return save(defaultFileName, { name: 'CSV', extensions: ['csv'] });
    },

    async chooseBackupDirectory() {
      const override = testOverride('BENGKELIN_TEST_BACKUP_DIR');
      if (override) return path.resolve(override);
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
      };
      const window = parent();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  };

  async function save(
    defaultFileName: string,
    filter: Electron.FileFilter,
  ): Promise<string | null> {
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath('documents'), defaultFileName),
      filters: [filter],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    };
    const window = parent();
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  }
}
