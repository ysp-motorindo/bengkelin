import { useNumberFormat } from '@/renderer/lib/number-format';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { errorMessage } from '@/renderer/lib/errors';
import type {
  ImportCounts,
  ImportIssueDto,
  ImportReadyDto,
  ImportRowDto,
} from '@/shared/contracts';

interface ImportPreviewProps {
  preview: ImportReadyDto;
  busy: boolean;
  onCommit(): void;
  onCancel(): void;
}

const COUNTS: (keyof ImportCounts)[] = [
  'creates',
  'updates',
  'unchanged',
  'priceChanges',
  'openingBalances',
  'barcodeChanges',
];

/** The parsed file before anything is written: summary, issues, rows. */
export function ImportPreview({
  preview,
  busy,
  onCommit,
  onCancel,
}: ImportPreviewProps) {
  const { numberOptions, formatNumber } = useNumberFormat();
  const { t } = useTranslation();
  return (
    <Card data-testid="catalog-import-preview">
      <CardHeader>
        <CardTitle>
          {t('catalogTransfer.preview.title', { fileName: preview.fileName })}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section aria-labelledby="import-summary">
          <h3 id="import-summary" className="mb-1 text-sm font-medium">
            {t('catalogTransfer.preview.summary')}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {COUNTS.map((key) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">
                  {t(`catalogTransfer.preview.${key}`)}
                </dt>
                <dd
                  data-testid={`import-count-${key}`}
                  className="tabular-nums font-medium"
                >
                  {formatNumber(preview.summary[key])}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <IssueList
          testId="import-errors"
          title={t('catalogTransfer.preview.errors', {
            ...numberOptions,
            count: preview.errorCount,
          })}
          issues={preview.errors}
          total={preview.errorCount}
          tone="text-destructive"
          empty={t('catalogTransfer.preview.noErrors')}
        />
        {preview.warningCount > 0 ? (
          <IssueList
            testId="import-warnings"
            title={t('catalogTransfer.preview.warnings', {
              ...numberOptions,
              count: preview.warningCount,
            })}
            issues={preview.warnings}
            total={preview.warningCount}
            tone="text-amber-700 dark:text-amber-400"
          />
        ) : null}

        <RowTable preview={preview} />

        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          <span>{t('catalogTransfer.preview.backupNote')}</span>
        </p>
        {!preview.canCommit ? (
          <p className="text-sm text-destructive">
            {t('catalogTransfer.preview.blocked')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !preview.canCommit} onClick={onCommit}>
            {t('catalogTransfer.preview.commit')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('catalogTransfer.preview.cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function IssueList({
  testId,
  title,
  issues,
  total,
  tone,
  empty,
}: {
  testId: string;
  title: string;
  issues: ImportIssueDto[];
  total: number;
  tone: string;
  empty?: string;
}) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  return (
    <section data-testid={testId} aria-label={title}>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {issues.length === 0 && empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul
          className={`flex max-h-64 flex-col gap-1 overflow-auto text-sm ${tone}`}
        >
          {issues.map((issue, index) => (
            <li
              key={`${issue.row}-${issue.column}-${issue.error.code}-${index}`}
            >
              <span className="font-medium">
                {issue.row === null
                  ? t('catalogTransfer.preview.fileLevel')
                  : t('catalogTransfer.preview.row', { row: issue.row })}
                {issue.column ? ` · ${issue.column}` : ''}
                {issue.sku ? ` · ${issue.sku}` : ''}
              </span>
              {': '}
              {errorMessage(t, issue.error)}
            </li>
          ))}
          {total > issues.length ? (
            <li className="text-muted-foreground">
              {t('catalogTransfer.preview.moreIssues', {
                ...numberOptions,
                count: total - issues.length,
              })}
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function RowTable({ preview }: { preview: ImportReadyDto }) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  if (preview.rows.length === 0) return null;
  return (
    <section aria-labelledby="import-rows">
      <h3 id="import-rows" className="mb-1 text-sm font-medium">
        {t('catalogTransfer.preview.rows', {
          ...numberOptions,
          count: preview.totalRows,
        })}
      </h3>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm" data-testid="import-rows">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="px-2 py-2">
                {t('catalogTransfer.columns.row')}
              </th>
              <th scope="col" className="px-2 py-2">
                {t('catalogTransfer.columns.sku')}
              </th>
              <th scope="col" className="px-2 py-2">
                {t('catalogTransfer.columns.title')}
              </th>
              <th scope="col" className="px-2 py-2">
                {t('references.entities.stockLocation')}
              </th>
              <th scope="col" className="px-2 py-2">
                {t('catalogTransfer.columns.action')}
              </th>
              <th scope="col" className="px-2 py-2">
                {t('catalogTransfer.columns.details')}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.row} className="border-t border-border align-top">
                <td className="px-2 py-2 tabular-nums">{row.row}</td>
                <td className="px-2 py-2 font-mono text-xs leading-5">
                  {row.sku}
                </td>
                <td className="whitespace-pre-line px-2 py-2">{row.title}</td>
                <td className="px-2 py-2">
                  {row.stockLocation
                    ? `${row.stockLocation.code} · ${row.stockLocation.label}`
                    : '—'}
                </td>
                <td
                  className={
                    row.action === 'INVALID'
                      ? 'px-2 py-2 text-destructive'
                      : 'px-2 py-2'
                  }
                >
                  {t(`catalogTransfer.action.${row.action}`)}
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  <RowDetails row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.rowsTruncated ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {t('catalogTransfer.preview.truncated', {
            ...numberOptions,
            shown: preview.rows.length,
          })}
        </p>
      ) : null}
    </section>
  );
}

function RowDetails({ row }: { row: ImportRowDto }) {
  const { numberOptions, formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const lines: string[] = [];
  if (row.changedFields.length > 0) {
    lines.push(
      t('catalogTransfer.details.fields', {
        fields: row.changedFields
          .map((field) => t(`catalogTransfer.field.${field}`))
          .join(', '),
      }),
    );
  }
  for (const price of row.priceChanges) {
    lines.push(
      t('catalogTransfer.details.price', {
        channel: price.channelCode,
        from: price.from === null ? '-' : formatIdr(price.from),
        to: formatIdr(price.to),
      }),
    );
  }
  const barcodes = [...row.barcodesAdded, ...row.barcodesActivated];
  if (barcodes.length > 0) {
    lines.push(
      t('catalogTransfer.details.barcodes', { barcodes: barcodes.join(', ') }),
    );
  }
  if (row.openingStock !== null) {
    lines.push(
      t('catalogTransfer.details.openingStock', {
        ...numberOptions,
        count: row.openingStock,
      }),
    );
  }
  return (
    <ul className="flex flex-col">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
