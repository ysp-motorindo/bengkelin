import { Check, Clock3, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { toLocalInputValue } from '@/renderer/features/catalog/local-time';
import type { Instant, LocalDate } from '@/shared/primitives';
import { resolveLocalDateTime, type OffsetChoice } from '@/shared/time';
import { formatWithOffset, nowInstant, startOfShopDay } from './shop-time';

type Choice = 'startOfDay' | 'chooseTime' | 'keep';

interface PricingTimeDialogProps {
  timezone: string;
  currentPricingAt: Instant;
  /**
   * Present: the cashier set this earlier invoice date (backdating); offer
   * start of that day, a chosen time, or keeping the current pricingAt.
   * Absent: plain "change pricing time".
   */
  backdatedTo?: LocalDate;
  /** `pricingAt` null = keep the current one. */
  onConfirm(pricingAt: Instant | null): void;
  onClose(): void;
}

/**
 * Pricing date/time (Part A "Pricing context"): a shop-local wall time,
 * converted with resolveLocalDateTime; ambiguous (DST overlap) times ask for
 * the offset and nonexistent (DST gap) times are refused. Times are shown
 * with their UTC offset.
 */
export function PricingTimeDialog({
  timezone,
  currentPricingAt,
  backdatedTo,
  onConfirm,
  onClose,
}: PricingTimeDialogProps) {
  const { t } = useTranslation();
  const firstRef = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<Choice>(
    backdatedTo ? 'startOfDay' : 'chooseTime',
  );
  const [local, setLocal] = useState(() =>
    backdatedTo
      ? `${backdatedTo}T00:00`
      : toLocalInputValue(currentPricingAt, timezone).slice(0, 16),
  );
  const [offsetChoice, setOffsetChoice] = useState<OffsetChoice | null>(null);
  const [candidates, setCandidates] = useState<Instant[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function resolveChosen(): Instant | null {
    setProblem(null);
    let resolution;
    try {
      resolution = resolveLocalDateTime(
        local,
        timezone,
        offsetChoice ?? undefined,
      );
    } catch {
      setProblem(t('workspace.pricing.invalid'));
      return null;
    }
    if (resolution.kind === 'nonexistent') {
      setProblem(t('workspace.pricing.nonexistent'));
      return null;
    }
    if (resolution.kind === 'ambiguous') {
      setCandidates(resolution.candidates);
      setProblem(t('workspace.pricing.ambiguous'));
      return null;
    }
    return resolution.instant;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (choice === 'keep') {
      onConfirm(null);
      return;
    }
    if (choice === 'startOfDay' && backdatedTo) {
      onConfirm(startOfShopDay(backdatedTo, timezone));
      return;
    }
    const instant = resolveChosen();
    if (instant) onConfirm(instant);
  }

  const preview = (() => {
    try {
      const r = resolveLocalDateTime(
        local,
        timezone,
        offsetChoice ?? undefined,
      );
      return r.kind === 'ok' ? formatWithOffset(r.instant, timezone) : null;
    } catch {
      return null;
    }
  })();

  const timeField = (
    <FormField
      label={t('workspace.pricing.localTime', { zone: timezone })}
      hint={
        preview ? t('workspace.pricing.resolved', { time: preview }) : undefined
      }
    >
      <Input
        ref={firstRef}
        type="datetime-local"
        step={60}
        value={local}
        disabled={choice !== 'chooseTime'}
        onChange={(event) => {
          setLocal(event.target.value);
          setOffsetChoice(null);
          setCandidates(null);
          setProblem(null);
        }}
      />
    </FormField>
  );

  return (
    <Dialog
      title={
        backdatedTo
          ? t('workspace.pricing.backdateTitle')
          : t('workspace.pricing.title')
      }
      description={
        backdatedTo
          ? t('workspace.pricing.backdateDescription', { date: backdatedTo })
          : t('workspace.pricing.description')
      }
      onClose={onClose}
      initialFocus={backdatedTo ? undefined : firstRef}
      closeLabel={t('workspace.common.close')}
      footer={
        <div className="flex justify-between border-t border-border pt-3">
          <Button variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            {t('workspace.common.cancel')}
          </Button>
          <Button type="submit" form="pricing-time-form">
            <Check aria-hidden="true" />
            {t('workspace.pricing.apply')}
          </Button>
        </div>
      }
    >
      <form
        id="pricing-time-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        <p className="text-sm">
          {t('workspace.pricing.current')}:{' '}
          <span className="tabular font-medium">
            {formatWithOffset(currentPricingAt, timezone)}
          </span>
        </p>
        {backdatedTo ? (
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="sr-only">
              {t('workspace.pricing.backdateTitle')}
            </legend>
            {(['startOfDay', 'chooseTime', 'keep'] as const).map((value) => (
              <label key={value} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="pricing-choice"
                  className="mt-0.5"
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                />
                <span>
                  {t(`workspace.pricing.${value}`, {
                    date: backdatedTo,
                    time: formatWithOffset(
                      startOfShopDay(backdatedTo, timezone),
                      timezone,
                    ),
                  })}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {!backdatedTo || choice === 'chooseTime' ? timeField : null}
        {!backdatedTo ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLocal(
                  toLocalInputValue(nowInstant(), timezone).slice(0, 16),
                );
                setOffsetChoice(null);
                setCandidates(null);
              }}
            >
              <Clock3 aria-hidden="true" />
              {t('workspace.pricing.now')}
            </Button>
          </div>
        ) : null}
        {candidates ? (
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend>{t('workspace.pricing.ambiguous')}</legend>
            {(['earlier', 'later'] as const).map((which, index) => {
              const instant = candidates[index];
              return (
                <label key={which} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="offset-choice"
                    checked={offsetChoice === which}
                    onChange={() => {
                      setOffsetChoice(which);
                      setProblem(null);
                    }}
                  />
                  {instant ? formatWithOffset(instant, timezone) : which}
                </label>
              );
            })}
          </fieldset>
        ) : null}
        {problem ? <Alert>{problem}</Alert> : null}
        <p className="text-xs text-muted-foreground">
          {t('workspace.pricing.retainNote')}
        </p>
      </form>
    </Dialog>
  );
}
