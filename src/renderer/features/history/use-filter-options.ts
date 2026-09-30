import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CashierSession, ReferenceDto } from '@/shared/contracts';

export interface FilterOption {
  id: string;
  label: string;
}

/**
 * Channel and cashier choices for list/report filters (history, daily
 * report). ADMIN sees every channel (inactive ones too, for old sales) and
 * every cashier. A CASHIER, who may not list cashiers, sees active channels
 * and only "Me (name)"; main still accepts any cashier id.
 */
export function useFilterOptions(session: CashierSession): {
  channels: FilterOption[];
  cashiers: FilterOption[];
} {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<FilterOption[]>([]);
  const [cashiers, setCashiers] = useState<FilterOption[]>([]);
  const admin = session.role === 'ADMIN';

  useEffect(() => {
    let live = true;
    const b = window.bengkelin;
    void (async () => {
      const channelResult = admin
        ? await b.references.list({ entity: 'channel' })
        : await b.references.listActive({ entity: 'channel' });
      if (live && channelResult.ok) {
        setChannels(
          (channelResult.value as ReferenceDto[]).map((c) => ({
            id: c.id,
            label: c.label,
          })),
        );
      }
      if (admin) {
        const cashierResult = await b.cashiers.list();
        if (live && cashierResult.ok) {
          setCashiers(
            cashierResult.value.map((c) => ({
              id: c.id,
              label: c.displayName,
            })),
          );
        }
      } else if (live) {
        setCashiers([
          {
            id: session.cashierId,
            label: t('history.filters.me', { name: session.displayName }),
          },
        ]);
      }
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [admin, session.cashierId, session.displayName, t]);

  return { channels, cashiers };
}
