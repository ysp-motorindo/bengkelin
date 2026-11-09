import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DraftLineDto, ReferenceDto } from '@/shared/contracts';
import { EditableLineRow } from './EditableLineRow';
import type { DraftCommands } from './use-draft-commands';
import { ResizableTransactionTable } from '@/renderer/components/resizable-transaction-table';
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
    t('workspace.lines.code'),
    t('workspace.lines.item'),
    t('workspace.custom.unit'),
    t('workspace.lines.stock'),
    t('workspace.lines.quantity'),
    t('workspace.lines.unitPrice'),
    ...Array.from({ length: 4 }, (_, i) => `D${i + 1}`),
    t('workspace.lines.amount'),
    t('workspace.lines.actions'),
  ];
  const minimumWidths = [32, 96, 192, 56, 64, 64, 112, 56, 56, 56, 56, 128, 80];
  return (
    <ResizableTransactionTable
      caption={t('workspace.lines.caption')}
      columns={headings.map((label, i) => ({
        label,
        minWidth: minimumWidths[i]!,
      }))}
      storageKey="bengkelin.transaction-column-widths.v1"
    >
      {lines.map((line, index) => (
        <EditableLineRow
          key={line.id}
          line={line}
          rowNumber={index + 1}
          commands={commands}
          mechanics={mechanics}
          onRemove={onRemove}
        />
      ))}
      {entryRow}
      {!lines.length && (
        <tr>
          <td
            colSpan={13}
            data-testid="lines-empty"
            className="px-4 py-8 text-center text-muted-foreground"
          >
            {t('workspace.lines.empty')}
          </td>
        </tr>
      )}
    </ResizableTransactionTable>
  );
}
