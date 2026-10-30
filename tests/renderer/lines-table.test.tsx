import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LinesTable } from '@/renderer/features/workspace/LinesTable';
import { useDraftCommands } from '@/renderer/features/workspace/use-draft-commands';
import { draftView, workspaceBridge } from './helpers/workspace-bridge';
const key = 'bengkelin.transaction-column-widths.v1';
const minima = [32, 96, 192, 56, 64, 64, 112, 56, 56, 56, 56, 128, 80];
function Harness() {
  const commands = useDraftCommands(draftView().id, {
    initialView: draftView(),
  });
  return (
    <LinesTable
      lines={[]}
      commands={commands}
      mechanics={[]}
      onRemove={() => true}
    />
  );
}
function setup() {
  Object.assign(window, { bengkelin: workspaceBridge() });
  return render(<Harness />);
}
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
test('keyboard resizing changes one column, clamps and restores widths', () => {
  const view = setup();
  const handles = screen.getAllByRole('separator');
  expect(handles).toHaveLength(13);
  fireEvent.keyDown(handles[1]!, { key: 'ArrowRight' });
  const saved = JSON.parse(localStorage.getItem(key)!);
  expect(saved).toEqual(minima.map((n, i) => (i === 1 ? n + 8 : n)));
  fireEvent.keyDown(handles[1]!, { key: 'ArrowLeft' });
  fireEvent.keyDown(handles[1]!, { key: 'ArrowLeft' });
  expect(JSON.parse(localStorage.getItem(key)!)[1]).toBe(96);
  view.unmount();
  setup();
  expect(screen.getAllByRole('separator')[1]).toHaveAttribute(
    'aria-valuenow',
    '96',
  );
});
test.each(['bad', '[]', JSON.stringify(minima.map(() => -1))])(
  'invalid storage falls back: %s',
  (value) => {
    localStorage.setItem(key, value);
    setup();
    fireEvent.keyDown(screen.getAllByRole('separator')[1]!, {
      key: 'ArrowRight',
    });
    expect(JSON.parse(localStorage.getItem(key)!)[1]).toBe(104);
  },
);
test('storage failures do not prevent resizing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('unavailable');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('unavailable');
  });
  setup();
  fireEvent.keyDown(screen.getAllByRole('separator')[1]!, {
    key: 'ArrowRight',
  });
  expect(screen.getAllByRole('separator')[1]).toHaveAttribute(
    'aria-valuenow',
    '104',
  );
});

test('pointer resizing saves on release and cancellation restores prior widths', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  setup();
  const handle = screen.getAllByRole('separator')[1]!;
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
  fireEvent.pointerMove(handle, { clientX: 180 });
  expect(handle).toHaveAttribute('aria-valuenow', '176');
  expect(localStorage.getItem(key)).toBeNull();
  fireEvent.pointerCancel(handle);
  expect(handle).toHaveAttribute('aria-valuenow', '96');
  fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
  fireEvent.pointerMove(handle, { clientX: 180 });
  fireEvent.pointerUp(handle, { clientX: 180 });
  expect(JSON.parse(localStorage.getItem(key)!)[1]).toBe(176);
  fireEvent.lostPointerCapture(handle);
  expect(handle).toHaveAttribute('aria-valuenow', '176');
  vi.unstubAllGlobals();
});
