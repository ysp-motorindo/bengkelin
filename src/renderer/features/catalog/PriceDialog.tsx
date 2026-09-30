import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import type {
  AppliedPriceChangeDto,
  PricePointDto,
  PricePreviewDto,
  ReferenceDto,
} from '@/shared/contracts';
import {
  toInstant,
  resolveLocalDateTime,
  type OffsetChoice,
} from '@/shared/time';
import { formatIdr, formatLocal, toLocalInputValue } from './local-time';

interface PriceDialogProps {
  catalogItemId: string;
  channel: ReferenceDto;
  timezone: string;
  /** Present: correct this revision. Absent: add an ordinary price point. */
  target?: PricePointDto | undefined;
  /** Prefilled price (for "schedule restore"). */
  defaultPrice?: string | undefined;
  onClose(): void;
  onApplied(applied: AppliedPriceChangeDto, preview: PricePreviewDto): void;
}

type StartProblem = 'invalidStart' | 'nonexistent' | 'ambiguous' | null;

/**
 * Add a price point, or correct a revision. Two steps: enter, then a preview
 * (price at that start -> new price, next scheduled successor, past/future,
 * conflicts) that must be explicitly applied. No end time is ever asked for.
 */
export function PriceDialog({
  catalogItemId,
  channel,
  timezone,
  target,
  defaultPrice,
  onClose,
  onApplied,
}: PriceDialogProps) {
  const { t } = useTranslation();
  const correcting = target !== undefined;
  const [start, setStart] = useState(() =>
    toLocalInputValue(
      target ? target.effectiveStartAt : toInstant(Date.now()),
      timezone,
    ).slice(0, 19),
  );
  const [price, setPrice] = useState(defaultPrice ?? target?.price ?? '');
  const [reason, setReason] = useState('');
  const [choice, setChoice] = useState<OffsetChoice | ''>('');
  const [problem, setProblem] = useState<StartProblem>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [preview, setPreview] = useState<PricePreviewDto | null>(null);
  const { busy, error, fieldErrors, run, check } = useAction();
  const firstField = useRef<HTMLInputElement>(null);
  const titleId = 'price-dialog-title';

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  function resolveStart(): string | null {
    setProblem(null);
    let resolution;
    try {
      resolution = resolveLocalDateTime(
        start,
        timezone,
        choice === '' ? undefined : choice,
      );
    } catch {
      setProblem('invalidStart');
      return null;
    }
    if (resolution.kind === 'nonexistent') {
      setProblem('nonexistent');
      return null;
    }
    if (resolution.kind === 'ambiguous') {
      setCandidates(resolution.candidates);
      setProblem('ambiguous');
      return null;
    }
    return resolution.instant;
  }

  function submitForm(event: FormEvent) {
    event.preventDefault();
    const instant = resolveStart();
    if (instant === null) return;
    void run(async () => {
      const result = await window.bengkelin.catalog.previewPriceChange({
        catalogItemId,
        channelId: channel.id,
        effectiveStartAt: instant,
        price,
        ...(target ? { correctsPriceId: target.id, reason } : {}),
      });
      if (check(result)) setPreview(result.value);
    });
  }

  function apply() {
    if (!preview) return;
    void run(async () => {
      const result = await window.bengkelin.catalog.applyPriceChange({
        token: preview.token,
      });
      if (check(result)) onApplied(result.value, preview);
    });
  }

  const startProblem =
    problem === 'invalidStart' || problem === 'nonexistent'
      ? t(`catalog.dialog.${problem}`)
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        className="flex max-h-full w-full max-w-lg flex-col gap-3 overflow-auto rounded-lg border border-border bg-card p-5 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {correcting
            ? t('catalog.dialog.correctTitle')
            : t('catalog.dialog.addTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('catalog.dialog.channel', { channel: channel.label })}
        </p>
        {error ? <Alert>{error}</Alert> : null}

        {preview === null ? (
          <form
            onSubmit={submitForm}
            noValidate
            className="flex flex-col gap-3"
          >
            <FormField
              label={t('catalog.dialog.start', { zone: timezone })}
              error={
                startProblem
                  ? undefined
                  : (fieldErrors.effectiveStartAt ?? undefined)
              }
              hint={startProblem ?? undefined}
            >
              <Input
                ref={firstField}
                type="datetime-local"
                step={1}
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                  setChoice('');
                  setProblem(null);
                }}
              />
            </FormField>
            {problem === 'ambiguous' ? (
              <fieldset className="flex flex-col gap-1 text-sm">
                <legend>{t('catalog.dialog.ambiguous')}</legend>
                {(['earlier', 'later'] as const).map((which, index) => (
                  <label key={which} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="offset-choice"
                      checked={choice === which}
                      onChange={() => {
                        setChoice(which);
                        setProblem(null);
                      }}
                    />
                    {t(`catalog.dialog.${which}`, {
                      time: (candidates[index] ?? '')
                        .replace('T', ' ')
                        .slice(0, 19),
                    })}
                  </label>
                ))}
              </fieldset>
            ) : null}
            <FormField
              label={t('catalog.dialog.price')}
              error={fieldErrors.price}
            >
              <Input
                inputMode="numeric"
                autoComplete="off"
                value={price}
                onChange={(event) => setPrice(event.target.value.trim())}
              />
            </FormField>
            {correcting ? (
              <FormField
                label={t('catalog.dialog.reason')}
                error={fieldErrors.reason}
              >
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </FormField>
            ) : null}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('catalog.dialog.preview')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {t('catalog.dialog.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <PreviewStep
            preview={preview}
            timezone={timezone}
            busy={busy}
            onApply={apply}
            onBack={() => setPreview(null)}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}

function PreviewStep({
  preview,
  timezone,
  busy,
  onApply,
  onBack,
  onCancel,
}: {
  preview: PricePreviewDto;
  timezone: string;
  busy: boolean;
  onApply(): void;
  onBack(): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const applyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    applyRef.current?.focus();
  }, []);
  const conflict = preview.conflicts.length > 0;
  return (
    <section
      aria-label={t('catalog.dialog.previewTitle')}
      data-testid="price-preview"
      className="flex flex-col gap-2 text-sm"
    >
      <h3 className="font-medium">{t('catalog.dialog.previewTitle')}</h3>
      <p>
        {t('catalog.pricing.start')}:{' '}
        <strong>{formatLocal(preview.effectiveStartAt, timezone)}</strong>
      </p>
      <p data-testid="preview-current-to-new">
        {t('catalog.dialog.currentToNew', {
          current: preview.current
            ? formatIdr(preview.current.price)
            : t('catalog.dialog.noCurrent'),
          next: formatIdr(preview.price),
        })}
      </p>
      {preview.corrects ? (
        <p>
          {t('catalog.dialog.corrects', {
            price: formatIdr(preview.corrects.price),
            start: formatLocal(preview.corrects.effectiveStartAt, timezone),
          })}
        </p>
      ) : null}
      <p data-testid="preview-successor">
        {preview.successor
          ? t('catalog.dialog.successor', {
              price: formatIdr(preview.successor.price),
              start: formatLocal(preview.successor.effectiveStartAt, timezone),
            })
          : t('catalog.dialog.noSuccessor')}
      </p>
      <p className="text-muted-foreground">
        {preview.timing === 'PAST'
          ? t('catalog.dialog.timingPast')
          : t('catalog.dialog.timingFuture')}
      </p>
      {conflict ? (
        <Alert data-testid="preview-conflict">
          {t('catalog.dialog.conflict')}
        </Alert>
      ) : null}
      <div className="flex gap-2 pt-1">
        <Button ref={applyRef} disabled={busy || conflict} onClick={onApply}>
          {t('catalog.dialog.apply')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onBack}>
          {t('catalog.dialog.back')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {t('catalog.dialog.cancel')}
        </Button>
      </div>
    </section>
  );
}
