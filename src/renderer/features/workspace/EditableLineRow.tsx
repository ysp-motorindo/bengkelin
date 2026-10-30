import { useEffect, useId, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Select } from '@/renderer/components/ui/select';
import { IconButton } from '@/renderer/components/ui/button';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { parseRupiahInput } from '@/renderer/lib/money';
import {
  MAX_LINE_QUANTITY,
  type DraftLineDto,
  type DraftOperation,
  type ReferenceDto,
} from '@/shared/contracts';
import { parseStageTexts, stagesToTexts } from './discount-inputs';
import { useSyncedValue } from './synced-field';
import type { DraftCommands } from './use-draft-commands';

interface Props {
  line: DraftLineDto;
  commands: DraftCommands;
  mechanics: ReferenceDto[];
  onRemove(line: DraftLineDto): boolean | Promise<boolean>;
}
const fields = [
  'quantity',
  'unitPrice',
  'title',
  'discounts',
  'mechanicId',
] as const;
export const transactionCellClass =
  'h-8 rounded-sm border-transparent bg-amber-50 px-1.5 text-xs shadow-none focus-visible:border-amber-600 dark:bg-amber-950/40';

export function EditableLineRow({
  line,
  commands,
  mechanics,
  onRemove,
}: Props) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const detailId = useId();
  const [removing, setRemoving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = (field: string) => `line:${line.id}:${field}`;
  const server = {
    quantity: String(line.quantity),
    unitPrice: line.unitPrice,
    title: line.title,
    discounts: stagesToTexts(line.discounts, '.'),
    mechanicId: line.mechanicId ?? '',
  };
  const [values, setValues] = useSyncedValue(
    server,
    () => fields.some((field) => commands.isDirty(key(field))),
    JSON.stringify(server),
  );
  const { cancelPending } = commands;
  useEffect(
    () => () => {
      for (const field of fields) cancelPending(`line:${line.id}:${field}`);
    },
    [line.id, cancelPending],
  );

  function stage(field: string, op: DraftOperation | null, error: string) {
    setErrors((old) => {
      const next = { ...old };
      if (op) delete next[field];
      else next[field] = t(error);
      return next;
    });
    if (op) commands.stage(key(field), op);
    else commands.markInvalid(key(field), true);
  }
  function change(
    field: 'quantity' | 'unitPrice' | 'title' | 'mechanicId',
    text: string,
  ) {
    setValues({ ...values, [field]: text });
    const op: Extract<DraftOperation, { kind: 'updateLine' }> = {
      kind: 'updateLine',
      lineId: line.id,
    };
    let valid = true;
    let error = 'validation.required';
    if (field === 'quantity') {
      const number = Number(text);
      valid = /^\d+$/.test(text) && number >= 1 && number <= MAX_LINE_QUANTITY;
      op.quantity = number;
      error = 'workspace.validation.quantity';
    }
    if (field === 'unitPrice') {
      const price = parseRupiahInput(text);
      valid = price !== null;
      if (price !== null) op.unitPrice = price;
      error = 'workspace.validation.money';
    }
    if (field === 'title') {
      valid = !!text.trim() && text.trim().length <= 200;
      op.title = text.trim();
    }
    if (field === 'mechanicId') op.mechanicId = text || null;
    stage(field, valid ? op : null, error);
  }
  function changeDiscount(index: number, text: string) {
    const discounts = values.discounts.map((value, i) =>
      i === index ? text : value,
    );
    setValues({ ...values, discounts });
    const parsed = parseStageTexts(discounts);
    stage(
      'discounts',
      parsed.ok
        ? { kind: 'setLineDiscounts', lineId: line.id, stages: parsed.stages }
        : null,
      !parsed.ok && parsed.reason === 'gap'
        ? 'workspace.validation.discountGap'
        : 'workspace.validation.percentage',
    );
  }
  function escape(field: (typeof fields)[number]) {
    commands.cancelPending(key(field));
    setValues({ ...values, [field]: server[field] });
    setErrors((old) => {
      const next = { ...old };
      delete next[field];
      return next;
    });
  }
  const common = (field: (typeof fields)[number], label: string) => ({
    'aria-label': `${label}: ${line.title}`,
    'aria-invalid': !!errors[field],
    'aria-describedby': errors[field] ? `${detailId}-${field}` : undefined,
    className: transactionCellClass,
    onBlur: () => {
      void commands.flush();
    },
    onKeyDown: (
      event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    ) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escape(field);
      }
    },
  });
  const options =
    line.mechanicId && !mechanics.some((m) => m.id === line.mechanicId)
      ? [...mechanics, { id: line.mechanicId, label: line.mechanicName ?? '' }]
      : mechanics;
  return (
    <>
      <tr
        data-testid="line-row"
        data-line-id={line.id}
        inert={removing}
        className="border-t border-border text-xs [&>td]:px-1 [&>td]:py-1"
      >
        <td className="text-right text-muted-foreground">{line.position}</td>
        <td className="min-w-48">
          {line.source === 'CUSTOM' ? (
            <Input
              {...common('title', t('workspace.editor.itemTitle'))}
              value={values.title}
              onChange={(e) => change('title', e.target.value)}
            />
          ) : (
            <span data-testid="line-title" className="font-medium">
              {line.title}
            </span>
          )}
        </td>
        <td>{line.unitLabel ?? '—'}</td>
        <td>
          <NumericInput
            {...common('quantity', t('workspace.editor.quantity'))}
            data-testid="line-quantity"
            value={values.quantity}
            onValueChange={(text) => change('quantity', text)}
          />
        </td>
        <td>
          <NumericInput
            {...common('unitPrice', t('workspace.editor.unitPrice'))}
            data-price-input
            value={values.unitPrice}
            onValueChange={(text) => change('unitPrice', text)}
          />
        </td>
        {values.discounts.map((text, index) => (
          <td key={index}>
            <NumericInput
              {...common(
                'discounts',
                t(`workspace.editor.discount${index + 1}`),
              )}
              decimal
              value={text}
              onValueChange={(value) => changeDiscount(index, value)}
            />
          </td>
        ))}
        <td
          data-testid="line-amount"
          className="whitespace-nowrap text-right font-semibold"
        >
          {formatIdr(line.amount)}
        </td>
        <td className="whitespace-nowrap">
          <IconButton
            destructive
            type="button"
            label={`${t('workspace.lines.remove')}: ${line.title}`}
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              try {
                if (await onRemove(line))
                  for (const field of fields)
                    commands.cancelPending(key(field));
              } finally {
                setRemoving(false);
              }
            }}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        </td>
      </tr>
      {
        <tr>
          <td
            colSpan={11}
            className="border-t border-border bg-sunken px-3 py-2"
          >
            {Object.entries(errors).map(([field, error]) => (
              <p
                role="alert"
                id={`${detailId}-${field}`}
                key={field}
                className="text-xs text-destructive"
              >
                {error}
              </p>
            ))}
            {
              <div
                id={detailId}
                className="flex flex-wrap items-start gap-3 text-xs"
              >
                {line.source === 'CUSTOM' && (
                  <span className="sr-only">{line.title}</span>
                )}
                {line.mechanicName && (
                  <span
                    data-testid="indicator-mechanic"
                    className="text-[10px] text-muted-foreground"
                  >
                    {line.mechanicName}
                  </span>
                )}
                {line.pricing.manualPriceOverride && (
                  <span data-testid="indicator-override" className="sr-only">
                    {t('workspace.indicators.override')}
                  </span>
                )}
                {line.priceChanges.some(
                  (change) => change.kind === 'MISSING_PRICE_ENTRY',
                ) && (
                  <span
                    data-testid="indicator-missing-price"
                    className="text-[10px] text-warning"
                  >
                    {t('workspace.indicators.missingPrice')}
                  </span>
                )}
                <div className="text-[10px] text-muted-foreground">
                  {t(`workspace.itemType.${line.itemType}`)}
                  {line.pricing.manualPriceOverride
                    ? ` · ${t('workspace.indicators.override')}`
                    : ''}
                  {line.pricing.listedPriceDiffersFromCurrent
                    ? ` · ${t('workspace.indicators.differs', { price: line.pricing.currentListedPrice ? formatIdr(line.pricing.currentListedPrice) : '—' })}`
                    : ''}
                </div>
                {line.itemType === 'SERVICE' && (
                  <label>
                    {t('workspace.editor.mechanic')}
                    <Select
                      {...common('mechanicId', t('workspace.editor.mechanic'))}
                      value={values.mechanicId}
                      onChange={(e) => change('mechanicId', e.target.value)}
                    >
                      <option value="">
                        {t('workspace.editor.noMechanic')}
                      </option>
                      {options.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <span>
                  {t('workspace.editor.listed', {
                    price: line.listedUnitPrice
                      ? formatIdr(line.listedUnitPrice)
                      : t('workspace.editor.noPrice'),
                  })}
                </span>
                <ul aria-label={t('workspace.editor.history')}>
                  {line.priceChanges.map((change) => (
                    <li key={change.id}>
                      {change.previousPrice
                        ? formatIdr(change.previousPrice)
                        : '—'}{' '}
                      → {formatIdr(change.newPrice)} ·{' '}
                      {t(`workspace.priceChange.${change.kind}`)} ·{' '}
                      {change.changedBy.displayName}
                      {change.reason ? ` · ${change.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            }
          </td>
        </tr>
      }
    </>
  );
}
