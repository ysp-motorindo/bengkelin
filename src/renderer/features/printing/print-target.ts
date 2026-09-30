/**
 * The current printable context for File > Print (CmdOrCtrl+P): the print
 * actions of a committed invoice that are on screen (the finalized-success
 * view or an invoice detail). The most recently mounted one wins; main is
 * told whether any exists so the menu item is enabled only then.
 */
type PrintTarget = () => Promise<void>;

const targets: PrintTarget[] = [];

/**
 * Tells main whether anything is printable. Also called when the shell
 * mounts: after a reload main may still remember the previous page's
 * context for this (still signed-in) window.
 */
export function reportPrintContext(): void {
  const printable = targets.length > 0;
  const bridge = window.bengkelin?.app;
  if (typeof bridge?.setMenuContext !== 'function') return;
  bridge.setMenuContext({ printable }).then(
    () => undefined,
    () => undefined,
  );
}

export function registerPrintTarget(target: PrintTarget): () => void {
  targets.push(target);
  reportPrintContext();
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
    reportPrintContext();
  };
}

/** Prints with the current target; false when nothing is printable. */
export async function runPrintTarget(): Promise<boolean> {
  const target = targets.at(-1);
  if (!target) return false;
  await target();
  return true;
}
