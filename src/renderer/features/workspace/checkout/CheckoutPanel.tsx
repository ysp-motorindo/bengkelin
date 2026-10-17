import { useNumberFormat } from '@/renderer/lib/number-format';
import { Banknote, ClipboardCheck, Plus, QrCode, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import { parseRupiahInput } from '@/renderer/lib/money';
import {
  MAX_CHECKOUT_ALLOCATIONS,
  PAYMENT_METHODS,
  type DraftOperation,
  type PaymentMethod,
} from '@/shared/contracts';
import { parseStageTexts, stagesToTexts } from '../discount-inputs';
import { useSyncedValue } from '../synced-field';
import type { DraftCommands } from '../use-draft-commands';
import { cashChange } from './tender';

interface CheckoutPanelProps {
  commands: DraftCommands;
  /** Flushes, then opens the review step (T10 finalizes from there). */
  onReview(): void;
  onError(message: string | null): void;
}

interface AllocationRow {
  method: PaymentMethod;
  amount: string;
  reference: string;
}

/**
 * The persistent totals and checkout panel: subtotal, item and invoice
 * discounts, total; invoice Discount 1-4; the planned payment split
 * (setCheckoutAllocations) with Pay Full Cash/QRIS helpers; a cash
 * tender/change calculator (UI only); and the Review checkout step.
 */
export function CheckoutPanel({
  commands,
  onReview,
  onError,
}: CheckoutPanelProps) {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const { view, send, edit, isDirty, markInvalid, flush } = commands;
  const separator = '.';
  const { totals } = view;

  const serverRows: AllocationRow[] = view.checkoutAllocations.map((a) => ({
    method: a.method,
    amount: a.amount,
    reference: a.reference ?? '',
  }));
  const [rows, setRows] = useSyncedValue(
    serverRows,
    () => isDirty('allocations'),
    JSON.stringify(serverRows),
  );
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const serverDiscounts = stagesToTexts(view.invoiceDiscounts, separator);
  const [discounts, setDiscounts] = useSyncedValue(
    serverDiscounts,
    () => isDirty('invoiceDiscounts'),
    serverDiscounts.join('|'),
  );
  const [discountError, setDiscountError] = useState<{
    index: number;
    key: string;
  } | null>(null);
  const [tendered, setTendered] = useState('');

  function changeDiscount(index: number, text: string) {
    const next = discounts.map((value, i) => (i === index ? text : value));
    setDiscounts(next);
    const parsed = parseStageTexts(next);
    if (!parsed.ok) {
      setDiscountError({
        index: parsed.index,
        key:
          parsed.reason === 'gap'
            ? 'workspace.validation.discountGap'
            : 'workspace.validation.percentage',
      });
      // Never "Saved" while the typed value is invalid (and unsent).
      markInvalid('invoiceDiscounts', true);
      return;
    }
    setDiscountError(null);
    edit('invoiceDiscounts', {
      kind: 'setInvoiceDiscounts',
      stages: parsed.stages,
    });
  }

  function changeRows(next: AllocationRow[]) {
    setRows(next);
    const errors: Record<number, string> = {};
    const allocations: Extract<
      DraftOperation,
      { kind: 'setCheckoutAllocations' }
    >['allocations'] = [];
    next.forEach((row, index) => {
      const amount = parseRupiahInput(row.amount);
      if (amount === null || BigInt(amount) <= 0n) {
        errors[index] = 'workspace.validation.positiveMoney';
        return;
      }
      allocations.push({
        method: row.method,
        amount,
        ...(row.reference.trim() ? { reference: row.reference.trim() } : {}),
      });
    });
    setRowErrors(errors);
    if (Object.keys(errors).length > 0) {
      // Never "Saved" while a typed amount is invalid (and unsent): the
      // review must not open on the older server allocations.
      markInvalid('allocations', true);
      return;
    }
    edit('allocations', { kind: 'setCheckoutAllocations', allocations });
  }

  async function payFull(method: PaymentMethod) {
    // Pay Full replaces the typed rows, so invalid row input no longer
    // matters (and must not keep the draft "Not saved").
    markInvalid('allocations', false);
    await flush();
    const result = await send({
      kind: 'setCheckoutAllocations',
      allocations:
        BigInt(totals.amount) > 0n ? [{ method, amount: totals.amount }] : [],
    });
    if (result.ok) {
      onError(null);
      setRowErrors({});
      setRows(
        result.value.checkoutAllocations.map((a) => ({
          method: a.method,
          amount: a.amount,
          reference: a.reference ?? '',
        })),
      );
    } else if (result.error.code !== 'QUEUE_CLOSED') {
      onError(errorMessage(t, result.error));
    }
  }

  const tenderedAmount = parseRupiahInput(tendered);
  const change =
    tenderedAmount === null
      ? null
      : cashChange(tenderedAmount, totals.amount, view.checkoutAllocations);
  const unallocatedNegative = BigInt(totals.unallocatedAmount) < 0n;

  return (
    <aside
      aria-label={t('workspace.checkout.label')}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
    >
      <dl className="tabular grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">
          {t('workspace.checkout.subtotal')}
        </dt>
        <dd className="text-right" data-testid="subtotal-amount">
          {formatIdr(totals.subtotal)}
        </dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.itemDiscounts')}
        </dt>
        <dd className="text-right" data-testid="item-discount-amount">
          {formatIdr(totals.itemDiscountAmount)}
        </dd>
        <dt className="text-muted-foreground">
          {t('workspace.checkout.invoiceDiscounts')}
        </dt>
        <dd className="text-right" data-testid="invoice-discount-amount">
          {formatIdr(totals.invoiceDiscountAmount)}
        </dd>
        <div className="col-span-2 grid grid-cols-[1fr_auto] gap-x-3 border-t border-border pt-2">
          <dt className="self-end text-base font-semibold">
            {t('workspace.checkout.total')}
          </dt>
          <dd
            className="text-right text-2xl font-semibold"
            data-testid="total-amount"
          >
            {formatIdr(totals.amount)}
          </dd>
        </div>
      </dl>

      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-sm font-medium">
          {t('workspace.checkout.invoiceDiscountsTitle')}
        </legend>
        {discounts.map((value, index) => (
          <FormField
            key={index}
            label={t(`workspace.checkout.invoiceDiscount${index + 1}`)}
            error={
              discountError?.index === index ? discountError.key : undefined
            }
            hint={
              view.invoiceDiscounts[index]
                ? `-${formatIdr(view.invoiceDiscounts[index].amount)}`
                : undefined
            }
          >
            <NumericInput
              decimal
              autoComplete="off"
              className="tabular h-9"
              value={value}
              onValueChange={(value) => changeDiscount(index, value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void flush();
                }
              }}
            />
          </FormField>
        ))}
      </fieldset>

      <section
        aria-label={t('workspace.checkout.payments')}
        className="flex flex-col gap-2"
      >
        <h3 className="text-sm font-medium">
          {t('workspace.checkout.payments')}
        </h3>
        <div className="flex flex-wrap gap-2 [&>button]:grow">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void payFull('CASH')}
          >
            <Banknote aria-hidden="true" />
            {t('workspace.checkout.payFullCash')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void payFull('QRIS')}
          >
            <QrCode aria-hidden="true" />
            {t('workspace.checkout.payFullQris')}
          </Button>
        </div>
        {rows.map((row, index) => (
          <div
            key={index}
            data-testid="allocation-row"
            className="grid grid-cols-[1fr_1fr_auto] items-start gap-1.5 rounded-md border border-border p-2"
          >
            <Select
              aria-label={`${t('workspace.checkout.method')} ${index + 1}`}
              className="h-9"
              value={row.method}
              onChange={(event) =>
                changeRows(
                  rows.map((r, i) =>
                    i === index
                      ? { ...r, method: event.target.value as PaymentMethod }
                      : r,
                  ),
                )
              }
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`workspace.paymentMethod.${method}`)}
                </option>
              ))}
            </Select>
            <NumericInput
              aria-label={`${t('workspace.checkout.amount')} ${index + 1}`}
              aria-invalid={rowErrors[index] ? true : undefined}
              autoComplete="off"
              className="tabular h-9"
              value={row.amount}
              onValueChange={(value) =>
                changeRows(
                  rows.map((r, i) =>
                    i === index ? { ...r, amount: value } : r,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`${t('workspace.checkout.removePayment')} ${index + 1}`}
              onClick={() => changeRows(rows.filter((_, i) => i !== index))}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
            <Input
              aria-label={`${t('workspace.checkout.reference')} ${index + 1}`}
              placeholder={t('workspace.checkout.reference')}
              autoComplete="off"
              maxLength={100}
              className="col-span-2 h-9"
              value={row.reference}
              onChange={(event) =>
                changeRows(
                  rows.map((r, i) =>
                    i === index ? { ...r, reference: event.target.value } : r,
                  ),
                )
              }
            />
            {rowErrors[index] ? (
              <p className="col-span-3 text-xs text-destructive">
                {t(rowErrors[index])}
              </p>
            ) : null}
          </div>
        ))}
        {rows.length < MAX_CHECKOUT_ALLOCATIONS ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              changeRows([
                ...rows,
                {
                  method: 'CASH',
                  amount:
                    BigInt(totals.unallocatedAmount) > 0n
                      ? totals.unallocatedAmount
                      : '',
                  reference: '',
                },
              ])
            }
          >
            <Plus aria-hidden="true" />
            {t('workspace.checkout.addPayment')}
          </Button>
        ) : null}
        <p className="tabular flex justify-between text-sm">
          <span className="text-muted-foreground">
            {t('workspace.checkout.unallocated')}
          </span>
          <span
            data-testid="unallocated-amount"
            className={unallocatedNegative ? 'text-destructive' : undefined}
          >
            {formatIdr(totals.unallocatedAmount)}
          </span>
        </p>
        {view.allocationsExceedAmount ? (
          <p
            role="alert"
            data-testid="allocations-exceed"
            className="rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm text-foreground"
          >
            {t('workspace.checkout.exceeds')}
          </p>
        ) : null}
      </section>

      <section
        aria-label={t('workspace.checkout.tender')}
        className="grid grid-cols-2 items-end gap-2"
      >
        <FormField label={t('workspace.checkout.tendered')}>
          <NumericInput
            autoComplete="off"
            className="tabular h-9"
            value={tendered}
            onValueChange={setTendered}
          />
        </FormField>
        <div className="flex flex-col gap-1.5 pb-2 text-right">
          <span className="text-sm text-muted-foreground">
            {change !== null && BigInt(change) < 0n
              ? t('workspace.checkout.short')
              : t('workspace.checkout.change')}
          </span>
          <span className="tabular font-semibold" data-testid="change-amount">
            {change === null
              ? '-'
              : formatIdr(
                  BigInt(change) < 0n ? (-BigInt(change)).toString() : change,
                )}
          </span>
        </div>
      </section>

      <Button onClick={onReview}>
        <ClipboardCheck aria-hidden="true" />
        {t('workspace.checkout.review')}
      </Button>
    </aside>
  );
}
