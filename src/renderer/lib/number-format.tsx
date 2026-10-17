import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { NumberFormat } from '@/shared/contracts';
import { formatIdr } from '@/shared/idr';
import { formatBpsAsPercentage } from '@/shared/percentage';
import { formatNumericText, resolveNumberLocale } from '@/shared/number-format';

const NumberLocale = createContext('id-ID');
export function NumberFormatProvider({
  format = 'ID',
  systemLocale = 'id-ID',
  children,
}: {
  format?: NumberFormat;
  systemLocale?: string;
  children: ReactNode;
}) {
  return (
    <NumberLocale value={resolveNumberLocale(format, systemLocale)}>
      {children}
    </NumberLocale>
  );
}

export function useNumberFormat() {
  const locale = useContext(NumberLocale);
  return useMemo(
    () => ({
      locale,
      numberOptions: {
        interpolation: {
          alwaysFormat: true,
          format: (value: unknown) =>
            typeof value === 'number'
              ? formatNumericText(String(value), locale)
              : String(value ?? ''),
        },
      },
      formatIdr: (value: string) => formatIdr(value, locale),
      formatNumber: (value: string | number) =>
        formatNumericText(String(value), locale),
      formatPercent: (bps: number) =>
        formatNumericText(formatBpsAsPercentage(bps), locale),
    }),
    [locale],
  );
}
