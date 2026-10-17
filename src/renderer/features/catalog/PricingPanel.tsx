import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';
import { useAction } from '@/renderer/lib/use-action';
import type {
  PricePointDto,
  PriceTimelineDto,
  ReferenceDto,
} from '@/shared/contracts';
import { formatLocal } from './local-time';
import { PriceDialog } from './PriceDialog';

interface PricingPanelProps {
  catalogItemId: string;
  /** ADMIN may add and correct; everyone else views. */
  canEdit: boolean;
}

type DialogState = {
  channel: ReferenceDto;
  target?: PricePointDto | undefined;
  defaultPrice?: string | undefined;
} | null;

/**
 * Per-channel price timeline in shop-local time: what is effective now,
 * scheduled future points, replaced points, and superseded revisions as greyed
 * history with the correction reason.
 */
export function PricingPanel({ catalogItemId, canEdit }: PricingPanelProps) {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const [timeline, setTimeline] = useState<PriceTimelineDto | null>(null);
  const [channels, setChannels] = useState<ReferenceDto[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [restore, setRestore] = useState<{
    channel: ReferenceDto;
    price: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { error, run, check } = useAction();

  const load = useCallback(() => {
    void run(async () => {
      const [prices, active] = await Promise.all([
        window.bengkelin.catalog.listPrices({ catalogItemId }),
        window.bengkelin.references.listActive({ entity: 'channel' }),
      ]);
      if (check(prices)) setTimeline(prices.value);
      if (check(active)) setChannels(active.value);
    });
  }, [catalogItemId, run, check]);

  useEffect(load, [load]);

  const zone = timeline?.timezone ?? 'Asia/Jakarta';

  return (
    <section
      aria-label={t('catalog.pricing.title')}
      className="flex flex-col gap-4"
    >
      <div>
        <h2 className="text-lg font-semibold">{t('catalog.pricing.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('catalog.pricing.note')} {t('catalog.pricing.timezone', { zone })}
        </p>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}

      {channels.map((channel) => {
        const points = (timeline?.points ?? []).filter(
          (point) => point.channelId === channel.id,
        );
        const hasCurrent = points.some((p) => p.state === 'CURRENT');
        return (
          <div
            key={channel.id}
            role="group"
            aria-label={channel.label}
            data-testid={`channel-${channel.code}`}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{channel.label}</h3>
              {canEdit ? (
                <Button
                  size="sm"
                  aria-label={t('catalog.pricing.addFor', {
                    channel: channel.label,
                  })}
                  onClick={() => {
                    setNotice(null);
                    setDialog({ channel });
                  }}
                >
                  {t('catalog.pricing.add')}
                </Button>
              ) : null}
            </div>
            {points.length === 0 || !hasCurrent ? (
              <p className="text-sm text-muted-foreground">
                {t('catalog.pricing.noPrice')}
              </p>
            ) : null}
            {points.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th scope="col" className="py-1 pr-2">
                      {t('catalog.pricing.start')}
                    </th>
                    <th scope="col" className="py-1 pr-2">
                      {t('catalog.pricing.price')}
                    </th>
                    <th scope="col" className="py-1 pr-2">
                      {t('catalog.pricing.state')}
                    </th>
                    {canEdit ? (
                      <th scope="col" className="py-1">
                        {t('catalog.pricing.actions')}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => (
                    <tr
                      key={point.id}
                      data-testid="price-row"
                      data-state={point.state}
                      className={cn(
                        'border-t border-border align-top',
                        point.state === 'SUPERSEDED' &&
                          'text-muted-foreground opacity-70',
                        point.state === 'CURRENT' && 'font-medium',
                      )}
                    >
                      <td className="py-1 pr-2">
                        {formatLocal(point.effectiveStartAt, zone)}
                      </td>
                      <td
                        className={cn(
                          'py-1 pr-2',
                          point.state === 'SUPERSEDED' && 'line-through',
                        )}
                      >
                        {formatIdr(point.price)}
                      </td>
                      <td className="py-1 pr-2">
                        <span>{t(`catalog.pricing.state_${point.state}`)}</span>
                        {point.supersededReason ? (
                          <span className="block text-xs">
                            {t('catalog.pricing.supersededReason', {
                              reason: point.supersededReason,
                            })}
                          </span>
                        ) : null}
                        {point.correctionReason ? (
                          <span className="block text-xs">
                            {t('catalog.pricing.correctionOf', {
                              reason: point.correctionReason,
                            })}
                          </span>
                        ) : null}
                      </td>
                      {canEdit ? (
                        <td className="py-1">
                          {point.state !== 'SUPERSEDED' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={t('catalog.pricing.correctFor', {
                                start: formatLocal(
                                  point.effectiveStartAt,
                                  zone,
                                ),
                                channel: channel.label,
                              })}
                              onClick={() => {
                                setNotice(null);
                                setDialog({ channel, target: point });
                              }}
                            >
                              {t('catalog.pricing.correct')}
                            </Button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {canEdit && restore && restore.channel.id === channel.id ? (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDialog({
                      channel,
                      defaultPrice: restore.price,
                    });
                    setRestore(null);
                  }}
                >
                  {t('catalog.pricing.restore', {
                    price: formatIdr(restore.price),
                  })}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}

      {dialog ? (
        <PriceDialog
          catalogItemId={catalogItemId}
          channel={dialog.channel}
          timezone={zone}
          target={dialog.target}
          defaultPrice={dialog.defaultPrice}
          onClose={() => setDialog(null)}
          onApplied={(_applied, preview) => {
            const channel = dialog.channel;
            setDialog(null);
            setNotice(t('catalog.dialog.applied'));
            // "Schedule restore": a temporary price is a promo point plus a
            // later ordinary point that brings the old amount back.
            setRestore(
              !dialog.target && preview.current
                ? { channel, price: preview.current.price }
                : null,
            );
            load();
          }}
        />
      ) : null}
    </section>
  );
}
