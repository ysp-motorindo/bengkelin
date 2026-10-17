import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

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
let previousDocumentOverflow: string | null = null;
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
  subtitle?: ReactNode;
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
  scrollBody?: boolean;
  contentPadding?: boolean;
  footer?: ReactNode;
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
  subtitle,
  onClose,
  children,
  role = 'dialog',
  initialFocus,
  returnFocus,
  closeLabel,
  allowNewTransaction = false,
  scrollBody = false,
  contentPadding = true,
  footer,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const subtitleId = useId();
  const returnRef = useRef(returnFocus);
  returnRef.current = returnFocus;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  function showScrollbar() {
    setIsScrolling(true);
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      setIsScrolling(false);
      scrollTimer.current = null;
    }, 700);
  }

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const root = panel.current;
    if (openDialogs.length === 0) {
      previousDocumentOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
    }
    const target =
      initialFocus?.current ?? (root ? focusables(root)[0] : undefined);
    (target ?? root)?.focus({ preventScroll: true });
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
      if (openDialogs.length === 0 && previousDocumentOverflow !== null) {
        document.documentElement.style.overflow = previousDocumentOverflow;
        previousDocumentOverflow = null;
      }
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
        aria-describedby={
          [subtitle ? subtitleId : null, description ? descriptionId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex w-full min-h-0 max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg outline-none max-h-[70vh]"
      >
        <div className="flex items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold leading-tight">
              {title}
            </h2>
            {subtitle ? (
              <div
                id={subtitleId}
                className="mt-1 text-sm text-muted-foreground"
              >
                {subtitle}
              </div>
            ) : null}
            {description ? (
              <div id={descriptionId} className="text-sm text-muted-foreground">
                {description}
              </div>
            ) : null}
          </div>
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
        <div
          onScrollCapture={showScrollbar}
          data-scrolling={isScrolling}
          className={`dialog-scroll-area relative min-h-0 flex-1 px-4 sm:px-5 ${
            scrollBody ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
          } ${contentPadding ? 'pt-1 pb-4 sm:pb-5' : ''}`}
        >
          {children}
        </div>
        {footer ? (
          <div className="flex w-full justify-start border-t border-border pt-3 p-4 sm:p-5 [&>*]:w-full">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
