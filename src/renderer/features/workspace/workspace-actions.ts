/**
 * Hooks for the native menu and shortcuts (T17). The mounted cashier
 * workspace registers its actions here; menu handlers call them. Nothing
 * here listens to keys: scanning happens only in the "Cari barang" field.
 */
export interface WorkspaceActions {
  /** File > New Transaction: flushes, then opens a fresh draft. */
  newTransaction(): Promise<void>;
  /** Transaction > Search Item: focuses the scanner/search field. */
  focusSearch(): void;
  /** Transaction > Add Custom Item. */
  addCustomItem(): void;
  /** Transaction > Save Draft: flushes pending input; true when acknowledged. */
  saveDraft(): Promise<boolean>;
  /** Transaction > Finalize (F8): flushes, then opens the checkout review. */
  openCheckoutReview(): Promise<void>;
}

let current: WorkspaceActions | null = null;

export function registerWorkspaceActions(
  actions: WorkspaceActions,
): () => void {
  current = actions;
  return () => {
    if (current === actions) current = null;
  };
}

/** The mounted workspace's actions, or null when it is not on screen. */
export function getWorkspaceActions(): WorkspaceActions | null {
  return current;
}
