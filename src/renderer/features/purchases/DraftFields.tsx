import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Input } from '@/renderer/components/ui/input';
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
}) {
  const { t } = useTranslation();
  const [text, setText] = useSyncedValue(value, () => commands.dirty(field));
  useEffect(
    () => () => commands.invalid(field, false),
    [commands.invalid, field],
  );
  const valid = parse(text) !== null;
  const change = (next: string) => {
    setText(next);
    const op = parse(next);
    commands.invalid(field, op === null);
    if (op) commands.edit(field, op);
  };
  if (compact)
    return (
      <div>
        <NumericInput
          value={text}
          onValueChange={change}
          decimal={decimal}
          disabled={disabled}
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
      {numeric ? (
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
}: {
  commands: PurchaseCommands;
  lineId: string | null;
  stages: number[];
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
  useEffect(() => () => commands.invalid(key, false), [commands.invalid, key]);
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
