import path from 'node:path';
import { CHANNELS } from '@/shared/channels';
import type {
  CatalogItemDto,
  DraftOperation,
  DraftView,
  FinalizePreviewDto,
  InvoiceView,
  PricePreviewDto,
  PriceTimelineDto,
  ReferenceDto,
  SaveCustomerResult,
  SaveVehicleResult,
} from '@/shared/contracts';
import type { Instant, Result } from '@/shared/primitives';
import { toInstant } from '@/shared/time';

/**
 * A representative workshop, built only through the app's own commands
 * (T18 migration fixture; T11/T12/T14 fixture patterns): settings and
 * print settings, cashiers (one deactivated), mechanics, a vehicle brand
 * and model, customers and vehicles, catalog items with barcodes, start-only
 * prices (a correction and a scheduled future price), a stock ledger
 * (opening balances, receipts, sales and a void reversal), invoices that are
 * PAID, PARTIALLY_PAID with a later payment, VOID, an open draft and a
 * discarded draft, print jobs (PRINT and PDF_EXPORT) and a backup run.
 */

const C = CHANNELS;
export const FIXTURE_ADMIN = {
  username: 'admin',
  password: 'correct-horse-battery',
};
export const FIXTURE_CASHIER = {
  username: 'siti',
  password: 'siti-password-1',
};
const ADMIN = 1;
const CASHIER = 2;

export interface FixtureContext {
  call<T = unknown>(
    channel: string,
    input?: unknown,
    windowId?: number,
  ): Promise<Result<T>>;
  /** Moves the injected clock (the fixture's "now"). */
  setNow(ms: number): void;
  /** A folder for exported PDFs (answers the save dialog). */
  exportDir: string;
  /** Queues the next save-dialog answer (FakeDialogs.saveAnswers). */
  answerSave(file: string): void;
}

function ok<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what}: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Wall-clock time in Jakarta as epoch ms. */
const wib = (date: string, time: string) =>
  Date.parse(`${date}T${time}:00.000+07:00`);
const at = (ms: number): Instant => toInstant(ms);

let counter = 0;
function requestId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export interface PopulatedWorkshop {
  invoices: { paid: InvoiceView; partial: InvoiceView; voided: InvoiceView };
  openDraftId: string;
  discardedDraftId: string;
}

export async function populateWorkshop(
  ctx: FixtureContext,
): Promise<PopulatedWorkshop> {
  counter = 0;
  const call = ctx.call.bind(ctx);
  ctx.setNow(wib('2026-09-28', '08:00'));

  // ---- setup, cashiers, settings ----
  ok(
    await call(C.settings.completeSetup, {
      shop: {
        name: 'Bengkel Maju Jaya',
        address: 'Jl. Merdeka No. 1, Bandung',
        phoneNumber: '081234567890',
        timezone: 'Asia/Jakarta',
      },
      admin: {
        username: FIXTURE_ADMIN.username,
        displayName: 'Pak Budi',
        password: FIXTURE_ADMIN.password,
      },
      preferences: { language: 'id', appearance: 'SYSTEM' },
    }),
    'setup',
  );
  ok(await call(C.auth.login, FIXTURE_ADMIN, ADMIN), 'admin login');
  ok(
    await call(
      C.cashiers.create,
      {
        username: FIXTURE_CASHIER.username,
        displayName: 'Siti',
        password: FIXTURE_CASHIER.password,
        role: 'CASHIER',
      },
      ADMIN,
    ),
    'cashier siti',
  );
  const joko = ok(
    await call<{ id: string }>(
      C.cashiers.create,
      {
        username: 'joko',
        displayName: 'Joko',
        password: 'joko-password-1',
        role: 'CASHIER',
      },
      ADMIN,
    ),
    'cashier joko',
  );
  ok(
    await call(C.cashiers.deactivate, { cashierId: joko.id }, ADMIN),
    'deactivate joko',
  );
  ok(await call(C.auth.login, FIXTURE_CASHIER, CASHIER), 'cashier login');
  ok(
    await call(
      C.printing.updateSettings,
      {
        defaultInvoiceFormat: 'THERMAL',
        thermalPaperWidthMm: 58,
        defaultA4PrinterName: '',
        defaultThermalPrinterName: '',
        autoPrintAfterFinalize: false,
      },
      ADMIN,
    ),
    'print settings',
  );

  // ---- reference data ----
  const ref = async (input: Record<string, unknown>) =>
    ok(await call<ReferenceDto>(C.references.save, input, ADMIN), 'reference');
  const andi = await ref({ entity: 'mechanic', name: 'Andi' });
  await ref({ entity: 'mechanic', name: 'Rudi' });
  const honda = await ref({ entity: 'vehicleBrand', name: 'Honda' });
  const vario = await ref({
    entity: 'vehicleModel',
    brandId: honda.id,
    name: 'Vario 160',
  });
  const list = async (entity: string) =>
    ok(
      await call<ReferenceDto[]>(C.references.list, { entity }, ADMIN),
      entity,
    );
  const channels = await list('channel');
  const units = await list('unit');
  const bengkel = channels.find((c) => c.code === 'BENGKEL')!.id;
  const shopee = channels.find((c) => c.code === 'SHOPEE')!.id;
  const pcs = units.find((u) => u.code === 'PCS')!.id;
  const serviceUnit = units.find((u) => u.code === 'SERVICE')!.id;

  // ---- customers and vehicles ----
  const customer = async (name: string, phoneNumber?: string) => {
    const saved = ok(
      await call<SaveCustomerResult>(
        C.customers.save,
        { name, ...(phoneNumber ? { phoneNumber } : {}) },
        CASHIER,
      ),
      name,
    );
    if (!saved.saved) throw new Error(`customer ${name} not saved`);
    return saved.customer;
  };
  const andiCustomer = await customer('Andi Wijaya', '0812-3456-7890');
  const dewi = await customer('Dewi Lestari', '+62 813 1111 2222');
  const vehicle = async (input: Record<string, unknown>) =>
    ok(
      await call<SaveVehicleResult>(C.vehicles.save, input, CASHIER),
      'vehicle',
    ).vehicle;
  const motor = await vehicle({
    plateNumber: 'D 1234 ABC',
    ownerCustomerId: andiCustomer.id,
    brandId: honda.id,
    vehicleModelId: vario.id,
    color: 'Merah',
  });
  await vehicle({ plateNumber: 'b 9876-xyz', ownerCustomerId: dewi.id });

  // ---- catalog, barcodes, start-only prices ----
  const item = async (input: Record<string, unknown>) =>
    ok(await call<CatalogItemDto>(C.catalog.save, input, ADMIN), 'item');
  const price = async (
    catalogItemId: string,
    amount: string,
    startMs: number,
    extra: Record<string, unknown> = {},
    channelId = bengkel,
  ) => {
    const preview = ok(
      await call<PricePreviewDto>(
        C.catalog.previewPriceChange,
        {
          catalogItemId,
          channelId,
          effectiveStartAt: at(startMs),
          price: amount,
          ...extra,
        },
        ADMIN,
      ),
      'price preview',
    );
    ok(
      await call(C.catalog.applyPriceChange, { token: preview.token }, ADMIN),
      'price apply',
    );
  };
  const oil = await item({
    type: 'STOCK_ITEM',
    title: 'Oli MPX2 0.8L',
    sku: 'OLI-MPX2-08',
    unitId: pcs,
    weight: 800,
  });
  const helmet = await item({
    type: 'STOCK_ITEM',
    title: 'Helm Bogo Retro Klasik Warna Hitam Doff Ukuran L',
    unitId: pcs,
  });
  const service = await item({
    type: 'SERVICE',
    title: 'Servis ringan',
    unitId: serviceUnit,
  });
  for (const [catalogItemId, barcodes] of [
    [oil.id, ['8991234567890']],
    [helmet.id, ['8990000000017', '8990000000024']],
  ] as const) {
    ok(
      await call(
        C.catalog.saveBarcodes,
        {
          catalogItemId,
          barcodes: barcodes.map((barcode) => ({ barcode, isActive: true })),
        },
        ADMIN,
      ),
      'barcodes',
    );
  }
  const jan1 = Date.parse('2026-01-01T00:00:00.000Z');
  await price(oil.id, '60000', jan1);
  // An explicit correction of the first revision (kept, superseded).
  const oilTimeline = ok(
    await call<PriceTimelineDto>(
      C.catalog.listPrices,
      { catalogItemId: oil.id },
      ADMIN,
    ),
    'oil prices',
  );
  await price(oil.id, '65000', jan1, {
    correctsPriceId: oilTimeline.points[0]!.id,
    reason: 'Salah ketik harga',
  });
  // A scheduled future price (start-only; never ends).
  await price(oil.id, '70000', wib('2026-12-01', '00:00'));
  await price(oil.id, '72000', jan1, {}, shopee);
  await price(helmet.id, '100000', jan1);
  await price(service.id, '50000', jan1);

  // ---- stock ----
  const stock = async (
    channel: string,
    catalogItemId: string,
    quantity: number,
  ) =>
    ok(
      await call(
        channel,
        { requestId: requestId(), catalogItemId, quantity },
        ADMIN,
      ),
      'stock',
    );
  await stock(C.inventory.openBalance, oil.id, 20);
  await stock(C.inventory.openBalance, helmet.id, 5);
  await stock(C.inventory.receive, oil.id, 12);

  // ---- invoices ----
  ctx.setNow(wib('2026-09-30', '09:15'));
  const createDraft = async (channelId = bengkel) =>
    ok(
      await call<DraftView>(
        C.drafts.create,
        {
          requestId: requestId(),
          channelId,
          invoiceDate: '2026-09-30',
          pricingAt: at(wib('2026-09-30', '09:15')),
        },
        CASHIER,
      ),
      'draft',
    );
  const apply = async (draft: DraftView, op: DraftOperation) =>
    ok(
      await call<DraftView>(
        C.drafts.apply,
        {
          requestId: requestId(),
          invoiceId: draft.id,
          expectedVersion: draft.version,
          op,
        },
        CASHIER,
      ),
      op.kind,
    );
  const finalize = async (draft: DraftView) => {
    const shown = ok(
      await call<FinalizePreviewDto>(
        C.invoices.previewFinalize,
        { invoiceId: draft.id },
        CASHIER,
      ),
      'preview finalize',
    );
    if (shown.errors.length) {
      throw new Error(`finalize blocked: ${JSON.stringify(shown.errors)}`);
    }
    return ok(
      await call<InvoiceView>(
        C.invoices.finalize,
        {
          requestId: requestId(),
          invoiceId: draft.id,
          expectedVersion: shown.draftVersion,
          acknowledgedWarnings: shown.warnings,
        },
        CASHIER,
      ),
      'finalize',
    );
  };
  const lastLine = (draft: DraftView) => draft.lines[draft.lines.length - 1]!;

  // PAID: stock + service with mechanic, customer, vehicle, odometer, discounts.
  let draft = await createDraft();
  draft = await apply(draft, {
    kind: 'updateHeader',
    changes: {
      customerId: andiCustomer.id,
      vehicleId: motor.id,
      odometerKm: 12_345,
      note: 'Ganti oli dan servis',
    },
  });
  draft = await apply(draft, {
    kind: 'addCatalogLine',
    barcode: '8991234567890',
    quantity: 2,
  });
  draft = await apply(draft, {
    kind: 'addCatalogLine',
    catalogItemId: service.id,
  });
  draft = await apply(draft, {
    kind: 'updateLine',
    lineId: lastLine(draft).id,
    mechanicId: andi.id,
  });
  draft = await apply(draft, {
    kind: 'addCustomLine',
    type: 'NON_STOCK_ITEM',
    title: 'Busi NGK CPR9EA-9',
    unitPrice: '25000',
  });
  draft = await apply(draft, { kind: 'setInvoiceDiscounts', stages: [1000] });
  const paidTotal = draft.totals.amount;
  draft = await apply(draft, {
    kind: 'setCheckoutAllocations',
    allocations: [{ method: 'CASH', amount: paidTotal }],
  });
  const paid = await finalize(draft);

  // PARTIALLY_PAID: 100000 -> 30/50/10 -> 31500, TOP 14 days, a later payment.
  ctx.setNow(wib('2026-09-30', '10:30'));
  draft = await createDraft();
  draft = await apply(draft, {
    kind: 'updateHeader',
    changes: { customerId: dewi.id, topDays: 14 },
  });
  draft = await apply(draft, {
    kind: 'addCatalogLine',
    catalogItemId: helmet.id,
  });
  draft = await apply(draft, {
    kind: 'setLineDiscounts',
    lineId: lastLine(draft).id,
    stages: [3000, 5000, 1000],
  });
  draft = await apply(draft, { kind: 'addCatalogLine', catalogItemId: oil.id });
  draft = await apply(draft, {
    kind: 'updateLine',
    lineId: lastLine(draft).id,
    unitPrice: '62000',
    reason: 'Harga langganan',
  });
  draft = await apply(draft, {
    kind: 'setCheckoutAllocations',
    allocations: [
      { method: 'CASH', amount: '20000' },
      { method: 'QRIS', amount: '10000', reference: 'QR-001' },
    ],
  });
  let partial = await finalize(draft);
  ctx.setNow(wib('2026-10-01', '11:00'));
  partial = ok(
    await call<InvoiceView>(
      C.invoices.recordPayment,
      {
        requestId: requestId(),
        invoiceId: partial.id,
        method: 'BANK_TRANSFER',
        amount: '15000',
      },
      CASHIER,
    ),
    'later payment',
  );

  // VOID: finalized without payment, then voided (stock is reversed).
  draft = await createDraft();
  draft = await apply(draft, {
    kind: 'addCatalogLine',
    catalogItemId: oil.id,
    quantity: 3,
  });
  draft = await apply(draft, {
    kind: 'addCustomLine',
    type: 'NON_STOCK_ITEM',
    title: 'Stiker bengkel',
    unitId: pcs,
    unitPrice: '5000',
  });
  const toVoid = await finalize(draft);
  ctx.setNow(wib('2026-10-01', '13:00'));
  const voided = ok(
    await call<InvoiceView>(
      C.invoices.void,
      {
        requestId: requestId(),
        invoiceId: toVoid.id,
        reason: 'Salah input barang',
      },
      ADMIN,
    ),
    'void',
  );

  // An open draft (Shopee channel) and a discarded draft.
  let open = await createDraft(shopee);
  open = await apply(open, { kind: 'addCatalogLine', catalogItemId: oil.id });
  open = await apply(open, {
    kind: 'addCustomLine',
    type: 'SERVICE',
    title: 'Cuci motor',
    unitPrice: '15000',
  });
  let discarded = await createDraft();
  discarded = await apply(discarded, {
    kind: 'addCatalogLine',
    catalogItemId: helmet.id,
  });
  discarded = await apply(discarded, { kind: 'discard' });

  // ---- prints ----
  for (const [invoiceId, format] of [
    [paid.id, 'A4'],
    [paid.id, 'THERMAL_58'],
    [partial.id, 'THERMAL_80'],
    [voided.id, 'A4'],
  ] as const) {
    ok(await call(C.printing.print, { invoiceId, format }, CASHIER), 'print');
  }
  ctx.answerSave(path.join(ctx.exportDir, 'invoice.pdf'));
  ok(await call(C.printing.exportPdf, { invoiceId: paid.id }, CASHIER), 'pdf');

  // ---- backup run ----
  ok(await call(C.backups.create, undefined, ADMIN), 'backup');

  ok(await call(C.auth.logout, undefined, CASHIER), 'logout cashier');
  ok(await call(C.auth.logout, undefined, ADMIN), 'logout admin');
  return {
    invoices: { paid, partial, voided },
    openDraftId: open.id,
    discardedDraftId: discarded.id,
  };
}
