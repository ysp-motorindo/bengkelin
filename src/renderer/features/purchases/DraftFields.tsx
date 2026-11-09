import { useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Input, controlClass } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { useSyncedValue } from '@/renderer/features/workspace/synced-field';
import { formatBpsAsPercentage } from '@/shared/percentage';
import { parseStageTexts } from '@/renderer/features/workspace/discount-inputs';
import type { PurchaseDraftOperation } from '@/shared/contracts';
import type { usePurchaseDraft } from './use-purchase-draft';
export type PurchaseCommands = ReturnType<typeof usePurchaseDraft>;
export function DraftField({
  commands,
  field,
  label,
  value,
  numeric = false,
  decimal = false,
  type = 'text',
  parse,
  disabled = false,
  compact = false,
  multiline = false,
}: {
  commands: PurchaseCommands;
  field: string;
  label: string;
  value: string;
  numeric?: boolean;
  decimal?: boolean;
  type?: string;
  parse: (v: string) => PurchaseDraftOperation | null;
  disabled?: boolean;
  compact?: boolean;
  multiline?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useSyncedValue(value, () => commands.dirty(field));
  useEffect(
    () => () => commands.cancelPending(field),
    [commands.cancelPending, field],
  );
  const valid = parse(text) !== null;
  const change = (next: string) => {
    setText(next);
    const op = parse(next);
    commands.invalid(field, op === null);
    if (op) {
      if (compact) commands.stage(field, op);
      else commands.edit(field, op);
    }
  };
  if (compact)
    return (
      <div>
        <NumericInput
          value={text}
          onValueChange={change}
          decimal={decimal}
          disabled={disabled}
          className="h-8 rounded-sm border-transparent bg-amber-50 px-1.5 text-right text-xs shadow-none focus-visible:border-amber-600 dark:bg-amber-950/40"
          onBlur={() => void commands.flush()}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              commands.cancelPending(field);
              setText(value);
            }
          }}
          aria-label={label}
          aria-invalid={!valid}
        />
        {!valid ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {t('validation.invalid')}
          </p>
        ) : null}
      </div>
    );
  return (
    <FormField label={label} error={valid ? undefined : 'validation.invalid'}>
      {multiline ? (
        <textarea
          rows={4}
          maxLength={1000}
          value={text}
          onChange={(e) => change(e.target.value)}
          disabled={disabled}
          className={`${controlClass} h-auto min-h-24 resize-y font-normal`}
        />
      ) : numeric ? (
        <NumericInput
          value={text}
          onValueChange={change}
          decimal={decimal}
          disabled={disabled}
        />
      ) : (
        <Input
          type={type}
          value={text}
          onChange={(e) => change(e.target.value)}
          disabled={disabled}
        />
      )}
    </FormField>
  );
}
export function DraftDiscounts({
  commands,
  lineId,
  stages,
  cells = false,
}: {
  commands: PurchaseCommands;
  lineId: string | null;
  stages: number[];
  cells?: boolean;
}) {
  const { t } = useTranslation();
  const key = 'discounts:' + lineId;
  const [texts, setTexts] = useSyncedValue(
    Array.from({ length: 4 }, (_, i) =>
      stages[i] === undefined ? '' : formatBpsAsPercentage(stages[i]!),
    ),
    () => commands.dirty(key),
    JSON.stringify(stages),
  );
  const parsed = parseStageTexts(texts);
  useEffect(
    () => () => commands.cancelPending(key),
    [commands.cancelPending, key],
  );
  if (cells)
    return (
      <>
        {texts.map((text, i) => (
          <td key={i}>
            <NumericInput
              decimal
              value={text}
              aria-label={t('purchases.stage', { n: i + 1 }) + ' ' + lineId}
              aria-invalid={!parsed.ok && parsed.index === i}
              className="h-8 rounded-sm border-transparent bg-amber-50 px-1.5 text-right text-xs dark:bg-amber-950/40"
              onBlur={() => void commands.flush()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  commands.cancelPending(key);
                  setTexts(
                    Array.from({ length: 4 }, (_, j) =>
                      stages[j] === undefined
                        ? ''
                        : formatBpsAsPercentage(stages[j]!),
                    ),
                  );
                }
              }}
              onValueChange={(v) => {
                const next = [...texts];
                next[i] = v;
                setTexts(next);
                const p = parseStageTexts(next);
                commands.invalid(key, !p.ok);
                if (p.ok)
                  commands.stage(key, {
                    kind: 'setDiscounts',
                    lineId,
                    stages: p.stages,
                  });
              }}
            />
            {!parsed.ok && parsed.index === i ? (
              <p role="alert">{t('validation.invalid')}</p>
            ) : null}
          </td>
        ))}
      </>
    );
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium">
        {t('purchases.discounts')}
      </legend>
      <div className="grid grid-cols-4 gap-2">
        {texts.map((text, i) => (
          <FormField
            key={i}
            label={t('purchases.stage', { n: i + 1 })}
            error={
              !parsed.ok && parsed.index === i
                ? 'validation.invalid'
                : undefined
            }
          >
            <NumericInput
              decimal
              value={text}
              onValueChange={(v) => {
                const next = [...texts];
                next[i] = v;
                setTexts(next);
                const p = parseStageTexts(next);
                commands.invalid(key, !p.ok);
                if (p.ok)
                  commands.edit(key, {
                    kind: 'setDiscounts',
                    lineId,
                    stages: p.stages,
                  });
              }}
            />
          </FormField>
        ))}
      </div>
    </fieldset>
  );
}
