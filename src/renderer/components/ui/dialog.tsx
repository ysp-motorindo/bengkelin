import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/renderer/lib/utils';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Open dialogs, innermost last (only the innermost reacts to keys). */
const openDialogs: HTMLElement[] = [];
/** Open dialogs that opted in to New Transaction (Ctrl+N). */
const allowingNewTransaction = new Set<HTMLElement>();

/** True while a modal dialog is open (menu shortcuts must not reach behind it). */
export function hasOpenDialog(): boolean {
  return openDialogs.length > 0;
}

/**
 * True while an open dialog does not allow New Transaction. Only a dialog
 * that opts in (the finalized-success view) lets Ctrl+N through.
 */
export function dialogBlocksNewTransaction(): boolean {
  return openDialogs.some((root) => !allowingNewTransaction.has(root));
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.closest('[hidden]') === null,
  );
}

interface DialogProps {
  title: string;
  description?: ReactNode;
  /** Escape, the close button, or the caller's Cancel. */
  onClose(): void;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
  /** Receives focus when the dialog opens (default: first focusable). */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Where focus goes when the dialog closes. Default: the element that had
   * focus when it opened.
   */
  returnFocus?: () => void;
  /** Accessible label of the corner close button (omit to hide it). */
  closeLabel?: string;
  className?: string;
  /** New Transaction (Ctrl+N) may leave this dialog (default: blocked). */
  allowNewTransaction?: boolean;
}

/**
 * Modal dialog: focus moves in on open, Tab/Shift+Tab are trapped inside,
 * Escape closes, and focus is restored on close. Nested dialogs stop their
 * key events so only the innermost one reacts.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  role = 'dialog',
  initialFocus,
  returnFocus,
  closeLabel,
  className,
  allowNewTransaction = false,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const returnRef = useRef(returnFocus);
  returnRef.current = returnFocus;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const root = panel.current;
    const target =
      initialFocus?.current ?? (root ? focusables(root)[0] : undefined);
    (target ?? root)?.focus();
    if (root) openDialogs.push(root);

    // Focus can be lost to <body> when the focused control is removed (for
    // example a list row that was just deleted). Keys then no longer reach
    // the panel, so the innermost dialog picks them up at document level.
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!root || openDialogs[openDialogs.length - 1] !== root) return;
      const active = document.activeElement;
      if (active instanceof Node && root.contains(active)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        (focusables(root)[0] ?? root).focus();
      }
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown);
      const index = root ? openDialogs.lastIndexOf(root) : -1;
      if (index >= 0) openDialogs.splice(index, 1);
      // After React commits the removal, so the target is focusable again.
      const restore = returnRef.current;
      queueMicrotask(() => {
        if (restore) restore();
        else if (opener?.isConnected) opener.focus();
        else openDialogs[openDialogs.length - 1]?.focus();
      });
    };
    // Mount/unmount only: the dialog owns focus for its lifetime.
  }, []);

  // Follows the prop: one Dialog instance may switch views (the checkout
  // review, then the finalized-success view that opts in).
  useEffect(() => {
    const root = panel.current;
    if (!root || !allowNewTransaction) return undefined;
    allowingNewTransaction.add(root);
    return () => {
      allowingNewTransaction.delete(root);
    };
  }, [allowNewTransaction]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    event.stopPropagation();
    const items = focusables(panel.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    const inside = active instanceof Node && panel.current.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:items-center sm:p-6">
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'relative flex w-full max-w-lg flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg outline-none sm:p-5',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold leading-tight">
            {title}
          </h2>
          {closeLabel ? (
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="-m-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
        {description ? (
          <div id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
