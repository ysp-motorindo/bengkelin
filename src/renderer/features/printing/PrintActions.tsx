import { Eye, FileDown, Printer } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { errorMessage } from '@/renderer/lib/errors';
import { watchSessionError } from '@/renderer/lib/session-events';
import type {
  PrintFormat,
  PrintOptionsDto,
  PrintOutcomeDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { bridgePrintClient, type PrintClient } from './print-client';
import { PrintPreviewDialog } from './PrintPreviewDialog';

type Notice = { tone: 'status' | 'alert'; text: string } | null;

/**
 * Print Thermal, Print A4, Preview and Export PDF for ONE committed invoice
 * (spec 30). Any cashier may use them. A failure, cancellation or missing
 * printer is shown as a message; the invoice is never affected. With
 * `autoPrint`, the default format prints once when the shop enabled
 * auto-print; the caller mounts this only after finalization returned.
 */
export function PrintActions({
  invoiceId,
  client = bridgePrintClient,
  autoPrint = false,
  size = 'default',
}: {
  invoiceId: string;
  client?: PrintClient;
  autoPrint?: boolean;
  size?: 'default' | 'sm';
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<PrintOptionsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [previewing, setPreviewing] = useState(false);
  const running = useRef(false);
  const autoPrinted = useRef(false);

  const thermalFormat: PrintFormat = options?.thermalFormat ?? 'THERMAL_58';
  const defaultFormat: PrintFormat =
    options?.defaultInvoiceFormat === 'A4' ? 'A4' : thermalFormat;

  const describe = useCallback(
    (outcome: PrintOutcomeDto): Notice => {
      const format = t(`printing.format.${outcome.format}`);
      if (outcome.outcome === 'PRINTED') {
        if (outcome.fileName) {
          return {
            tone: 'status',
            text: t('printing.outcome.pdfSaved', {
              fileName: outcome.fileName,
            }),
          };
        }
        return {
          tone: 'status',
          text: outcome.isReprint
            ? t('printing.outcome.reprinted', { format })
            : t('printing.outcome.printed', { format }),
        };
      }
      if (outcome.outcome === 'CANCELLED') {
        return { tone: 'status', text: t('printing.outcome.cancelled') };
      }
      return {
        tone: 'alert',
        text: t(`printing.outcome.${outcome.code ?? 'PRINT_FAILED'}`, {
          ...outcome.params,
        }),
      };
    },
    [t],
  );

  const run = useCallback(
    async (work: () => Promise<Result<PrintOutcomeDto>>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setNotice({ tone: 'status', text: t('printing.outcome.working') });
      try {
        const result = await work();
        if (result.ok) setNotice(describe(result.value));
        else {
          watchSessionError(result.error);
          setNotice({ tone: 'alert', text: errorMessage(t, result.error) });
        }
      } catch {
        setNotice({ tone: 'alert', text: t('printing.outcome.PRINT_FAILED') });
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [describe, t],
  );

  const print = useCallback(
    (format: PrintFormat) => run(() => client.print({ invoiceId, format })),
    [client, invoiceId, run],
  );

  useEffect(() => {
    let current = true;
    client.getOptions().then(
      (result) => {
        if (current && result.ok) setOptions(result.value);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);

  // Auto-print once, only when the shop enabled it.
  useEffect(() => {
    if (!autoPrint || !options || autoPrinted.current) return;
    autoPrinted.current = true;
    if (options.autoPrintAfterFinalize) void print(defaultFormat);
  }, [autoPrint, options, defaultFormat, print]);

  return (
    <div className="flex flex-col gap-2" data-testid="print-actions">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => void print(thermalFormat)}
        >
          <Printer aria-hidden="true" />
          {t('printing.actions.printThermal')}
        </Button>
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => void print('A4')}
        >
          <Printer aria-hidden="true" />
          {t('printing.actions.printA4')}
        </Button>
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => setPreviewing(true)}
        >
          <Eye aria-hidden="true" />
          {t('printing.actions.preview')}
        </Button>
        <Button
          variant="outline"
          size={size}
          disabled={busy}
          onClick={() => void run(() => client.exportPdf({ invoiceId }))}
        >
          <FileDown aria-hidden="true" />
          {t('printing.actions.exportPdf')}
        </Button>
      </div>
      <p
        role={notice?.tone === 'alert' ? 'alert' : 'status'}
        data-testid="print-notice"
        className={
          notice?.tone === 'alert'
            ? 'text-sm text-destructive'
            : 'text-sm text-muted-foreground'
        }
      >
        {notice?.text ?? ''}
      </p>
      {previewing ? (
        <PrintPreviewDialog
          invoiceId={invoiceId}
          initialFormat={defaultFormat}
          client={client}
          busy={busy}
          notice={notice?.text ?? null}
          onPrint={(format) => void print(format)}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </div>
  );
}
