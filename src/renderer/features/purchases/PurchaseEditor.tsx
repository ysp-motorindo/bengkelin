import { ResizableTransactionTable } from '@/renderer/components/resizable-transaction-table';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatDisplayDate } from '@/renderer/lib/date-format';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Alert } from '@/renderer/components/ui/alert';
import { FormField } from '@/renderer/components/form-field';
import { ScannerCombobox } from '@/renderer/features/workspace/ScannerCombobox';
import { SaveIndicator } from '@/renderer/features/workspace/SaveIndicator';
import {
  registerWorkspaceActions,
  type WorkspaceActions,
} from '@/renderer/features/workspace/workspace-actions';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { useAction } from '@/renderer/lib/use-action';
import { errorMessage } from '@/renderer/lib/errors';
import {
  priceSchema,
  type PurchaseDraftView,
  type PurchaseDraftOperation,
  type PurchaseView,
  type SupplierDto,
  type ReferenceDto,
  type PurchaseFinalizePreview,
} from '@/shared/contracts';
import {
  parsePercentageToBps,
  formatBpsAsPercentage,
} from '@/shared/percentage';
import { usePurchaseDraft } from './use-purchase-draft';
import {
  DraftField,
  DraftDiscounts,
  type PurchaseCommands,
} from './DraftFields';
import { SupplierForm } from './Suppliers';
import { PurchasePaymentsDialog } from './PurchasePaymentsDialog';
export function PurchaseEditor({
  initial,
  toolbarSlot,
  draftSelector,
  active,
  units,
  onNew,
  onPosted,
  onDiscarded,
  registerDraftActions,
  onChanged,
}: {
  initial: PurchaseDraftView;
  toolbarSlot?: HTMLElement | null;
  draftSelector?: ReactNode;
  active: boolean;
  units: ReferenceDto[];
  onNew: () => Promise<void>;
  onPosted: (p: PurchaseView) => void;
  onDiscarded: () => void;
  registerDraftActions: (actions: WorkspaceActions) => () => void;
  onChanged: (view: PurchaseDraftView) => void;
}) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const action = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const commands = usePurchaseDraft(initial, (n) => {
    if (n.kind === 'failed') setNotice(errorMessage(t, n.error));
    else if (n.kind === 'conflictReloaded') setNotice(t('purchases.conflict'));
    else if (n.kind === 'closed') onDiscarded();
  });
  const { view } = commands;
  useEffect(
    () =>
      registerDraftActions({
        newTransaction: async () => {
          if (await commands.flush()) await onNew();
        },
        focusSearch: () => search.current?.focus(),
        addCustomItem: () => setCustom(true),
        saveDraft: commands.flush,
        openCheckoutReview: reviewBill,
      }),
    [registerDraftActions, commands.flush, onNew, view.id, view.version],
  );
  useEffect(() => onChanged(view), [view, onChanged]);
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [supplierForm, setSupplierForm] = useState(false);
  const [custom, setCustom] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [review, setReview] = useState<{
    preview: PurchaseFinalizePreview;
    requestId: string;
  } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const supplierQuery = useRef(0);
  function loadSuppliers(query = '') {
    const rev = ++supplierQuery.current;
    void window.bengkelin.suppliers
      .search({ query, limit: 50 })
      .then((r) => {
        if (rev === supplierQuery.current) {
          if (r.ok) setSuppliers(r.value.results);
          else setNotice(errorMessage(t, r.error));
        }
      })
      .catch(() => setNotice(t('errors.INTERNAL_ERROR')));
  }
  useEffect(() => {
    loadSuppliers();
  }, []);
  const returning = useRef(active);
  useEffect(() => {
    if (active && !returning.current) {
      loadSuppliers();
      void commands.flush().then((ok) => (ok ? commands.refresh() : undefined));
    }
    returning.current = active;
  }, [active, commands.flush, commands.refresh]);
  async function send(op: PurchaseDraftOperation) {
    const r = await commands.send(op);
    if (!r.ok) setNotice(errorMessage(t, r.error));
    return r;
  }
  async function reviewBill() {
    if (!(await commands.flush())) {
      setNotice(t('workspace.notices.unsaved'));
      return;
    }
    void action.run(async () => {
      const r = await window.bengkelin.purchases.previewFinalize({
        purchaseId: view.id,
      });
      if (action.check(r)) {
        setReview({ preview: r.value, requestId: crypto.randomUUID() });
        setAccepted(false);
      }
    });
  }
  useEffect(() => {
    if (!active) return;
    return registerWorkspaceActions({
      newTransaction: async () => {
        if (await commands.flush()) await onNew();
      },
      focusSearch: () => search.current?.focus(),
      addCustomItem: () => setCustom(true),
      saveDraft: commands.flush,
      openCheckoutReview: reviewBill,
    });
  }, [active, commands.flush, onNew, view.id]);
  const add = async (
    target: { catalogItemId: string } | { barcode: string },
  ) => {
    const before = new Set(commands.current().lines.map((l) => l.id));
    const r = await send({ kind: 'addCatalogLine', ...target });
    if (r.ok) {
      setFeedback(null);
      const line = r.value.lines.find((l) => !before.has(l.id));
      if (line && active)
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(
              `[data-purchase-line="${line.id}"] [data-purchase-price] input`,
            )
            ?.focus(),
        );
      return 'added' as const;
    }
    setFeedback(errorMessage(t, r.error));
    return r.error.code === 'UNKNOWN_BARCODE'
      ? ('unknown' as const)
      : ('other' as const);
  };
  const controlsDisabled = action.busy;
  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {draftSelector}
        <SaveIndicator state={commands.saveState} onRetry={commands.retry} />
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void commands.flush().then((ok) => {
              if (ok) return onNew();
            })
          }
          disabled={controlsDisabled}
        >
          {t('purchases.new')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDiscard(true)}
          disabled={controlsDisabled}
        >
          {t('purchases.discard')}
        </Button>
      </div>
    </div>
  );
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-2"
      aria-label={t('purchases.editor')}
    >
      {toolbarSlot
        ? active
          ? createPortal(toolbar, toolbarSlot)
          : null
        : toolbar}
      {notice ? <Alert>{notice}</Alert> : null}
      {action.error ? <Alert>{action.error}</Alert> : null}
      <fieldset
        disabled={controlsDisabled}
        className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_3fr]"
      >
        <div className="min-w-0 space-y-2">
          <FormField label={t('purchases.supplier')}>
            <Select
              value={view.supplier?.id ?? ''}
              onChange={(e) =>
                void send({
                  kind: 'updateHeader',
                  changes: { supplierId: e.target.value || null },
                })
              }
            >
              <option value="">{t('purchases.chooseSupplier')}</option>
              {view.supplier &&
              !suppliers.some((s) => s.id === view.supplier!.id) ? (
                <option value={view.supplier.id}>{view.supplier.name}</option>
              ) : null}
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex gap-2">
            <Input
              aria-label={t('purchases.searchSupplier')}
              placeholder={t('purchases.searchSupplier')}
              onChange={(e) => loadSuppliers(e.target.value)}
            />
            <Button variant="outline" onClick={() => setSupplierForm(true)}>
              {t('purchases.addSupplier')}
            </Button>
          </div>
        </div>
        <div className="grid min-w-0 gap-2 lg:col-start-3 lg:grid-cols-3">
          <DraftField
            commands={commands}
            field="billReference"
            label={t('purchases.billReference')}
            value={view.supplierBillReference ?? ''}
            parse={(v) =>
              v.length <= 100
                ? {
                    kind: 'updateHeader',
                    changes: { supplierBillReference: v || null },
                  }
                : null
            }
          />
          <DraftField
            commands={commands}
            field="date"
            label={t('purchases.billDate')}
            value={view.billDate}
            type="date"
            parse={(v) =>
              /^\d{4}-\d{2}-\d{2}$/.test(v)
                ? { kind: 'updateHeader', changes: { billDate: v } }
                : null
            }
          />
          <div className="grid min-w-0 grid-cols-[1fr_2fr] gap-2">
            <DraftField
              commands={commands}
              field="top"
              label={t('purchases.topDays')}
              value={String(view.topDays)}
              numeric
              parse={(v) =>
                /^\d+$/.test(v) && Number(v) <= 3650
                  ? { kind: 'updateHeader', changes: { topDays: Number(v) } }
                  : null
              }
            />
            <FormField label={t('purchases.dueDate')}>
              <Input readOnly value={formatDisplayDate(view.dueDate)} />
            </FormField>
          </div>
        </div>
      </fieldset>
      <div className="transaction-lines min-h-48 min-w-0 flex-1 overflow-auto lg:min-h-0">
        <ResizableTransactionTable
          caption={t('purchases.item')}
          storageKey="bengkelin.purchase-column-widths.v1"
          columns={[
            '#',
            t('workspace.lines.code'),
            t('purchases.item'),
            t('purchases.unit'),
            t('purchases.quantity'),
            t('purchases.unitPrice'),
            'D1',
            'D2',
            'D3',
            'D4',
            t('purchases.lineAmount'),
            t('workspace.lines.actions'),
          ].map((label, i) => ({
            label,
            minWidth: [32, 96, 192, 56, 64, 112, 56, 56, 56, 56, 128, 80][i]!,
          }))}
        >
          {view.lines.map((l, index) => (
            <tr
              key={l.id}
              data-purchase-line={l.id}
              className="border-t align-top"
            >
              <td className="text-right text-muted-foreground">{index + 1}</td>
              <td className="truncate" title={l.itemCode ?? undefined}>
                {l.itemCode ?? '—'}
              </td>
              <td className="min-w-48">
                <span className="font-medium">{l.title}</span>
              </td>
              <td className="text-center">{l.unitLabel}</td>
              <td className="w-28 px-2 py-1.5">
                <DraftField
                  commands={commands}
                  compact
                  field={'qty:' + l.id}
                  label={t('purchases.quantityLabel', { title: l.title })}
                  value={String(l.quantity)}
                  numeric
                  parse={(v) =>
                    /^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 1000000
                      ? {
                          kind: 'updateLine',
                          lineId: l.id,
                          changes: { quantity: Number(v) },
                        }
                      : null
                  }
                />
              </td>
              <td className="min-w-40 px-2 py-1.5" data-purchase-price>
                <DraftField
                  commands={commands}
                  compact
                  field={'price:' + l.id}
                  label={t('purchases.priceLabel', { title: l.title })}
                  value={l.unitPrice ?? ''}
                  numeric
                  parse={(v) =>
                    v === ''
                      ? {
                          kind: 'updateLine',
                          lineId: l.id,
                          changes: { unitPrice: null },
                        }
                      : priceSchema.safeParse(v).success
                        ? {
                            kind: 'updateLine',
                            lineId: l.id,
                            changes: { unitPrice: v },
                          }
                        : null
                  }
                />
                {l.unitPrice === null ? (
                  <p className="mt-1 text-xs text-destructive">
                    {t('purchases.unpriced')}
                  </p>
                ) : null}
              </td>
              <DraftDiscounts
                commands={commands}
                lineId={l.id}
                stages={l.discountStages}
                cells
              />
              <td className="px-2 py-1.5 text-right tabular-nums">
                {l.amount === null ? '—' : formatIdr(l.amount)}
              </td>
              <td className="px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('purchases.remove') + ' ' + l.title}
                  onClick={() =>
                    void send({ kind: 'removeLine', lineId: l.id })
                  }
                >
                  {t('purchases.remove')}
                </Button>
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
            <td />
            <td colSpan={2} className="px-2 py-2">
              <ScannerCombobox
                compact
                inputRef={search}
                disabled={controlsDisabled}
                onCustom={() => setCustom(true)}
                onScan={(code) => add({ barcode: code })}
                onPick={async (item) => {
                  await add({ catalogItemId: item.id });
                }}
                feedback={feedback}
                onClearFeedback={() => setFeedback(null)}
              />
              {!view.lines.length ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t('purchases.emptyLines')}
                </p>
              ) : null}
            </td>
            <td colSpan={9} />
          </tr>
        </ResizableTransactionTable>
      </div>
      <div className="grid shrink-0 items-start gap-3 border-t border-border bg-card pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(23rem,0.45fr)]">
        <div className="min-w-0">
          <DraftField
            commands={commands}
            field="note"
            multiline
            label={t('purchases.note')}
            value={view.note ?? ''}
            parse={(v) =>
              v.length <= 1000
                ? { kind: 'updateHeader', changes: { note: v || null } }
                : null
            }
          />
        </div>
        <div className="min-w-0 space-y-2">
          <DraftDiscounts
            commands={commands}
            lineId={null}
            stages={view.discountStages}
          />
          <Button
            variant="outline"
            aria-label={t('purchases.outgoingPayments')}
            aria-haspopup="dialog"
            onClick={() =>
              void action.run(async () => {
                if (await commands.flush()) setPaymentsOpen(true);
                else action.setError(t('workspace.notices.unsaved'));
              })
            }
          >
            {t('purchases.outgoingPayments')}:{' '}
            {formatIdr(
              view.payments
                .reduce((sum, row) => sum + BigInt(row.amount), 0n)
                .toString(),
            )}
          </Button>
          <DraftField
            commands={commands}
            field="vat"
            label={t('purchases.vat')}
            value={formatBpsAsPercentage(view.vatRateBps)}
            numeric
            decimal
            parse={(v) => {
              try {
                return {
                  kind: 'setVatRate',
                  vatRateBps: parsePercentageToBps(v),
                };
              } catch {
                return null;
              }
            }}
          />

          {view.totals ? (
            <dl className="border border-border [&>div]:border-b [&>div]:border-border [&>div]:px-2 [&>div]:py-1 [&>div:last-child]:border-b-0">
              {(
                [
                  'subtotal',
                  'discountAmount',
                  'taxSubtotal',
                  'vatAmount',
                  'amount',
                ] as const
              ).map((k) => (
                <div
                  key={k}
                  className={
                    'flex justify-between gap-4 ' +
                    (k === 'amount'
                      ? 'bg-amber-50 font-semibold dark:bg-amber-950/40'
                      : 'text-sm')
                  }
                >
                  <dt>{t(`purchases.${k === 'amount' ? 'total' : k}`)}</dt>
                  <dd className="tabular-nums">{formatIdr(view.totals![k])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p role="status">{t('purchases.missingPrices')}</p>
          )}
          <Button
            className="w-full"
            onClick={() => void reviewBill()}
            disabled={
              controlsDisabled ||
              !view.totals ||
              !view.supplier ||
              !view.lines.length ||
              commands.saveState === 'failed' ||
              commands.saveState === 'unsaved'
            }
          >
            {t('purchases.review')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('purchases.finalizeNotice')}
          </p>
        </div>
      </div>
      {paymentsOpen ? (
        <PurchasePaymentsDialog
          commands={commands}
          onClose={() => setPaymentsOpen(false)}
        />
      ) : null}
      {supplierForm ? (
        <SupplierForm
          onClose={() => setSupplierForm(false)}
          onSaved={(s) => {
            setSuppliers((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
            void send({ kind: 'updateHeader', changes: { supplierId: s.id } });
            setSupplierForm(false);
          }}
        />
      ) : null}
      {custom ? (
        <CustomLine
          units={units}
          commands={commands}
          onClose={() => setCustom(false)}
        />
      ) : null}
      {review ? (
        <Dialog
          title={t('purchases.review')}
          onClose={() => {
            if (!action.busy) setReview(null);
          }}
          closeLabel={t('purchases.close')}
          footer={
            <DialogActions
              secondary={
                <Button
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => setReview(null)}
                >
                  {t('purchases.cancel')}
                </Button>
              }
            >
              <Button
                disabled={
                  action.busy ||
                  review.preview.errors.length > 0 ||
                  (review.preview.warnings.length > 0 && !accepted)
                }
                onClick={() =>
                  void action.run(async () => {
                    const r = await window.bengkelin.purchases.finalize({
                      requestId: review.requestId,
                      purchaseId: view.id,
                      expectedVersion: review.preview.version,
                      acknowledgedWarnings: review.preview.warnings,
                    });
                    if (action.check(r)) {
                      setReview(null);
                      onPosted(r.value);
                    } else if (
                      !r.ok &&
                      [
                        'DRAFT_VERSION_CONFLICT',
                        'FINALIZE_WARNINGS_CHANGED',
                      ].includes(r.error.code)
                    ) {
                      setReview(null);
                      await commands.refresh();
                    }
                  })
                }
              >
                {t('purchases.finalize')}
              </Button>
            </DialogActions>
          }
        >
          <div className="space-y-4">
            <p>{t('purchases.finalizeNotice')}</p>
            <p className="text-lg font-semibold">
              {view.supplier?.name} ·{' '}
              {review.preview.totals
                ? formatIdr(review.preview.totals.amount)
                : '—'}
            </p>
            {review.preview.errors.map((e, i) => (
              <Alert key={i}>{t(`errors.${e.code}`, e.params)}</Alert>
            ))}
            {review.preview.warnings.map((w, i) => (
              <Alert key={i}>{t(`purchases.${w.code}`, w.params)}</Alert>
            ))}
            {review.preview.warnings.length ? (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                {t('purchases.acknowledge')}
              </label>
            ) : null}
            {action.error ? <Alert>{action.error}</Alert> : null}
          </div>
        </Dialog>
      ) : null}
      {discard ? (
        <Dialog
          title={t('purchases.discard')}
          onClose={() => setDiscard(false)}
          footer={
            <Button
              variant="destructive"
              onClick={() =>
                void send({ kind: 'discard' }).then((r) => {
                  if (r.ok) onDiscarded();
                })
              }
            >
              {t('purchases.discard')}
            </Button>
          }
        >
          <p>{t('purchases.discardNotice')}</p>
        </Dialog>
      ) : null}
    </section>
  );
}
function CustomLine({
  units,
  commands,
  onClose,
}: {
  units: ReferenceDto[];
  commands: PurchaseCommands;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const action = useAction();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'SERVICE' | 'NON_STOCK_ITEM'>(
    'NON_STOCK_ITEM',
  );
  const [unit, setUnit] = useState(units[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  return (
    <Dialog
      title={t('purchases.customLine')}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      footer={
        <Button
          disabled={
            action.busy ||
            !title.trim() ||
            !unit ||
            !/^\d+$/.test(quantity) ||
            Number(quantity) < 1 ||
            Number(quantity) > 1000000 ||
            (price !== '' && !priceSchema.safeParse(price).success)
          }
          onClick={() =>
            void action.run(async () => {
              const r = await commands.send({
                kind: 'addCustomLine',
                type,
                title,
                unitId: unit,
                quantity: Number(quantity),
                unitPrice: price || null,
              });
              if (action.check(r)) onClose();
            })
          }
        >
          {t('purchases.add')}
        </Button>
      }
    >
      <div className="space-y-4">
        {action.error ? <Alert>{action.error}</Alert> : null}
        <FormField label={t('purchases.item')}>
          <Input
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label={t('purchases.type')}>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
          >
            {(['NON_STOCK_ITEM', 'SERVICE'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`workspace.itemType.${v}`, {
                  defaultValue:
                    v === 'SERVICE'
                      ? t('workspace.itemType.SERVICE')
                      : t('purchases.customLine'),
                })}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('purchases.unit')}>
          <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('purchases.quantity')}>
          <NumericInput value={quantity} onValueChange={setQuantity} />
        </FormField>
        <FormField label={t('purchases.unitPrice')}>
          <NumericInput value={price} onValueChange={setPrice} />
        </FormField>
      </div>
    </Dialog>
  );
}
