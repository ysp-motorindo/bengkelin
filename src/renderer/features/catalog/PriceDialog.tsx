import { useNumberFormat } from '@/renderer/lib/number-format';
import { ArrowLeft, Check, Eye, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
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
import {
  formatDisplayDateTime,
  toLocalInputValue,
} from '@/renderer/lib/date-format';

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
  const applyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (preview) applyRef.current?.focus();
  }, [preview]);

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
    <Dialog
      title={
        correcting
          ? t('catalog.dialog.correctTitle')
          : t('catalog.dialog.addTitle')
      }
      onClose={onClose}
      initialFocus={firstField}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" disabled={busy} onClick={onClose}>
              <X aria-hidden="true" />
              {t('catalog.dialog.cancel')}
            </Button>
          }
        >
          {preview === null ? (
            <Button type="submit" form="price-form" disabled={busy}>
              <Eye aria-hidden="true" />
              {t('catalog.dialog.preview')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                <ArrowLeft aria-hidden="true" />
                {t('catalog.dialog.back')}
              </Button>
              <Button
                ref={applyRef}
                disabled={busy || preview.conflicts.length > 0}
                onClick={apply}
              >
                <Check aria-hidden="true" />
                {t('catalog.dialog.apply')}
              </Button>
            </>
          )}
        </DialogActions>
      }
    >
      <p className="text-sm text-muted-foreground">
        {t('catalog.dialog.channel', { channel: channel.label })}
      </p>
      {error ? <Alert>{error}</Alert> : null}

      {preview === null ? (
        <form
          id="price-form"
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
            <NumericInput
              autoComplete="off"
              value={price}
              onValueChange={(value) => setPrice(value.trim())}
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
        </form>
      ) : (
        <PreviewStep preview={preview} timezone={timezone} />
      )}
    </Dialog>
  );
}

function PreviewStep({
  preview,
  timezone,
}: {
  preview: PricePreviewDto;
  timezone: string;
}) {
  const { numberOptions, formatIdr } = useNumberFormat();
  const { t } = useTranslation();
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
        <strong>
          {formatDisplayDateTime(preview.effectiveStartAt, timezone)}
        </strong>
      </p>
      <p data-testid="preview-current-to-new">
        {t('catalog.dialog.currentToNew', {
          ...numberOptions,
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
            start: formatDisplayDateTime(
              preview.corrects.effectiveStartAt,
              timezone,
            ),
          })}
        </p>
      ) : null}
      <p data-testid="preview-successor">
        {preview.successor
          ? t('catalog.dialog.successor', {
              price: formatIdr(preview.successor.price),
              start: formatDisplayDateTime(
                preview.successor.effectiveStartAt,
                timezone,
              ),
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
    </section>
  );
}
