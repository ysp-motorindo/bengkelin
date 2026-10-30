import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Input } from '@/renderer/components/ui/input';
import { errorMessage } from '@/renderer/lib/errors';
import { parseRupiahInput } from '@/renderer/lib/money';
import {
  MAX_LINE_QUANTITY,
  type CatalogItemDto,
  type ReferenceDto,
} from '@/shared/contracts';
import { CustomLineDialog } from './CustomLineDialog';
import { ScannerCombobox, type ScanOutcome } from './ScannerCombobox';
import { transactionCellClass } from './EditableLineRow';
import type { DraftCommands } from './use-draft-commands';
export interface LineEntryRowHandle {
  focusSearch(): void;
  startCustom(): void;
}
interface Props {
  commands: DraftCommands;
  units: ReferenceDto[];
  mechanics: ReferenceDto[];
  entryRef?: Ref<LineEntryRowHandle>;
}
export function LineEntryRow({ commands, units, mechanics, entryRef }: Props) {
  const { t } = useTranslation();
  const search = useRef<HTMLInputElement>(null);
  const [custom, setCustom] = useState(false);
  const [selected, setSelected] = useState<CatalogItemDto | null>(null);
  const [source, setSource] = useState<
    { barcode: string } | { catalogItemId: string } | null
  >(null);
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [needsPrice, setNeedsPrice] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const focus = () => search.current?.focus();
  const { markInvalid } = commands;
  const dirty = useCallback(
    (value: boolean) => markInvalid('entry', value),
    [markInvalid],
  );
  useEffect(() => () => markInvalid('entry', false), [markInvalid]);
  function clear() {
    setCustom(false);
    setSelected(null);
    setSource(null);
    setNeedsPrice(false);
    setPrice('');
    setReason('');
    setQuantity('1');
    setFeedback(null);
    dirty(false);
    requestAnimationFrame(focus);
  }
  useImperativeHandle(entryRef, () => ({
    focusSearch: focus,
    startCustom: () => {
      setCustom(true);
    },
  }));
  async function add(target = source): Promise<ScanOutcome> {
    if (pending.current || !target) return 'other';
    const count = Number(quantity);
    if (!/^\d+$/.test(quantity) || count < 1 || count > MAX_LINE_QUANTITY) {
      setFeedback(t('workspace.validation.quantity'));
      dirty(true);
      return 'other';
    }
    const parsed = needsPrice ? parseRupiahInput(price) : null;
    if (needsPrice && parsed === null) {
      setFeedback(t('workspace.validation.money'));
      dirty(true);
      return 'other';
    }
    pending.current = true;
    setBusy(true);
    dirty(true);
    setSource(target);
    try {
      const result = await commands.send({
        kind: 'addCatalogLine',
        ...target,
        quantity: count,
        ...(needsPrice && parsed !== null
          ? {
              unitPrice: parsed,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            }
          : {}),
      });
      if (result.ok) {
        clear();
        return 'added';
      }
      if (result.error.code === 'PRICE_REQUIRED') {
        setNeedsPrice(true);
        setFeedback(t('workspace.manualPrice.title'));
        return 'other';
      }
      setFeedback(errorMessage(t, result.error));
      return result.error.code === 'UNKNOWN_BARCODE' ? 'unknown' : 'other';
    } catch {
      setFeedback(t('errors.INTERNAL_ERROR'));
      return 'other';
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function pick(item: CatalogItemDto) {
    setSelected(item);
    setSource({ catalogItemId: item.id });
    setNeedsPrice(false);
    setPrice('');
    setFeedback(null);
    dirty(true);
  }
  return (
    <tr className="border-t-2 border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
      <td
        colSpan={11}
        className="px-2 py-2"
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !custom &&
            (event.target as HTMLElement).getAttribute('role') !== 'combobox' &&
            (event.target as HTMLElement).tagName !== 'BUTTON'
          ) {
            event.preventDefault();
            void add();
          }
          if (
            event.key === 'Escape' &&
            !event.defaultPrevented &&
            !pending.current
          ) {
            event.preventDefault();
            clear();
          }
        }}
      >
        {custom ? (
          <CustomLineDialog
            inline
            existingLineIds={commands.view.lines.map((line) => line.id)}
            units={units}
            mechanics={mechanics}
            send={commands.send}
            onClose={clear}
            returnFocus={focus}
            onDirtyChange={dirty}
          />
        ) : (
          <div className="grid gap-2">
            <div className="grid items-end gap-2 sm:grid-cols-[minmax(12rem,1fr)_5rem_8rem_auto_auto]">
              <div>
                <ScannerCombobox
                  compact
                  disabled={busy}
                  inputRef={search}
                  onScan={(barcode) => {
                    setSelected(null);
                    return add({ barcode });
                  }}
                  onPick={pick}
                  feedback={feedback}
                  onClearFeedback={() => setFeedback(null)}
                  onTextChange={(text) => dirty(!!text || !!source)}
                />
                {selected && (
                  <p className="text-xs font-semibold">{selected.title}</p>
                )}
                {!selected && source && 'barcode' in source && (
                  <p className="text-xs">{source.barcode}</p>
                )}
              </div>
              <label className="text-xs">
                {t('workspace.custom.quantity')}
                <NumericInput
                  aria-label={t('workspace.custom.quantity')}
                  disabled={busy}
                  className={transactionCellClass}
                  value={quantity}
                  onValueChange={(value) => {
                    setQuantity(value);
                    dirty(true);
                  }}
                />
              </label>
              <label className="text-xs">
                {t('workspace.editor.unitPrice')}
                {needsPrice ? (
                  <NumericInput
                    autoFocus
                    aria-label={t('workspace.editor.unitPrice')}
                    disabled={busy}
                    className={transactionCellClass}
                    value={price}
                    onValueChange={setPrice}
                  />
                ) : (
                  <Input
                    readOnly
                    className={transactionCellClass}
                    value={t('workspace.entry.automatic')}
                  />
                )}
              </label>
              <Button
                size="sm"
                disabled={busy || !source}
                onClick={() => void add()}
              >
                {t('workspace.custom.add')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setCustom(true)}
              >
                {t('workspace.custom.open')}
              </Button>
            </div>
            {needsPrice && (
              <label className="text-xs">
                {t('workspace.manualPrice.reason')}
                <Input
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {source && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>
                {t('workspace.common.cancel')}
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
