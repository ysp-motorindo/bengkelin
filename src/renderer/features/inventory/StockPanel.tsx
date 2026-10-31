import { useNumberFormat } from '@/renderer/lib/number-format';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { formatDisplayDateTime } from '@/renderer/lib/date-format';
import { useAction } from '@/renderer/lib/use-action';
import { cn } from '@/renderer/lib/utils';
import type {
  LedgerDto,
  StockChangeDto,
  StockListItemDto,
} from '@/shared/contracts';

type ActionKind = 'openBalance' | 'receive' | 'adjust' | 'setStock';
const ACTIONS: ActionKind[] = ['openBalance', 'receive', 'adjust', 'setStock'];

const WHOLE_NUMBER = /^-?\d+$/;

/** `+5` / `-5` / `0`. */
function signed(value: number, format: (value: number) => string): string {
  return value > 0 ? `+${format(value)}` : format(value);
}

/**
 * One request id per user SUBMISSION: created on first use, reused when the
 * same submission is retried (e.g. after a network-like failure), and dropped
 * once it succeeds or the user changes what they are submitting.
 */
function useSubmissionId() {
  const ref = useRef<string | null>(null);
  return {
    current(): string {
      ref.current ??= crypto.randomUUID();
      return ref.current;
    },
    reset() {
      ref.current = null;
    },
  };
}

interface StockPanelProps {
  item: StockListItemDto;
  admin: boolean;
  /** Called after a successful write so the list refreshes. */
  onChanged(): Promise<void> | void;
}

/** History (any role) and, for ADMIN, the four stock actions. */
export function StockPanel({ item, admin, onChanged }: StockPanelProps) {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  const [ledger, setLedger] = useState<LedgerDto | null>(null);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(item.quantity);
  const load = useAction();
  const { run: loadRun, check: loadCheck } = load;

  const reload = useCallback(
    () =>
      loadRun(async () => {
        const [history, stock] = await Promise.all([
          window.bengkelin.inventory.history({
            catalogItemId: item.catalogItemId,
          }),
          window.bengkelin.inventory.getStock({
            catalogItemId: item.catalogItemId,
          }),
        ]);
        if (loadCheck(history)) setLedger(history.value);
        if (loadCheck(stock)) setQuantity(stock.value.quantity);
      }),
    [loadRun, loadCheck, item.catalogItemId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function changed(result: StockChangeDto) {
    setQuantity(result.newQuantity);
    setNotice(
      result.quantityDelta === 0
        ? t('inventory.result.unchanged', {
            ...numberOptions,
            quantity: result.newQuantity,
          })
        : t('inventory.result.changed', {
            ...numberOptions,
            delta: signed(result.quantityDelta, formatNumber),
            quantity: result.newQuantity,
          }),
    );
    setAction(null);
    await Promise.all([reload(), onChanged()]);
  }

  return (
    <section
      aria-label={item.title}
      data-testid="stock-detail"
      className="flex flex-col gap-4"
    >
      <div>
        <p
          data-testid="stock-current"
          className={cn(
            'text-sm',
            quantity < 0
              ? 'font-medium text-destructive'
              : 'text-muted-foreground',
          )}
        >
          {t('inventory.detail.current', {
            ...numberOptions,
            quantity,
            unit: item.unitLabel,
          })}
          {quantity < 0 ? ` (${t('inventory.negative')})` : ''}
        </p>
      </div>

      {notice ? (
        <p role="status" data-testid="stock-notice" className="text-sm">
          {notice}
        </p>
      ) : null}

      {admin ? (
        <div
          role="group"
          aria-label={t('inventory.actions.label')}
          className="flex flex-wrap gap-2"
        >
          {ACTIONS.map((kind) => (
            <Button
              key={kind}
              variant={action === kind ? 'default' : 'outline'}
              size="sm"
              aria-pressed={action === kind}
              onClick={() => {
                setNotice(null);
                setAction(kind);
              }}
            >
              {t(`inventory.actions.${kind}`)}
            </Button>
          ))}
        </div>
      ) : null}

      {admin && action ? (
        <ActionForm
          key={action}
          kind={action}
          itemId={item.catalogItemId}
          current={quantity}
          onCancel={() => setAction(null)}
          onDone={changed}
        />
      ) : null}

      {load.error ? <Alert>{load.error}</Alert> : null}
      <History ledger={ledger} />
    </section>
  );
}

function ActionForm({
  kind,
  itemId,
  current,
  onCancel,
  onDone,
}: {
  kind: ActionKind;
  itemId: string;
  current: number;
  onCancel(): void;
  onDone(result: StockChangeDto): Promise<void>;
}) {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [text, setText] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const submission = useSubmissionId();
  const { busy, error, fieldErrors, run, check } = useAction();

  const needsReason = kind === 'adjust' || kind === 'setStock';
  const parsed = WHOLE_NUMBER.test(value.trim()) ? Number(value.trim()) : null;
  const numberError =
    value.trim() !== '' && parsed === null ? 'validation.invalid' : undefined;
  const delta =
    kind === 'setStock' && parsed !== null ? parsed - current : null;

  function edit<T>(set: (next: T) => void) {
    return (next: T) => {
      // A different submission: it must not reuse the old request id.
      submission.reset();
      set(next);
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed === null) return;
    if (needsReason && text.trim() === '') {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    void run(async () => {
      const requestId = submission.current();
      const bridge = window.bengkelin.inventory;
      const result =
        kind === 'openBalance'
          ? await bridge.openBalance({
              requestId,
              catalogItemId: itemId,
              quantity: parsed,
            })
          : kind === 'receive'
            ? await bridge.receive({
                requestId,
                catalogItemId: itemId,
                quantity: parsed,
                note: text,
              })
            : kind === 'adjust'
              ? await bridge.adjust({
                  requestId,
                  catalogItemId: itemId,
                  quantityDelta: parsed,
                  reason: text,
                })
              : await bridge.setStock({
                  requestId,
                  catalogItemId: itemId,
                  targetQuantity: parsed,
                  reason: text,
                });
      if (!check(result)) return;
      submission.reset();
      await onDone(result.value);
    });
  }

  const valueLabel =
    kind === 'adjust'
      ? t('inventory.form.delta')
      : kind === 'setStock'
        ? t('inventory.form.target')
        : t('inventory.form.quantity');
  const textLabel = needsReason
    ? t('inventory.form.reason')
    : t('inventory.form.note');

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t(`inventory.actions.${kind}`)}
      className="flex flex-col gap-3 rounded-md border border-border p-3 md:max-w-md"
    >
      <FormField
        label={valueLabel}
        error={
          numberError ??
          fieldErrors.quantity ??
          fieldErrors.quantityDelta ??
          fieldErrors.targetQuantity
        }
      >
        <NumericInput
          negative={kind === 'adjust' || kind === 'setStock'}
          autoComplete="off"
          value={value}
          onValueChange={(value) => edit(setValue)(value)}
        />
      </FormField>
      {kind === 'setStock' && parsed !== null ? (
        <p
          data-testid="set-stock-preview"
          className="text-sm"
          aria-live="polite"
        >
          {delta === 0
            ? t('inventory.setStock.noChange')
            : t('inventory.setStock.preview', {
                ...numberOptions,
                delta: signed(delta ?? 0, formatNumber),
                current,
                target: parsed,
              })}
        </p>
      ) : null}
      {kind === 'setStock' ? (
        <p className="text-xs text-muted-foreground">
          {t('inventory.setStock.note')}
        </p>
      ) : null}
      <FormField
        label={textLabel}
        error={reasonMissing ? 'inventory.form.reasonRequired' : undefined}
      >
        <Input
          autoComplete="off"
          value={text}
          onChange={(event) => edit(setText)(event.target.value)}
        />
      </FormField>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || parsed === null}>
          {kind === 'setStock'
            ? t('inventory.form.confirm')
            : t('inventory.form.submit')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {t('inventory.form.cancel')}
        </Button>
      </div>
    </form>
  );
}

function History({ ledger }: { ledger: LedgerDto | null }) {
  const { formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  if (!ledger) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{t('inventory.detail.history')}</h3>
      {ledger.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('inventory.detail.noHistory')}
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-2 py-2">
                  {t('inventory.history.time', { zone: ledger.timezone })}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('inventory.history.movement')}
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  {t('inventory.history.change')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('inventory.history.cashier')}
                </th>
                <th scope="col" className="px-2 py-2">
                  {t('inventory.history.note')}
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((entry) => (
                <tr
                  key={entry.id}
                  data-testid="ledger-row"
                  className="border-t border-border"
                >
                  <td className="px-2 py-2">
                    {formatDisplayDateTime(entry.createdAt, ledger.timezone)}
                  </td>
                  <td className="px-2 py-2">
                    {t(`inventory.movement.${entry.movementType}`)}
                  </td>
                  <td
                    className={cn(
                      'px-2 py-2 text-right tabular',
                      entry.quantityDelta < 0 && 'text-destructive',
                    )}
                  >
                    {signed(entry.quantityDelta, formatNumber)}
                  </td>
                  <td className="px-2 py-2">{entry.cashierName}</td>
                  <td className="px-2 py-2">{entry.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
