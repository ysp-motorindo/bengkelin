import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DraftLineDto, ReferenceDto } from '@/shared/contracts';
import { EditableLineRow } from './EditableLineRow';
import type { DraftCommands } from './use-draft-commands';
interface Props {
  lines: DraftLineDto[];
  commands: DraftCommands;
  mechanics: ReferenceDto[];
  entryRow?: ReactNode;
  onRemove(line: DraftLineDto): boolean | Promise<boolean>;
}
export function LinesTable({
  lines,
  commands,
  mechanics,
  entryRow,
  onRemove,
}: Props) {
  const { t } = useTranslation();
  const headings = [
    '#',
    t('workspace.lines.item'),
    t('workspace.custom.unit'),
    t('workspace.lines.quantity'),
    t('workspace.lines.unitPrice'),
    ...Array.from({ length: 4 }, (_, i) => `D${i + 1}`),
    t('workspace.lines.amount'),
    t('workspace.lines.actions'),
  ];
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[64rem] table-fixed border-collapse text-xs">
        <caption className="sr-only">{t('workspace.lines.caption')}</caption>
        <colgroup>
          <col className="w-8" />
          <col />
          <col className="w-14" />
          <col className="w-16" />
          <col className="w-28" />
          {[1, 2, 3, 4].map((i) => (
            <col key={i} className="w-14" />
          ))}
          <col className="w-32" />
          <col className="w-20" />
        </colgroup>
        <thead className="bg-sunken text-left font-semibold text-muted-foreground">
          <tr>
            {headings.map((label, index) => (
              <th
                scope="col"
                key={index}
                className="border-b border-border px-2 py-2"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <EditableLineRow
              key={line.id}
              line={line}
              commands={commands}
              mechanics={mechanics}
              onRemove={onRemove}
            />
          ))}
          {entryRow}
          {!lines.length && (
            <tr>
              <td
                colSpan={11}
                data-testid="lines-empty"
                className="px-4 py-8 text-center text-muted-foreground"
              >
                {t('workspace.lines.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
