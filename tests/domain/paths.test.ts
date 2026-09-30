import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { applyDataDirOverride } from '@/main/platform/paths';

const fakeApp = (isPackaged: boolean) => ({
  isPackaged,
  setPath: vi.fn(),
});

describe('applyDataDirOverride', () => {
  test('redirects userData when unpackaged', () => {
    const app = fakeApp(false);
    applyDataDirOverride(app, { BENGKELIN_DATA_DIR: '/tmp/x' });
    expect(app.setPath).toHaveBeenCalledWith(
      'userData',
      path.resolve('/tmp/x'),
    );
  });

  test('is ignored when packaged', () => {
    const app = fakeApp(true);
    applyDataDirOverride(app, { BENGKELIN_DATA_DIR: '/tmp/x' });
    expect(app.setPath).not.toHaveBeenCalled();
  });

  test('does nothing when the variable is unset', () => {
    const app = fakeApp(false);
    applyDataDirOverride(app, {});
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
