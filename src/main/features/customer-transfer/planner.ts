import {
  saveCustomerInputSchema,
  type CustomerDto,
  type CustomerImportIssueDto,
  type CustomerImportRowDto,
} from '@/shared/contracts';
import type { CustomerFields } from '@/main/features/customers/repository';
import { normalizePhone } from '@/main/features/vehicles/normalization';
import type { CustomerTransferRepository } from './repository';
export const CUSTOMER_COLUMNS = [
  'external_id',
  'name',
  'phone_number',
  'address',
  'city_or_regency',
  'is_active',
] as const;
export function customerIssue(
  code: string,
  row: number | null = null,
  column: string | null = null,
  externalId: string | null = null,
): CustomerImportIssueDto {
  return {
    row,
    column,
    externalId,
    error: {
      code,
      messageKey: `errors.${code}`,
      ...(code === 'FILE_TOO_LARGE' ? { params: { maxMegabytes: '5' } } : {}),
    },
  };
}
// Guarded text escapes an initial apostrophe too, making conversion reversible.
export function decodeCustomerText(value: string): string {
  return /^'(?:['=+\-@\t\r])/.test(value) ? value.slice(1) : value;
}
export interface CustomerPlanItem {
  existing: CustomerDto | null;
  externalId: string;
  fields: CustomerFields;
  dto: CustomerImportRowDto;
}
export interface CustomerImportPlan {
  items: CustomerPlanItem[];
  rows: CustomerImportRowDto[];
  errors: CustomerImportIssueDto[];
  warnings: CustomerImportIssueDto[];
  summary: { creates: number; updates: number; unchanged: number };
}
export function planCustomerImport(
  records: string[][],
  repo: CustomerTransferRepository,
): CustomerImportPlan {
  const plan: CustomerImportPlan = {
    items: [],
    rows: [],
    errors: [],
    warnings: [],
    summary: { creates: 0, updates: 0, unchanged: 0 },
  };
  const header = records[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  if (
    header.length !== CUSTOMER_COLUMNS.length ||
    new Set(header).size !== header.length ||
    CUSTOMER_COLUMNS.some((x) => !header.includes(x))
  ) {
    plan.errors.push(
      customerIssue(
        header.length === 0 ? 'EMPTY_FILE' : 'CUSTOMER_IMPORT_HEADER',
      ),
    );
    return plan;
  }
  if (records.length === 1) plan.errors.push(customerIssue('NO_DATA_ROWS'));
  const existing = repo.all();
  const byExternalId = new Map(
    existing
      .filter((x) => x.externalId !== null)
      .map((x) => [x.externalId!, x]),
  );
  const seen = new Set<string>();
  records.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const cell = (key: (typeof CUSTOMER_COLUMNS)[number]) =>
      decodeCustomerText(cells[header.indexOf(key)] ?? '').trim();
    const externalId = cell('external_id');
    const current = byExternalId.get(externalId) ?? null;
    const dto: CustomerImportRowDto = {
      row,
      externalId,
      name: cell('name') || current?.name || null,
      action: 'INVALID',
      changedFields: [],
    };
    plan.rows.push(dto);
    if (
      cells.length !== header.length ||
      externalId.length === 0 ||
      externalId.length > 120 ||
      !['true', 'false'].includes(cell('is_active'))
    ) {
      plan.errors.push(
        customerIssue('CUSTOMER_IMPORT_INVALID_ROW', row, null, externalId),
      );
      return;
    }
    if (seen.has(externalId)) {
      plan.errors.push(
        customerIssue(
          'CUSTOMER_IMPORT_DUPLICATE_ID',
          row,
          'external_id',
          externalId,
        ),
      );
      return;
    }
    seen.add(externalId);
    const {
      id: _existingId,
      externalId: _external,
      createdAt: _created,
      updatedAt: _updated,
      ...preserved
    } = current ?? {};
    const parsed = saveCustomerInputSchema.safeParse({
      ...preserved,
      name: cell('name') || current?.name,
      phoneNumber: cell('phone_number') || current?.phoneNumber,
      address: cell('address') || current?.address,
      cityOrRegency: cell('city_or_regency') || current?.cityOrRegency,
      isActive: cell('is_active') === 'true',
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        plan.errors.push(
          customerIssue(
            'CUSTOMER_IMPORT_INVALID_ROW',
            row,
            String(issue.path[0] ?? ''),
            externalId,
          ),
        );
      return;
    }
    const { id: _id, acknowledgeDuplicates: _ack, ...fields } = parsed.data;
    if (!fields.name && !fields.phoneNumber) {
      plan.errors.push(
        customerIssue('CUSTOMER_NAME_OR_PHONE_REQUIRED', row, null, externalId),
      );
      return;
    }
    const customerFields: CustomerFields = {
      ...fields,
      isActive: fields.isActive ?? true,
    };
    dto.changedFields = (
      Object.keys(customerFields) as (keyof CustomerFields)[]
    ).filter((key) => !current || current[key] !== customerFields[key]);
    dto.action = current
      ? dto.changedFields.length
        ? 'UPDATE'
        : 'UNCHANGED'
      : 'CREATE';
    plan.items.push({
      existing: current,
      externalId,
      fields: customerFields,
      dto,
    });
    plan.summary[
      dto.action === 'CREATE'
        ? 'creates'
        : dto.action === 'UPDATE'
          ? 'updates'
          : 'unchanged'
    ]++;
  });
  const finalPhones = new Map(
    existing.map((c) => [c.id, normalizePhone(c.phoneNumber ?? '')]),
  );
  for (const item of plan.items)
    finalPhones.set(
      item.existing?.id ?? `import:${item.externalId}`,
      normalizePhone(item.fields.phoneNumber ?? ''),
    );
  const phoneCounts = new Map<string, number>();
  for (const phone of finalPhones.values())
    if (phone) phoneCounts.set(phone, (phoneCounts.get(phone) ?? 0) + 1);
  for (const item of plan.items) {
    const phone = normalizePhone(item.fields.phoneNumber ?? '');
    if (phone && (phoneCounts.get(phone) ?? 0) > 1)
      plan.warnings.push(
        customerIssue(
          'DUPLICATE_PHONE',
          item.dto.row,
          'phone_number',
          item.externalId,
        ),
      );
  }
  return plan;
}
