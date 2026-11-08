import { createPortal } from 'react-dom';
import { ScanBarcode } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { watchSessionError } from '@/renderer/lib/session-events';
import { cn } from '@/renderer/lib/utils';
import type { CatalogItemDto } from '@/shared/contracts';

export type ScanOutcome = 'added' | 'unknown' | 'other';

interface ScannerComboboxProps {
  onCustom(): void;
  compact?: boolean;
  disabled?: boolean;
  onTextChange?(text: string): void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Enter with free text: try it as a barcode. */
  onScan(code: string): Promise<ScanOutcome>;
  /** Enter/click on a search result. */
  onPick(item: CatalogItemDto): Promise<void>;
  /** Inline result of the last scan (unknown/inactive barcode...). */
  feedback: string | null;
  onClearFeedback(): void;
}

const SEARCH_DELAY_MS = 150;

/**
 * The "Cari barang" combobox: the ONLY place scanner input is handled (a
 * keyboard-wedge scanner types digits + Enter into the focused field; there
 * is no global key listener). Typing shows catalog search results; arrow keys
 * pick one; Enter with no highlighted result is treated as a barcode. The
 * field clears on Enter so back-to-back scans never run together.
 */
export function ScannerCombobox({
  onCustom,
  compact = false,
  disabled = false,
  onTextChange,
  inputRef,
  onScan,
  onPick,
  feedback,
  onClearFeedback,
}: ScannerComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const [results, setResults] = useState<CatalogItemDto[]>([]);
  const [open, setOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const queryRef = useRef('');
  const loadingPage = useRef(false);
  const [active, setActive] = useState(-1);
  const [hint, setHint] = useState<string | null>(null);
  const [popup, setPopup] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 288,
  });
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const height = Math.min(288, Math.max(below, above));
      const down = below >= Math.min(288, above);
      setPopup({
        left: Math.max(8, rect.left),
        top: down ? rect.bottom + 4 : rect.top - height - 4,
        width: Math.min(rect.width, window.innerWidth - 16),
        maxHeight: Math.max(80, height),
      });
    };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open, inputRef]);
  const searchSeq = useRef(0);
  // True only after arrow-key navigation since the last input change: Enter
  // then picks the highlighted result. Any new input (a scanner typing its
  // digits) clears it, so Enter after new input is always a scan/submit.
  const navigated = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  async function search(
    query: string,
    offset = 0,
  ): Promise<CatalogItemDto[] | null> {
    const seq = ++searchSeq.current;
    try {
      const result = await window.bengkelin.catalog.search({
        query,
        limit: 50,
        offset,
      });
      if (seq !== searchSeq.current) return null;
      if (!result.ok) {
        watchSessionError(result.error);
        return null;
      }
      return result.value.results;
    } catch {
      return null;
    }
  }

  function scheduleSearch(query: string) {
    clearTimeout(timer.current);
    searchSeq.current += 1;
    queryRef.current = query.trim();
    loadingPage.current = false;
    setResults([]);
    setHasMore(false);
    setPageError(false);
    if (!query.trim()) {
      searchSeq.current += 1;
      setResults([]);
      setOpen(true);
      setActive(-1);
      return;
    }
    timer.current = setTimeout(() => {
      void search(query.trim()).then((found) => {
        if (inputRef.current?.value !== query) return; // typed on / cleared
        if (!found) return;
        setResults(found);
        setHasMore(found.length === 50);
        setOpen(true);
        setActive(-1);
      });
    }, SEARCH_DELAY_MS);
  }

  async function loadMore() {
    if (!hasMore || loadingPage.current || !queryRef.current) return;
    loadingPage.current = true;
    setPageError(false);
    const query = queryRef.current;
    const request = search(query, results.length);
    const seq = searchSeq.current;
    const found = await request;
    if (seq !== searchSeq.current) return;
    loadingPage.current = false;
    if (!found) {
      setPageError(true);
      return;
    }
    setActive((current) =>
      current === results.length ? current + found.length : current,
    );
    setResults((current) => [...current, ...found]);
    setHasMore(found.length === 50);
  }

  function reset() {
    clearTimeout(timer.current);
    searchSeq.current += 1;
    queryRef.current = '';
    loadingPage.current = false;
    setHasMore(false);
    setPageError(false);
    setText('');
    onTextChange?.('');
    setResults([]);
    setOpen(false);
    setActive(-1);
    navigated.current = false;
  }

  async function submitText(code: string) {
    const outcome = await onScan(code);
    if (outcome !== 'unknown' || /^\d+$/.test(code)) return;
    // Not a barcode: offer the search results for keyboard selection.
    const found = await search(code);
    if (!found || found.length === 0 || inputRef.current?.value !== '') return;
    queryRef.current = code;
    setHasMore(found.length === 50);
    onClearFeedback();
    // The field stays empty so the next scan starts clean; the results
    // stay reachable with the arrow keys.
    setResults(found);
    setOpen(true);
    setActive(-1); // nothing is picked until the cashier uses the arrows
    navigated.current = false;
    setHint(t('workspace.search.chooseResult'));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (
        event.key === 'ArrowDown' &&
        active === results.length - 1 &&
        hasMore &&
        !pageError
      ) {
        void loadMore();
        return;
      }
      navigated.current = true;
      setActive((index) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (index < 0) return step > 0 ? 0 : results.length;
        const count = results.length + 1 + (pageError ? 1 : 0);
        return (index + step + count) % count;
      });
      return;
    }
    if (event.key === 'Escape') {
      if (open || text || feedback) {
        event.preventDefault();
        reset();
        onClearFeedback();
        setHint(null);
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (
      navigated.current &&
      open &&
      pageError &&
      active === results.length + 1
    ) {
      void loadMore();
      return;
    }
    const customPicked = navigated.current && open && active === results.length;
    const picked =
      navigated.current && open && active >= 0 ? results[active] : undefined;
    const code = text.trim();
    reset();
    setHint(null);
    if (customPicked) {
      onCustom();
    } else if (picked) {
      void onPick(picked);
    } else if (code) {
      void submitText(code);
    }
  }

  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;

  return (
    <div className="relative flex flex-col gap-1">
      <label
        htmlFor={`${listId}-input`}
        className={compact ? 'sr-only' : 'text-xs font-medium'}
      >
        {t('workspace.search.label')}
      </label>
      <div className="relative">
        <ScanBarcode
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          disabled={disabled}
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={hint || feedback ? hintId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('workspace.search.placeholder')}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            onTextChange?.(event.target.value);
            // New input: forget any highlighted result (see `navigated`).
            navigated.current = false;
            setActive(-1);
            setHint(null);
            if (feedback) onClearFeedback();
            scheduleSearch(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className={cn(
            'h-8 w-full rounded-md border border-input bg-card text-xs pl-11 pr-3 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            compact ? 'bg-amber-50 dark:bg-amber-950/40' : '',
          )}
        />
        {createPortal(
          <ul
            id={listId}
            role="listbox"
            aria-label={t('workspace.search.results')}
            hidden={!open}
            style={popup}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (
                !pageError &&
                el.scrollHeight - el.scrollTop - el.clientHeight < 80
              )
                void loadMore();
            }}
            className="fixed z-40 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
          >
            {results.map((item, index) => (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus in the field
                  reset();
                  void onPick(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm',
                  index === active && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="font-medium">{item.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {[
                    t(`workspace.itemType.${item.type}`),
                    item.sku,
                    item.barcodes.find((b) => b.isActive)?.barcode,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
            <li
              id={`${listId}-${results.length}`}
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(event) => {
                event.preventDefault();
                reset();
                onCustom();
              }}
              onMouseEnter={() => setActive(results.length)}
              className={cn(
                'cursor-pointer border-t border-border px-3 py-2 text-sm',
                active === results.length && 'bg-accent text-accent-foreground',
              )}
            >
              {t('workspace.custom.open')}
            </li>
            {pageError && (
              <li
                id={`${listId}-${results.length + 1}`}
                role="option"
                aria-selected={active === results.length + 1}
                onMouseDown={(event) => {
                  event.preventDefault();
                  void loadMore();
                }}
                onMouseEnter={() => setActive(results.length + 1)}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm underline',
                  active === results.length + 1 &&
                    'bg-accent text-accent-foreground',
                )}
              >
                {t('common.retry')}
              </li>
            )}
          </ul>,
          document.body,
        )}
      </div>
      <div id={hintId} aria-live="polite" className="empty:hidden">
        {pageError && <p>{t('common.retry')}</p>}
        {feedback ? (
          <p
            role="alert"
            data-testid="scan-feedback"
            className="rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive"
          >
            {feedback}
          </p>
        ) : hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
