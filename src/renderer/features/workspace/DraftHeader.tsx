import { useNumberFormat } from '@/renderer/lib/number-format';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { NumericInput } from '@/renderer/components/ui/numeric-input';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import {
  MAX_TOP_DAYS,
  isLocalDate,
  type DraftOperation,
  type ReferenceDto,
} from '@/shared/contracts';
import type { Instant, LocalDate } from '@/shared/primitives';
import { CustomerVehiclePicker } from './CustomerVehiclePicker';
import { OwnershipDialog } from './OwnershipDialog';
import { PricingTimeDialog } from './PricingTimeDialog';
import { formatDisplayDate } from '@/renderer/lib/date-format';
import { todayInShop } from './shop-time';
import { useSyncedValue } from './synced-field';
import type { DraftCommands } from './use-draft-commands';

interface DraftHeaderProps {
  commands: DraftCommands;
  stockLocations: ReferenceDto[];
  sales: ReferenceDto[];
  expeditions: ReferenceDto[];
  channels: ReferenceDto[];
  timezone: string;
  onError(message: string | null): void;
}

type Pending =
  | { kind: 'backdate'; date: LocalDate }
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
  stockLocations,
  channels,
  sales,
  expeditions,
  timezone,
  onError,
}: DraftHeaderProps) {
  const { t } = useTranslation();
  const { formatIdr } = useNumberFormat();
  const { view, send, edit, isDirty, markInvalid } = commands;
  const [taxNumber, setTaxNumber] = useSyncedValue(
    commands.view.taxInvoiceNumber ?? '',
    () => commands.isDirty('taxInvoiceNumber'),
  );
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

  return (
    <section
      aria-label={t('workspace.header.label')}
      className="flex flex-col gap-2"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_3fr]">
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr]">
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
              {channelMissing && (
                <option value={view.channelId}>{view.channelLabel}</option>
              )}
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.label}
                </option>
              ))}
            </Select>
          </FormField>
          <CustomerVehiclePicker
            mode="customer"
            commands={commands}
            onError={onError}
          />
        </div>
        {view.customer && view.customerOutstandingAmount !== null && (
          <div className="flex h-8 items-center justify-end gap-2 self-end text-xs tabular-nums lg:col-start-3">
            <span>{t('workspace.header.piutang')}</span>
            <output
              aria-label={t('workspace.header.piutang')}
              className="font-semibold"
            >
              {formatIdr(view.customerOutstandingAmount)}
            </output>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_3fr]">
        <div className="grid content-start gap-2">
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
                      changes: { [`${entity}Id`]: event.target.value || null },
                    })
                  }
                >
                  <option value="" />
                  {current &&
                    !options.some((option) => option.id === current.id) && (
                      <option value={current.id}>{current.name}</option>
                    )}
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
        <div className="hidden lg:block" aria-hidden="true" />
        <div
          className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-3"
          data-testid="invoice-header-fields"
        >
          <FormField label={t('workspace.header.invoiceNumber')}>
            <Input readOnly value={view.invoiceNumber ?? ''} />
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
          <div className="grid min-w-0 grid-cols-[1fr_2fr] gap-2">
            <FormField
              label={t('workspace.header.topDays')}
              error={fieldErrors.topDays}
            >
              <NumericInput
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
            <FormField label={t('workspace.header.dueDate')}>
              <Input
                readOnly
                data-testid="header-due-date"
                value={formatDisplayDate(view.dueDate)}
              />
            </FormField>
          </div>
          <FormField label={t('workspace.header.taxInvoiceNumber')}>
            <Input
              maxLength={100}
              value={taxNumber}
              onChange={(event) => {
                setTaxNumber(event.target.value);
                edit('taxInvoiceNumber', {
                  kind: 'updateHeader',
                  changes: { taxInvoiceNumber: event.target.value },
                });
              }}
            />
          </FormField>
          <div className="grid min-w-0 grid-cols-[2fr_1fr] gap-2">
            <CustomerVehiclePicker
              mode="vehicle"
              commands={commands}
              onError={onError}
            />
            <FormField
              label={t('workspace.header.odometer')}
              error={fieldErrors.odometer}
            >
              <NumericInput
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
              />
            </FormField>{' '}
          </div>
          <FormField label={t('references.entities.stockLocation')}>
            <Select
              required
              value={view.stockLocation.id}
              onChange={(event) =>
                void apply({
                  kind: 'updateHeader',
                  changes: { stockLocationId: event.target.value },
                })
              }
            >
              {!stockLocations.some((l) => l.id === view.stockLocation.id) ? (
                <option value={view.stockLocation.id}>
                  {view.stockLocation.code} · {view.stockLocation.label}
                </option>
              ) : null}
              {stockLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} · {l.label}
                </option>
              ))}
            </Select>
          </FormField>
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

      {pending?.kind === 'backdate' ? (
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
