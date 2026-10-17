import { useNumberFormat } from '@/renderer/lib/number-format';
import { Eye, FileDown } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { useFilterOptions } from '@/renderer/features/history/use-filter-options';
import { useShopTimezone } from '@/renderer/features/history/use-shop-timezone';
import { todayInShop } from '@/renderer/features/workspace/shop-time';
import { useAction } from '@/renderer/lib/use-action';
import type {
  CashierSession,
  DailyReport,
  DailyReportInput,
  ReportOutcomeDto,
} from '@/shared/contracts';
import { bridgeReportClient, type ReportClient } from './report-client';
import { ReportPreviewDialog } from './ReportPreviewDialog';
import { ReportSections } from './ReportSections';

interface Form {
  date: string;
  cashierId: string;
  channelId: string;
}

function toInput(form: Form): DailyReportInput {
  return {
    date: form.date,
    ...(form.cashierId ? { cashierId: form.cashierId } : {}),
    ...(form.channelId ? { channelId: form.channelId } : {}),
  };
}

type Notice = { tone: 'status' | 'alert'; text: string } | null;

/**
 * "Laporan Harian" (spec 33): one calendar day in the shop timezone, never
 * a shift. Sales (by finalization), voids (by void time) and payments (by
 * receipt time) are shown apart. Preview/print and CSV export render the
 * same report in main. Any signed-in cashier may use it.
 */
export function DailyReportScreen({
  session,
  client = bridgeReportClient,
}: {
  session: CashierSession;
  client?: ReportClient;
}) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  const timezone = useShopTimezone();
  const { channels, cashiers } = useFilterOptions(session);
  const [form, setForm] = useState<Form | null>(null);
  /** The input of the report on screen (what preview/print/export use). */
  const [shown, setShown] = useState<DailyReportInput | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = useAction();
  const act = useAction();
  const { run, check } = load;

  const show = useCallback(
    (input: DailyReportInput) =>
      run(async () => {
        const result = await client.daily(input);
        if (check(result)) {
          setReport(result.value);
          setShown(input);
        }
      }),
    [client, run, check],
  );

  // Default: today in the SHOP timezone, loaded once the zone is known.
  useEffect(() => {
    if (!timezone || form) return;
    const initial = {
      date: todayInShop(timezone),
      cashierId: '',
      channelId: '',
    };
    setForm(initial);
    void show(toInput(initial));
  }, [timezone, form, show]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form) void show(toInput(form));
  }

  const describe = useCallback(
    (outcome: ReportOutcomeDto): Notice => {
      if (outcome.outcome === 'PRINTED') {
        return {
          tone: 'status',
          text: outcome.fileName
            ? t('reports.outcome.csvSaved', { fileName: outcome.fileName })
            : t('reports.outcome.printed'),
        };
      }
      if (outcome.outcome === 'CANCELLED') {
        return { tone: 'status', text: t('reports.outcome.cancelled') };
      }
      return {
        tone: 'alert',
        text: t(`reports.outcome.${outcome.code ?? 'PRINT_FAILED'}`, {
          ...numberOptions,
          ...outcome.params,
        }),
      };
    },
    [t],
  );

  function perform(kind: 'print' | 'exportCsv') {
    if (!shown) return;
    const input = shown;
    void act.run(async () => {
      setNotice({ tone: 'status', text: t('reports.outcome.working') });
      const result = await client[kind](input);
      if (act.check(result)) setNotice(describe(result.value));
      else setNotice(null);
    });
  }

  if (!form) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t('reports.loading')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t('reports.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('reports.subtitle', { timezone: timezone ?? '' })}
        </p>
      </div>

      <form
        onSubmit={submit}
        noValidate
        role="search"
        aria-label={t('reports.filters.label')}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <FormField
          label={t('reports.filters.date')}
          error={load.fieldErrors.date}
        >
          <Input
            type="date"
            required
            value={form.date}
            onChange={(event) => setForm({ ...form, date: event.target.value })}
          />
        </FormField>
        <FormField label={t('reports.filters.cashier')}>
          <Select
            value={form.cashierId}
            onChange={(event) =>
              setForm({ ...form, cashierId: event.target.value })
            }
          >
            <option value="">{t('reports.filters.any')}</option>
            {cashiers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('reports.filters.channel')}>
          <Select
            value={form.channelId}
            onChange={(event) =>
              setForm({ ...form, channelId: event.target.value })
            }
          >
            <option value="">{t('reports.filters.any')}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex items-end">
          <Button type="submit" disabled={load.busy}>
            {t('reports.filters.submit')}
          </Button>
        </div>
      </form>

      {load.error ? <Alert>{load.error}</Alert> : null}

      {report ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" data-testid="report-heading">
              {t('reports.heading', {
                date: report.date.split('-').reverse().join('/'),
                timezone: report.timezone,
                time: report.generatedAtLocal.slice(11),
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={act.busy}
                onClick={() => {
                  setNotice(null);
                  setPreviewing(true);
                }}
              >
                <Eye aria-hidden="true" />
                {t('reports.actions.preview')}
              </Button>
              <Button
                variant="outline"
                disabled={act.busy}
                onClick={() => perform('exportCsv')}
              >
                <FileDown aria-hidden="true" />
                {t('reports.actions.exportCsv')}
              </Button>
            </div>
          </div>
          <p
            className="text-xs text-muted-foreground"
            data-testid="csv-separator-note"
          >
            {t('reports.actions.csvSeparatorNote')}
          </p>
          {notice ? (
            <p
              role={notice.tone}
              className={
                notice.tone === 'alert' ? 'text-sm text-destructive' : 'text-sm'
              }
              data-testid="report-notice"
            >
              {notice.text}
            </p>
          ) : null}
          {act.error ? <Alert>{act.error}</Alert> : null}
          <ReportSections report={report} />
        </>
      ) : null}

      {previewing && shown ? (
        <ReportPreviewDialog
          input={shown}
          client={client}
          busy={act.busy}
          notice={notice?.text ?? null}
          onPrint={() => perform('print')}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </div>
  );
}
