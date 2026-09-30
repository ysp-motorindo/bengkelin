import {
  CircleAlert,
  PencilLine,
  SquarePen,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatIdr } from '@/renderer/lib/money';
import type { DraftLineDto } from '@/shared/contracts';
import { formatBpsAsPercentage } from '@/shared/percentage';

interface LinesTableProps {
  lines: DraftLineDto[];
  onEdit(line: DraftLineDto): void;
  onRemove(line: DraftLineDto): void;
}

/** Indicator flags of a line (sticky override, missing price, retained differs). */
export function lineIndicators(line: DraftLineDto) {
  const kinds = line.priceChanges.map((change) => change.kind);
  return {
    missingPrice: kinds.includes('MISSING_PRICE_ENTRY'),
    override:
      line.pricing.manualPriceOverride && kinds.includes('MANUAL_OVERRIDE'),
    differs: line.pricing.listedPriceDiffersFromCurrent,
  };
}

/** "10% + 5%" in the UI language's decimal style. */
export function useDiscountSummary() {
  const { i18n } = useTranslation();
  const separator = i18n.language === 'en' ? '.' : ',';
  return (stages: { percentageBps: number }[]) =>
    stages
      .map(
        (stage) => `${formatBpsAsPercentage(stage.percentageBps, separator)}%`,
      )
      .join(' + ');
}

/**
 * The readable lines table (spec 50): title, qty, unit price, a discount
 * summary, amount and indicators. Editing happens in the item editor.
 */
export function LinesTable({ lines, onEdit, onRemove }: LinesTableProps) {
  const { t } = useTranslation();
  const summary = useDiscountSummary();

  if (lines.length === 0) {
    return (
      <p
        data-testid="lines-empty"
        className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
      >
        {t('workspace.lines.empty')}
      </p>
    );
  }

  return (
    <div className="relative overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">{t('workspace.lines.caption')}</caption>
        <thead className="bg-sunken text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="w-8 px-2 py-2 text-right">
              #
            </th>
            <th scope="col" className="px-2 py-2">
              {t('workspace.lines.item')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('workspace.lines.quantity')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('workspace.lines.unitPrice')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('workspace.lines.discount')}
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              {t('workspace.lines.amount')}
            </th>
            <th scope="col" className="px-2 py-2">
              <span className="sr-only">{t('workspace.lines.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const flags = lineIndicators(line);
            return (
              <tr
                key={line.id}
                data-testid="line-row"
                className="border-t border-border align-top"
              >
                <td className="tabular px-2 py-2 text-right text-muted-foreground">
                  {index + 1}
                </td>
                <td className="px-2 py-2">
                  <div className="font-medium" data-testid="line-title">
                    {line.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t(`workspace.itemType.${line.itemType}`)}</span>
                    {flags.override ? (
                      <span
                        data-testid="indicator-override"
                        className="inline-flex items-center gap-1 text-primary"
                        title={t('workspace.indicators.overrideHint')}
                      >
                        <PencilLine aria-hidden="true" className="size-3.5" />
                        {t('workspace.indicators.override')}
                      </span>
                    ) : null}
                    {flags.missingPrice ? (
                      <span
                        data-testid="indicator-missing-price"
                        className="inline-flex items-center gap-1 text-warning"
                        title={t('workspace.indicators.missingPriceHint')}
                      >
                        <CircleAlert aria-hidden="true" className="size-3.5" />
                        {t('workspace.indicators.missingPrice')}
                      </span>
                    ) : null}
                    {flags.differs ? (
                      <span
                        data-testid="indicator-price-differs"
                        className="inline-flex items-center gap-1 text-warning"
                      >
                        <TriangleAlert
                          aria-hidden="true"
                          className="size-3.5"
                        />
                        {line.pricing.currentListedPrice
                          ? t('workspace.indicators.differs', {
                              price: formatIdr(line.pricing.currentListedPrice),
                            })
                          : t('workspace.indicators.noCurrentPrice')}
                      </span>
                    ) : null}
                    {line.mechanicName ? (
                      <span
                        data-testid="indicator-mechanic"
                        className="inline-flex items-center gap-1"
                      >
                        <Wrench aria-hidden="true" className="size-3.5" />
                        <span className="sr-only">
                          {t('workspace.indicators.mechanic')}:
                        </span>
                        {line.mechanicName}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-right">
                  <span data-testid="line-quantity">{line.quantity}</span>
                  {line.unitLabel ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {line.unitLabel}
                    </span>
                  ) : null}
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-right">
                  <div>{formatIdr(line.unitPrice)}</div>
                  {line.listedUnitPrice &&
                  line.listedUnitPrice !== line.unitPrice ? (
                    <div className="text-xs text-muted-foreground line-through">
                      <span className="sr-only">
                        {t('workspace.lines.listed')}:{' '}
                      </span>
                      {formatIdr(line.listedUnitPrice)}
                    </div>
                  ) : null}
                </td>
                <td
                  className="tabular whitespace-nowrap px-2 py-2 text-right"
                  data-testid="line-discount"
                >
                  {line.discounts.length > 0 ? (
                    <>
                      <div>{summary(line.discounts)}</div>
                      <div className="text-xs text-muted-foreground">
                        -{formatIdr(line.discountAmount)}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-right font-medium">
                  <span data-testid="line-amount">
                    {formatIdr(line.amount)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-1 py-1 text-right">
                  <button
                    type="button"
                    aria-label={`${t('workspace.lines.edit')}: ${line.title}`}
                    title={t('workspace.lines.edit')}
                    onClick={() => onEdit(line)}
                    className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SquarePen aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('workspace.lines.remove')}: ${line.title}`}
                    title={t('workspace.lines.remove')}
                    onClick={() => onRemove(line)}
                    className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
