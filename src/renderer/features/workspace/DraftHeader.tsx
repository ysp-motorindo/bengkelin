import { CalendarClock, TriangleAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Button, IconButton } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Label } from '@/renderer/components/ui/label';
import { Select } from '@/renderer/components/ui/select';
import { customerLabel } from '@/renderer/features/customers/labels';
import { errorMessage } from '@/renderer/lib/errors';
import {
  MAX_TOP_DAYS,
  isLocalDate,
  type DraftOperation,
  type ReferenceDto,
} from '@/shared/contracts';
import type { Instant, LocalDate } from '@/shared/primitives';
import type { Result } from '@/shared/primitives';
import { CustomerVehicleDialog } from './CustomerVehicleDialog';
import { OwnershipDialog } from './OwnershipDialog';
import { PricingTimeDialog } from './PricingTimeDialog';
import {
  formatDisplayDate,
  formatDisplayDateTime,
} from '@/renderer/lib/date-format';
import { todayInShop } from './shop-time';
import { useSyncedValue } from './synced-field';
import type { DraftCommands } from './use-draft-commands';

interface DraftHeaderProps {
  commands: DraftCommands;
  sales: ReferenceDto[];
  expeditions: ReferenceDto[];
  channels: ReferenceDto[];
  timezone: string;
  onError(message: string | null): void;
}

type Pending =
  | { kind: 'pricing' }
  | { kind: 'backdate'; date: LocalDate }
  | { kind: 'party' }
  | { kind: 'ownership' }
  | null;

/** Parses an optional non-negative integer field; undefined = invalid. */
function parseCount(text: string, max: number): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return value <= max ? value : undefined;
}

/**
 * Draft header (spec 49): channel, invoice date, pricing time (with offset),
 * customer and vehicle (with the owner-mismatch warning), odometer, TOP and
 * the computed due date, and a note. Odometer, TOP and note are free text:
 * debounced saves; the local value wins while unsent.
 */
export function DraftHeader({
  commands,
  channels,
  sales,
  expeditions,
  timezone,
  onError,
}: DraftHeaderProps) {
  const { t } = useTranslation();
  const { view, send, edit, isDirty, markInvalid } = commands;
  const [pending, setPending] = useState<Pending>(null);
  const [date, setDate] = useState(view.invoiceDate);
  const [dateKey, setDateKey] = useState(view.invoiceDate);
  if (dateKey !== view.invoiceDate) {
    // Server moved on (own save or reload): follow it.
    setDateKey(view.invoiceDate);
    setDate(view.invoiceDate);
  }
  const [odometer, setOdometer] = useSyncedValue(
    view.odometerKm === null ? '' : String(view.odometerKm),
    () => isDirty('odometer'),
  );
  const [topDays, setTopDays] = useSyncedValue(String(view.topDays), () =>
    isDirty('topDays'),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function apply(op: DraftOperation): Promise<boolean> {
    const result = await send(op);
    if (result.ok) {
      onError(null);
      return true;
    }
    if (result.error.code !== 'QUEUE_CLOSED') {
      onError(errorMessage(t, result.error));
    }
    return false;
  }

  function commitDate() {
    if (date === view.invoiceDate) return;
    if (!isLocalDate(date)) {
      setDate(view.invoiceDate);
      return;
    }
    if (date < todayInShop(timezone)) {
      setPending({ kind: 'backdate', date });
      return;
    }
    void apply({ kind: 'updateHeader', changes: { invoiceDate: date } });
  }

  function confirmPricing(pricingAt: Instant | null) {
    const current = pending;
    setPending(null);
    if (current?.kind === 'backdate') {
      void apply({
        kind: 'updateHeader',
        changes: {
          invoiceDate: current.date,
          ...(pricingAt ? { pricingAt } : {}),
        },
      });
    } else if (pricingAt && pricingAt !== view.pricingAt) {
      void apply({ kind: 'updateHeader', changes: { pricingAt } });
    }
  }

  function textField(
    key: 'odometer' | 'topDays',
    value: string,
    max: number,
    build: (parsed: number) => DraftOperation,
    clear?: DraftOperation,
  ) {
    const parsed = parseCount(value, max);
    if (parsed === undefined || (parsed === null && !clear)) {
      setFieldErrors((current) => ({
        ...current,
        [key]: 'workspace.validation.wholeNumber',
      }));
      // Never "Saved" while the typed value is invalid (and unsent).
      markInvalid(key, true);
      return;
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    edit(key, parsed === null ? clear! : build(parsed));
  }

  const channelMissing =
    channels.length > 0 && !channels.some((c) => c.id === view.channelId);
  const customer = view.customer
    ? customerLabel(t, view.customer)
    : t('workspace.header.anonymous');
  const vehicle = view.vehicle
    ? [view.vehicle.plateNumber, view.vehicle.description]
        .filter(Boolean)
        .join(' · ')
    : t('workspace.header.noVehicle');

  return (
    <section
      aria-label={t('workspace.header.label')}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 [&_input]:h-8 [&_select]:h-8 [&_input]:text-xs [&_select]:text-xs [&_label]:text-xs"
    >
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(22rem,0.85fr)_minmax(0,1.15fr)]">
        <div className="grid gap-2">
          <div className="grid grid-cols-4 gap-2">
            <div className="w-full col-span-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex min-h-5 items-center">
                  <Label htmlFor="header-customer-vehicle">
                    {t('workspace.header.customerVehicle')}
                  </Label>
                </div>
                <div className="relative">
                  <Input
                    id="header-customer-vehicle"
                    className="w-full pr-12"
                    readOnly
                    value={`${customer} · ${vehicle}`}
                    title={`${customer} · ${vehicle}`}
                  />
                  <span
                    data-testid="header-customer"
                    className="sr-only"
                    aria-hidden="true"
                  >
                    {customer}
                  </span>
                  <span
                    data-testid="header-vehicle"
                    className="sr-only"
                    aria-hidden="true"
                  >
                    {vehicle}
                  </span>
                  <IconButton
                    variant="input-action"
                    size="default"
                    className="absolute right-0 top-0"
                    label={t('workspace.header.chooseParty')}
                    onClick={() => setPending({ kind: 'party' })}
                  >
                    <UserRound aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            </div>

            <div className="w-full col-span-1">
              <FormField
                label={t('workspace.header.odometer')}
                error={fieldErrors.odometer}
              >
                <NumericInput
                  autoComplete="off"
                  className="tabular text-right"
                  value={odometer}
                  onValueChange={(value) => {
                    setOdometer(value);
                    textField(
                      'odometer',
                      value,
                      100_000_000,
                      (km) => ({
                        kind: 'updateHeader',
                        changes: { odometerKm: km },
                      }),
                      { kind: 'updateHeader', changes: { odometerKm: null } },
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                />
              </FormField>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['sales', 'expedition'] as const).map((entity) => {
              const options = entity === 'sales' ? sales : expeditions;
              const current = view[entity];
              return (
                <FormField
                  key={entity}
                  label={t(`references.entities.${entity}`)}
                >
                  <Select
                    value={current?.id ?? ''}
                    onChange={(event) =>
                      void apply({
                        kind: 'updateHeader',
                        changes: {
                          [`${entity}Id`]: event.target.value || null,
                        },
                      })
                    }
                  >
                    <option value="" />
                    {current &&
                    !options.some((option) => option.id === current.id) ? (
                      <option value={current.id}>{current.name}</option>
                    ) : null}
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.code} · {option.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
              );
            })}
          </div>
        </div>
        <div className="grid gap-2">
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-2">
            <div className="w-full">
              <FormField label={t('workspace.header.channel')}>
                <Select
                  value={view.channelId}
                  onChange={(event) =>
                    void apply({
                      kind: 'updateHeader',
                      changes: { channelId: event.target.value },
                    })
                  }
                >
                  {channelMissing ? (
                    <option value={view.channelId}>{view.channelLabel}</option>
                  ) : null}
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>

            <div className="w-full">
              <FormField label={t('workspace.header.invoiceDate')}>
                <Input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  onBlur={commitDate}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitDate();
                    }
                  }}
                />
              </FormField>
            </div>
          </div>

          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <div className="flex w-full flex-col gap-1.5">
              <Label htmlFor="header-pricing-at">
                {t('workspace.header.pricingAt')}
              </Label>
              <div className="relative">
                <Input
                  id="header-pricing-at"
                  className="tabular pr-12"
                  data-testid="header-pricing-at"
                  readOnly
                  value={formatDisplayDateTime(view.pricingAt, timezone)}
                  title={t('workspace.header.timezoneTooltip', {
                    zone: timezone,
                  })}
                />
                <IconButton
                  variant="input-action"
                  size="default"
                  className="absolute right-0 top-0"
                  label={t('workspace.header.changePricingAt')}
                  onClick={() => setPending({ kind: 'pricing' })}
                >
                  <CalendarClock aria-hidden="true" />
                </IconButton>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="min-w-0 w-full">
                <FormField
                  label={t('workspace.header.topDays')}
                  error={fieldErrors.topDays}
                >
                  <NumericInput
                    autoComplete="off"
                    className="tabular text-right"
                    value={topDays}
                    onValueChange={(value) => {
                      setTopDays(value);
                      textField('topDays', value, MAX_TOP_DAYS, (days) => ({
                        kind: 'updateHeader',
                        changes: { topDays: days },
                      }));
                    }}
                  />
                </FormField>
              </div>

              <div className="min-w-0 w-full">
                <FormField label={t('workspace.header.dueDate')}>
                  <Input
                    className="tabular text-right"
                    data-testid="header-due-date"
                    readOnly
                    value={formatDisplayDate(view.dueDate)}
                  />
                </FormField>
              </div>
            </div>
          </div>
        </div>
      </div>

      {view.ownerMismatch ? (
        <div
          role="alert"
          data-testid="owner-mismatch"
          className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm text-warning"
        >
          <TriangleAlert aria-hidden="true" className="size-4" />
          <span className="text-foreground">
            {t('workspace.header.ownerMismatch')}
          </span>
          {view.vehicle && view.customer ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPending({ kind: 'ownership' })}
            >
              {t('workspace.header.reviewOwnership')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {pending?.kind === 'pricing' || pending?.kind === 'backdate' ? (
        <PricingTimeDialog
          timezone={timezone}
          currentPricingAt={view.pricingAt}
          backdatedTo={pending.kind === 'backdate' ? pending.date : undefined}
          onConfirm={confirmPricing}
          onClose={() => {
            setPending(null);
            setDate(view.invoiceDate);
          }}
        />
      ) : null}
      {pending?.kind === 'party' ? (
        <CustomerVehicleDialog
          view={view}
          clearParty={async (): Promise<Result<null>> => {
            const result = await send({
              kind: 'updateHeader',
              changes: { customerId: null, vehicleId: null },
            });
            if (result.ok) {
              onError(null);
              return { ok: true, value: null };
            }
            if (result.error.code !== 'QUEUE_CLOSED') {
              onError(errorMessage(t, result.error));
            }
            return result;
          }}
          selectCustomer={(customerId) =>
            apply({ kind: 'updateHeader', changes: { customerId } })
          }
          selectVehicle={(vehicleId) =>
            apply({ kind: 'updateHeader', changes: { vehicleId } })
          }
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'ownership' && view.vehicle && view.customer ? (
        <OwnershipDialog
          vehicleId={view.vehicle.id}
          customerId={view.customer.id}
          onTransferred={() => void commands.reload()}
          onClose={() => setPending(null)}
        />
      ) : null}
    </section>
  );
}
