import {
  saveSupplierInputSchema,
  type SupplierDto,
  type SupplierImportIssueDto,
  type SupplierImportRowDto,
} from '@/shared/contracts';
import { parseRupiah, formatRupiah } from '@/shared/primitives';
import { isLocalDate } from '@/shared/contracts';
type SupplierFields = Pick<
  SupplierDto,
  'name' | 'phoneNumber' | 'email' | 'address' | 'isActive'
>;
import { normalizePhone } from '@/main/features/vehicles/normalization';
import type { SupplierTransferRepository } from './repository';
export const SUPPLIER_COLUMNS = [
  'external_id',
  'name',
  'phone_number',
  'address',
  'email',
  'as_of_date',
  'opening_balance',
  'is_active',
] as const;
export function supplierIssue(
  code: string,
  row: number | null = null,
  column: string | null = null,
  externalId: string | null = null,
): SupplierImportIssueDto {
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
export function decodeSupplierText(value: string): string {
  return /^'(?:['=+\-@\t\r])/.test(value) ? value.slice(1) : value;
}
export interface SupplierPlanItem {
  existing: SupplierDto | null;
  externalId: string;
  fields: SupplierFields;
  opening: { amount: string; date: string } | null;
  dto: SupplierImportRowDto;
}
export interface SupplierImportPlan {
  items: SupplierPlanItem[];
  rows: SupplierImportRowDto[];
  errors: SupplierImportIssueDto[];
  warnings: SupplierImportIssueDto[];
  summary: {
    suppliers: { creates: number; updates: number; unchanged: number };
    openings: { creates: number; unchanged: number; skipped: number };
  };
  totalOpeningAmount: string;
}
export function planSupplierImport(
  records: string[][],
  repo: SupplierTransferRepository,
): SupplierImportPlan {
  const plan: SupplierImportPlan = {
    items: [],
    rows: [],
    errors: [],
    warnings: [],
    summary: {
      suppliers: { creates: 0, updates: 0, unchanged: 0 },
      openings: { creates: 0, unchanged: 0, skipped: 0 },
    },
    totalOpeningAmount: '0',
  };
  const header = records[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  if (
    header.length !== SUPPLIER_COLUMNS.length ||
    new Set(header).size !== header.length ||
    SUPPLIER_COLUMNS.some((x) => !header.includes(x))
  ) {
    plan.errors.push(
      supplierIssue(
        header.length === 0 ? 'EMPTY_FILE' : 'SUPPLIER_IMPORT_HEADER',
      ),
    );
    return plan;
  }
  if (records.length === 1) plan.errors.push(supplierIssue('NO_DATA_ROWS'));
  const existing = repo.all();
  const byExternalId = new Map(
    existing
      .filter((x) => x.externalId !== null)
      .map((x) => [x.externalId!, x]),
  );
  const seen = new Set<string>();
  records.slice(1).forEach((cells, index) => {
    const row = index + 2;
    const cell = (key: (typeof SUPPLIER_COLUMNS)[number]) =>
      decodeSupplierText(cells[header.indexOf(key)] ?? '').trim();
    const externalId = cell('external_id');
    const current = byExternalId.get(externalId) ?? null;
    const dto: SupplierImportRowDto = {
      row,
      externalId,
      name: cell('name') || current?.name || null,
      action: 'INVALID',
      changedFields: [],
      openingAction: 'INVALID',
      asOfDate: cell('as_of_date') || null,
      openingBalance: cell('opening_balance') || null,
    };
    plan.rows.push(dto);
    if (
      cells.length !== header.length ||
      externalId.length === 0 ||
      externalId.length > 120 ||
      !['true', 'false'].includes(cell('is_active'))
    ) {
      plan.errors.push(
        supplierIssue('SUPPLIER_IMPORT_INVALID_ROW', row, null, externalId),
      );
      return;
    }
    if (seen.has(externalId)) {
      plan.errors.push(
        supplierIssue(
          'SUPPLIER_IMPORT_DUPLICATE_ID',
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
      version: _version,
      createdAt: _created,
      updatedAt: _updated,
      ...preserved
    } = current ?? {};
    const parsed = saveSupplierInputSchema.safeParse({
      ...preserved,
      requestId: '11111111-1111-4111-8111-111111111111',
      name: cell('name') || current?.name,
      phoneNumber: cell('phone_number') || current?.phoneNumber,
      address: cell('address') || current?.address,
      email: cell('email') || current?.email,
      isActive: cell('is_active') === 'true',
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        plan.errors.push(
          supplierIssue(
            'SUPPLIER_IMPORT_INVALID_ROW',
            row,
            String(issue.path[0] ?? ''),
            externalId,
          ),
        );
      return;
    }
    const {
      id: _id,
      expectedVersion: _expected,
      requestId: _request,
      acknowledgeDuplicates: _ack,
      ...fields
    } = parsed.data;
    if (!fields.name && !fields.phoneNumber) {
      plan.errors.push(
        supplierIssue('SUPPLIER_NAME_OR_PHONE_REQUIRED', row, null, externalId),
      );
      return;
    }
    const supplierFields: SupplierFields = {
      ...fields,
      isActive: fields.isActive ?? true,
    };
    dto.changedFields = (
      Object.keys(supplierFields) as (keyof SupplierFields)[]
    ).filter((key) => !current || current[key] !== supplierFields[key]);
    dto.action = current
      ? dto.changedFields.length
        ? 'UPDATE'
        : 'UNCHANGED'
      : 'CREATE';
    let opening: { amount: string; date: string } | null = null;
    const date = cell('as_of_date'),
      amount = cell('opening_balance');
    if (!date && !amount) {
      dto.openingAction = 'SKIPPED';
      plan.summary.openings.skipped++;
    } else {
      try {
        if (!isLocalDate(date)) throw Error();
        const parsed = parseRupiah(amount);
        if (parsed < 0n) throw Error();
        const existing = current
          ? (repo.db
              .prepare(
                'SELECT amount,as_of_date FROM supplier_opening_balances WHERE supplier_id=?',
              )
              .get(current.id) as
              | { amount: bigint; as_of_date: string }
              | undefined)
          : undefined;
        if (
          existing &&
          (existing.amount !== parsed || existing.as_of_date !== date)
        )
          throw Error();
        plan.totalOpeningAmount = formatRupiah(
          parseRupiah(plan.totalOpeningAmount) + parsed,
        );
        dto.openingAction = existing ? 'UNCHANGED' : 'CREATE';
        plan.summary.openings[existing ? 'unchanged' : 'creates']++;
        if (!existing) opening = { amount, date };
      } catch {
        dto.action = 'INVALID';
        dto.openingAction = 'INVALID';
        plan.errors.push(
          supplierIssue(
            'SUPPLIER_IMPORT_OPENING',
            row,
            'opening_balance',
            externalId,
          ),
        );
        return;
      }
    }
    plan.items.push({
      existing: current,
      externalId,
      fields: supplierFields,
      dto,
      opening,
    });
    plan.summary.suppliers[
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
        supplierIssue(
          'DUPLICATE_PHONE',
          item.dto.row,
          'phone_number',
          item.externalId,
        ),
      );
  }
  return plan;
}
