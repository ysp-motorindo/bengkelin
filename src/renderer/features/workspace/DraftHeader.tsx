import { CalendarClock, TriangleAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Button } from '@/renderer/components/ui/button';
import { Input, controlClass } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { customerLabel } from '@/renderer/features/customers/labels';
import { errorMessage } from '@/renderer/lib/errors';
import { cn } from '@/renderer/lib/utils';
import {
  MAX_TOP_DAYS,
  isLocalDate,
  type DraftOperation,
  type ReferenceDto,
} from '@/shared/contracts';
import type { Instant, LocalDate } from '@/shared/primitives';
import { CustomerVehicleDialog } from './CustomerVehicleDialog';
import { OwnershipDialog } from './OwnershipDialog';
import { PricingTimeDialog } from './PricingTimeDialog';
import { formatWithOffset, todayInShop } from './shop-time';
import { useSyncedValue } from './synced-field';
import type { DraftCommands } from './use-draft-commands';

interface DraftHeaderProps {
  commands: DraftCommands;
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
  timezone,
  onError,
}: DraftHeaderProps) {
  const { t } = useTranslation();
  const { view, send, edit, isDirty } = commands;
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
  const [note, setNote] = useSyncedValue(view.note ?? '', () =>
    isDirty('note'),
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

  return (
    <section
      aria-label={t('workspace.header.label')}
      className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-3 xl:grid-cols-6"
    >
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

      <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-1 xl:col-span-2">
        <span className="text-sm font-medium" id="pricing-at-label">
          {t('workspace.header.pricingAt')}
        </span>
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="tabular text-sm"
            data-testid="header-pricing-at"
            aria-labelledby="pricing-at-label"
          >
            {formatWithOffset(view.pricingAt, timezone)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPending({ kind: 'pricing' })}
          >
            <CalendarClock aria-hidden="true" />
            {t('workspace.header.changePricingAt')}
          </Button>
        </div>
      </div>

      <FormField
        label={t('workspace.header.topDays')}
        error={fieldErrors.topDays}
        hint={t('workspace.header.dueDate', { date: view.dueDate })}
      >
        <Input
          inputMode="numeric"
          autoComplete="off"
          className="tabular"
          value={topDays}
          onChange={(event) => {
            setTopDays(event.target.value);
            textField('topDays', event.target.value, MAX_TOP_DAYS, (days) => ({
              kind: 'updateHeader',
              changes: { topDays: days },
            }));
          }}
        />
      </FormField>

      <FormField
        label={t('workspace.header.odometer')}
        error={fieldErrors.odometer}
      >
        <Input
          inputMode="numeric"
          autoComplete="off"
          className="tabular"
          value={odometer}
          onChange={(event) => {
            setOdometer(event.target.value);
            textField(
              'odometer',
              event.target.value,
              100_000_000,
              (km) => ({ kind: 'updateHeader', changes: { odometerKm: km } }),
              { kind: 'updateHeader', changes: { odometerKm: null } },
            );
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
      </FormField>

      <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-3 xl:col-span-3">
        <span className="text-sm font-medium">
          {t('workspace.header.customerVehicle')}
        </span>
        <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1">
          <UserRound
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          <span data-testid="header-customer" className="font-medium">
            {view.customer
              ? customerLabel(t, view.customer)
              : t('workspace.header.anonymous')}
          </span>
          <span data-testid="header-vehicle" className="text-sm">
            {view.vehicle
              ? [view.vehicle.plateNumber, view.vehicle.description]
                  .filter(Boolean)
                  .join(' · ')
              : t('workspace.header.noVehicle')}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPending({ kind: 'party' })}
          >
            {t('workspace.header.chooseParty')}
          </Button>
        </div>
      </div>

      <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-3 xl:col-span-3">
        <label htmlFor="draft-note" className="text-sm font-medium">
          {t('workspace.header.note')}
        </label>
        <textarea
          id="draft-note"
          rows={1}
          maxLength={1000}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            edit('note', {
              kind: 'updateHeader',
              changes: { note: event.target.value },
            });
          }}
          className={cn(controlClass, 'h-auto min-h-10 resize-y')}
        />
      </div>

      {view.ownerMismatch ? (
        <div
          role="alert"
          data-testid="owner-mismatch"
          className="col-span-full flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm text-warning"
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
