import {
  saveReferenceInputSchema,
  type ReferenceDto,
  type ReferenceImportEntity,
  type ReferenceImportIssueDto,
  type ReferenceImportRowDto,
} from '@/shared/contracts';
import { decodeCustomerText } from '@/main/features/customer-transfer/planner';
import type { ReferenceTransferRepository } from './repository';
export const referenceColumns = (entity: ReferenceImportEntity) => [
  'code',
  'name',
  'address',
  'city',
  ...(entity === 'sales' ? ['phone_number'] : []),
  'is_active',
];
export function referenceIssue(
  code: string,
  row: number | null = null,
  column: string | null = null,
  referenceCode: string | null = null,
): ReferenceImportIssueDto {
  return {
    row,
    column,
    code: referenceCode,
    error: {
      code,
      messageKey: `errors.${code}`,
      ...(code === 'FILE_TOO_LARGE' ? { params: { maxMegabytes: '5' } } : {}),
    },
  };
}
export interface ReferencePlanItem {
  existing: ReferenceDto | null;
  fields: {
    code: string;
    label: string;
    address: string | null;
    city: string | null;
    phoneNumber: string | null;
    isActive: boolean;
  };
  dto: ReferenceImportRowDto;
}
export interface ReferenceImportPlan {
  items: ReferencePlanItem[];
  rows: ReferenceImportRowDto[];
  errors: ReferenceImportIssueDto[];
  warnings: ReferenceImportIssueDto[];
  summary: { creates: number; updates: number; unchanged: number };
}
export function planReferenceImport(
  records: string[][],
  repo: ReferenceTransferRepository,
  entity: ReferenceImportEntity,
): ReferenceImportPlan {
  const plan: ReferenceImportPlan = {
    items: [],
    rows: [],
    errors: [],
    warnings: [],
    summary: { creates: 0, updates: 0, unchanged: 0 },
  };
  const header = records[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  const columns = referenceColumns(entity);
  if (
    header.length !== columns.length ||
    new Set(header).size !== header.length ||
    columns.some((x) => !header.includes(x))
  ) {
    plan.errors.push(
      referenceIssue(header.length ? 'REFERENCE_IMPORT_HEADER' : 'EMPTY_FILE'),
    );
    return plan;
  }
  if (records.length === 1) plan.errors.push(referenceIssue('NO_DATA_ROWS'));
  const existing = new Map(repo.all(entity).map((x) => [x.code!, x]));
  const seen = new Set<string>();
  records.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const cell = (key: string) =>
      decodeCustomerText(cells[header.indexOf(key)] ?? '').trim();
    const code = cell('code').toUpperCase();
    const current = existing.get(code) ?? null;
    const dto: ReferenceImportRowDto = {
      row,
      code,
      name: cell('name') || null,
      action: 'INVALID',
      changedFields: [],
    };
    plan.rows.push(dto);
    if (seen.has(code)) {
      plan.errors.push(
        referenceIssue('REFERENCE_IMPORT_DUPLICATE_CODE', row, 'code', code),
      );
      return;
    }
    seen.add(code);
    if (cells.length !== header.length) {
      plan.errors.push(
        referenceIssue('REFERENCE_IMPORT_INVALID_ROW', row, null, code),
      );
      return;
    }
    if (!['true', 'false'].includes(cell('is_active'))) {
      plan.errors.push(
        referenceIssue('REFERENCE_IMPORT_INVALID_ROW', row, 'is_active', code),
      );
      return;
    }
    const parsed = saveReferenceInputSchema.safeParse({
      entity,
      code,
      label: cell('name'),
      address: cell('address') || current?.address,
      city: cell('city') || current?.city,
      ...(entity === 'sales'
        ? { phoneNumber: cell('phone_number') || current?.phoneNumber }
        : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        const column =
          field === 'label'
            ? 'name'
            : field === 'phoneNumber'
              ? 'phone_number'
              : field;
        plan.errors.push(
          referenceIssue(
            'REFERENCE_IMPORT_INVALID_ROW',
            row,
            columns.includes(column) ? column : null,
            code,
          ),
        );
      }
      return;
    }
    if (parsed.data.entity !== 'sales' && parsed.data.entity !== 'expedition')
      throw new Error('Unexpected reference entity');
    const data = parsed.data;
    const fields = {
      code,
      label: data.label,
      address: data.address,
      city: data.city,
      phoneNumber: data.entity === 'sales' ? data.phoneNumber : null,
      isActive: cell('is_active') === 'true',
    };
    dto.changedFields = (Object.keys(fields) as (keyof typeof fields)[]).filter(
      (key) => !current || current[key] !== fields[key],
    );
    dto.action = current
      ? dto.changedFields.length
        ? 'UPDATE'
        : 'UNCHANGED'
      : 'CREATE';
    plan.items.push({ existing: current, fields, dto });
    plan.summary[
      dto.action === 'CREATE'
        ? 'creates'
        : dto.action === 'UPDATE'
          ? 'updates'
          : 'unchanged'
    ]++;
  });
  return plan;
}
