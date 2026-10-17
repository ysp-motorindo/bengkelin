import { Check, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import { formatIdr, parseRupiahInput } from '@/renderer/lib/money';
import {
  MAX_LINE_QUANTITY,
  type DraftLineDto,
  type DraftOperation,
  type DraftView,
  type ReferenceDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { parseStageTexts, sameStages, stagesToTexts } from './discount-inputs';

interface ItemEditorDialogProps {
  line: DraftLineDto;
  mechanics: ReferenceDto[];
  send(op: DraftOperation): Promise<Result<DraftView>>;
  onClose(): void;
  /** Focus goes back to the scanner field. */
  returnFocus(): void;
}

type FieldErrors = Partial<
  Record<'quantity' | 'unitPrice' | 'title' | `discount${number}`, string>
>;

/**
 * Focused line editor (spec 50): quantity, selling price override with an
 * optional reason, Discount 1-4, mechanic (service lines only) and title
 * (custom lines only). One submission sends at most two commands in order:
 * updateLine, then setLineDiscounts.
 */
export function ItemEditorDialog({
  line,
  mechanics,
  send,
  onClose,
  returnFocus,
}: ItemEditorDialogProps) {
  const { t, i18n } = useTranslation();
  const separator = i18n.language === 'en' ? '.' : ',';
  const quantityRef = useRef<HTMLInputElement>(null);
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [unitPrice, setUnitPrice] = useState(line.unitPrice);
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState(line.title);
  const [mechanicId, setMechanicId] = useState(line.mechanicId ?? '');
  const [discounts, setDiscounts] = useState(() =>
    stagesToTexts(line.discounts, separator),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isService = line.itemType === 'SERVICE';
  const isCustom = line.source === 'CUSTOM';
  // Keep the selected mechanic listed even if it was deactivated since.
  const mechanicOptions =
    line.mechanicId && !mechanics.some((m) => m.id === line.mechanicId)
      ? [
          ...mechanics,
          {
            id: line.mechanicId,
            label: line.mechanicName ?? '',
          } as ReferenceDto,
        ]
      : mechanics;

  function validate() {
    const next: FieldErrors = {};
    const qty = /^\d+$/.test(quantity.trim())
      ? Number.parseInt(quantity.trim(), 10)
      : Number.NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QUANTITY) {
      next.quantity = 'workspace.validation.quantity';
    }
    const price = parseRupiahInput(unitPrice);
    if (price === null) next.unitPrice = 'workspace.validation.money';
    if (isCustom && !title.trim()) next.title = 'validation.required';
    const parsed = parseStageTexts(discounts);
    if (!parsed.ok) {
      next[`discount${parsed.index + 1}`] =
        parsed.reason === 'gap'
          ? 'workspace.validation.discountGap'
          : 'workspace.validation.percentage';
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || price === null || !parsed.ok) {
      return null;
    }
    return { qty, price, stages: parsed.stages };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const values = validate();
    if (!values) return;
    const update: Extract<DraftOperation, { kind: 'updateLine' }> = {
      kind: 'updateLine',
      lineId: line.id,
    };
    if (values.qty !== line.quantity) update.quantity = values.qty;
    if (values.price !== line.unitPrice) {
      update.unitPrice = values.price;
      if (reason.trim()) update.reason = reason.trim();
    }
    if (isService && (mechanicId || null) !== line.mechanicId) {
      update.mechanicId = mechanicId || null;
    }
    if (isCustom && title.trim() !== line.title) update.title = title.trim();

    const ops: DraftOperation[] = [];
    if (Object.keys(update).length > 2) ops.push(update);
    if (!sameStages(values.stages, line.discounts)) {
      ops.push({
        kind: 'setLineDiscounts',
        lineId: line.id,
        stages: values.stages,
      });
    }
    setBusy(true);
    setFormError(null);
    try {
      for (const op of ops) {
        const result = await send(op);
        if (!result.ok) {
          setErrors(mapFieldErrors(result.error.fieldErrors));
          setFormError(errorMessage(t, result.error));
          return;
        }
      }
      onClose();
    } catch {
      setFormError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  const listed = line.listedUnitPrice;
  return (
    <Dialog
      title={t('workspace.editor.title')}
      description={line.title}
      onClose={onClose}
      initialFocus={quantityRef}
      returnFocus={returnFocus}
      closeLabel={t('workspace.common.close')}
      footer={
        <div className="flex justify-between">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
            {t('workspace.common.cancel')}
          </Button>
          <Button type="submit" form="item-editor-form" disabled={busy}>
            <Check aria-hidden="true" />
            {t('workspace.editor.save')}
          </Button>
        </div>
      }
    >
      <form
        id="item-editor-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t('workspace.editor.quantity')}
            error={errors.quantity}
          >
            <Input
              ref={quantityRef}
              type="number"
              autoComplete="off"
              className="tabular"
              value={quantity}
              onFocus={(event) => event.target.select()}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </FormField>
          {isCustom ? (
            <FormField
              label={t('workspace.editor.itemTitle')}
              error={errors.title}
            >
              <Input
                autoComplete="off"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </FormField>
          ) : null}
          <FormField
            label={t('workspace.editor.unitPrice')}
            error={errors.unitPrice}
            hint={
              listed
                ? t('workspace.editor.listed', { price: formatIdr(listed) })
                : undefined
            }
          >
            <Input
              type="number"
              autoComplete="off"
              className="tabular"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
            />
          </FormField>
          <FormField label={t('workspace.editor.reason')}>
            <Input
              autoComplete="off"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </div>

        <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <legend className="mb-1 text-sm font-medium">
            {t('workspace.editor.discounts')}
          </legend>
          {discounts.map((value, index) => (
            <FormField
              key={index}
              label={t(`workspace.editor.discount${index + 1}`)}
              error={errors[`discount${index + 1}`]}
              hint={
                line.discounts[index]
                  ? `-${formatIdr(line.discounts[index].amount)}`
                  : undefined
              }
            >
              <Input
                type="number" step="any"
                autoComplete="off"
                className="tabular"
                value={value}
                onChange={(event) =>
                  setDiscounts((current) =>
                    current.map((text, i) =>
                      i === index ? event.target.value : text,
                    ),
                  )
                }
              />
            </FormField>
          ))}
        </fieldset>

        {isService ? (
          <FormField label={t('workspace.editor.mechanic')}>
            <Select
              value={mechanicId}
              onChange={(event) => setMechanicId(event.target.value)}
            >
              <option value="">{t('workspace.editor.noMechanic')}</option>
              {mechanicOptions.map((mechanic) => (
                <option key={mechanic.id} value={mechanic.id}>
                  {mechanic.label}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}

        {line.priceChanges.length > 0 ? (
          <section aria-label={t('workspace.editor.history')}>
            <h3 className="text-sm font-medium">
              {t('workspace.editor.history')}
            </h3>
            <ul className="tabular mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {line.priceChanges.map((change) => (
                <li key={change.id}>
                  {change.previousPrice
                    ? formatIdr(change.previousPrice)
                    : t('workspace.editor.noPrice')}{' '}
                  → {formatIdr(change.newPrice)} ·{' '}
                  {t(`workspace.priceChange.${change.kind}`)} ·{' '}
                  {change.changedBy.displayName}
                  {change.reason ? ` · ${change.reason}` : ''}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </form>
    </Dialog>
  );
}

function mapFieldErrors(
  fieldErrors: Record<string, string> | undefined,
): FieldErrors {
  const out: FieldErrors = {};
  if (!fieldErrors) return out;
  for (const [path, key] of Object.entries(fieldErrors)) {
    if (path.endsWith('quantity')) out.quantity = key;
    else if (path.endsWith('unitPrice')) out.unitPrice = key;
    else if (path.endsWith('title')) out.title = key;
  }
  return out;
}
