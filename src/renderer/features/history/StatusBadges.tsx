import { useTranslation } from 'react-i18next';
import { cn } from '@/renderer/lib/utils';
import type { PaymentStatus } from '@/shared/contracts';

/** Invoice status and derived payment status, as text (never color only). */
export function StatusBadges({
  status,
  paymentStatus,
}: {
  status: 'FINALIZED' | 'VOID';
  paymentStatus: PaymentStatus;
}) {
  const { t } = useTranslation();
  const badge = 'inline-block rounded border px-1.5 text-xs whitespace-nowrap';
  if (status === 'VOID') {
    return (
      <span
        data-testid="status-void"
        className={cn(
          badge,
          'border-destructive font-semibold text-destructive',
        )}
      >
        {t('history.status.VOID')}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      <span className={cn(badge, 'border-border')}>
        {t('history.status.FINALIZED')}
      </span>
      <span
        data-testid="payment-status"
        className={cn(
          badge,
          paymentStatus === 'PAID'
            ? 'border-primary text-primary'
            : 'border-border text-foreground',
        )}
      >
        {t(`workspace.paymentStatus.${paymentStatus}`)}
      </span>
    </span>
  );
}
