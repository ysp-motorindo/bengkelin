import { ScanBarcode } from 'lucide-react';
import {
  useEffect,
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
  const [active, setActive] = useState(-1);
  const [hint, setHint] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function search(query: string): Promise<CatalogItemDto[]> {
    const seq = ++searchSeq.current;
    try {
      const result = await window.bengkelin.catalog.search({
        query,
        limit: 10,
      });
      if (seq !== searchSeq.current) return [];
      if (!result.ok) {
        watchSessionError(result.error);
        return [];
      }
      return result.value.results;
    } catch {
      return [];
    }
  }

  function scheduleSearch(query: string) {
    clearTimeout(timer.current);
    if (!query.trim()) {
      searchSeq.current += 1;
      setResults([]);
      setOpen(false);
      setActive(-1);
      return;
    }
    timer.current = setTimeout(() => {
      void search(query.trim()).then((found) => {
        if (inputRef.current?.value !== query) return; // typed on / cleared
        setResults(found);
        setOpen(found.length > 0);
        setActive(-1);
      });
    }, SEARCH_DELAY_MS);
  }

  function reset() {
    clearTimeout(timer.current);
    searchSeq.current += 1;
    setText('');
    setResults([]);
    setOpen(false);
    setActive(-1);
  }

  async function submitText(code: string) {
    const outcome = await onScan(code);
    if (outcome !== 'unknown' || /^\d+$/.test(code)) return;
    // Not a barcode: offer the search results for keyboard selection.
    const found = await search(code);
    if (found.length === 0 || inputRef.current?.value !== '') return;
    onClearFeedback();
    setText(code);
    setResults(found);
    setOpen(true);
    setActive(0);
    setHint(t('workspace.search.chooseResult'));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((index) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (index < 0) return step > 0 ? 0 : results.length - 1;
        return (index + step + results.length) % results.length;
      });
      return;
    }
    if (event.key === 'Escape') {
      if (open || text) {
        event.preventDefault();
        reset();
        setHint(null);
      }
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const picked = open && active >= 0 ? results[active] : undefined;
    const code = text.trim();
    reset();
    setHint(null);
    if (picked) {
      void onPick(picked);
    } else if (code) {
      void submitText(code);
    }
  }

  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={`${listId}-input`} className="text-sm font-medium">
        {t('workspace.search.label')}
      </label>
      <div className="relative">
        <ScanBarcode
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
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
            setHint(null);
            if (feedback) onClearFeedback();
            scheduleSearch(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
          className="h-12 w-full rounded-md border border-input bg-card pl-11 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={t('workspace.search.results')}
          hidden={!open}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
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
        </ul>
      </div>
      <div id={hintId} aria-live="polite">
        {feedback ? (
          <p
            role="alert"
            data-testid="scan-feedback"
            className="rounded-md border border-destructive/50 px-3 py-1.5 text-sm text-destructive"
          >
            {feedback}
          </p>
        ) : hint ? (
          <p className="text-sm text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
