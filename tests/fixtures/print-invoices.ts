import { CHANNELS } from '@/shared/channels';
import type {
  CatalogItemDto,
  DraftOperation,
  DraftView,
  FinalizePreviewDto,
  InvoiceView,
  PricePreviewDto,
  ReferenceDto,
  SaveCustomerResult,
  SaveVehicleResult,
} from '@/shared/contracts';
import type { Instant, Result } from '@/shared/primitives';

/**
 * Representative printing fixtures (spec 58, 61), issued through the app's
 * own command table so they carry real snapshots, totals and payments.
 * Shared by the printing integration test and `npm run print:samples`.
 */

export type Call = <T = unknown>(
  channel: string,
  input?: unknown,
  windowId?: number,
) => Promise<Result<T>>;

export const ADMIN_WINDOW = 1;
export const CASHIER_WINDOW = 2;
export const FIXTURE_ADMIN_PASSWORD = 'correct-horse-battery';
export const FIXTURE_CASHIER_PASSWORD = 'siti-password-1';

const C = CHANNELS;

export function must<T>(result: Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${JSON.stringify(result.error)}`);
  return result.value;
}

let sequence = 0;
/** Deterministic, valid v4-shaped ids for request ids. */
export function fixtureId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

export interface PrintShop {
  stockLocationId: string;
  call: Call;
  now(): Instant;
  bengkel: string;
  pcs: string;
  serviceUnit: string;
  mechanicId: string;
  customerId: string;
  vehicleId: string;
}

/** Completes setup (with full shop identity), signs in ADMIN and CASHIER. */
export async function seedPrintShop(
  call: Call,
  now: () => Instant,
  language: 'id' | 'en' = 'id',
): Promise<PrintShop> {
  must(
    await call(C.settings.completeSetup, {
      shop: {
        name: 'Bengkel Maju Jaya Motor',
        address:
          'Jl. Merdeka No. 1, Kel. Braga, Kec. Sumur Bandung, Bandung 40111',
        phoneNumber: '022-4201234',
        email: 'halo@majujaya.example',
        invoiceFooter:
          'Terima kasih atas kepercayaan Anda. Garansi servis 7 hari dengan membawa faktur ini.',
        timezone: 'Asia/Jakarta',
      },
      admin: {
        username: 'admin',
        displayName: 'Pak Budi',
        password: FIXTURE_ADMIN_PASSWORD,
      },
      preferences: { language, appearance: 'SYSTEM' },
    }),
    'setup',
  );
  must(
    await call(
      C.auth.login,
      { username: 'admin', password: FIXTURE_ADMIN_PASSWORD },
      ADMIN_WINDOW,
    ),
    'admin login',
  );
  must(
    await call(
      C.cashiers.create,
      {
        username: 'siti',
        displayName: 'Siti Rahmawati',
        password: FIXTURE_CASHIER_PASSWORD,
        role: 'CASHIER',
      },
      ADMIN_WINDOW,
    ),
    'cashier',
  );
  must(
    await call(
      C.auth.login,
      { username: 'siti', password: FIXTURE_CASHIER_PASSWORD },
      CASHIER_WINDOW,
    ),
    'cashier login',
  );
  const locations = must(
    await call<ReferenceDto[]>(
      C.references.list,
      { entity: 'stockLocation' },
      ADMIN_WINDOW,
    ),
    'locations',
  );
  const stockLocation =
    locations[0] ??
    must(
      await call<ReferenceDto>(
        C.references.save,
        {
          entity: 'stockLocation',
          code: '01',
          label: 'Gudang',
          isDefault: true,
        },
        ADMIN_WINDOW,
      ),
      'location',
    );
  const channels = must(
    await call<ReferenceDto[]>(
      C.references.list,
      { entity: 'channel' },
      ADMIN_WINDOW,
    ),
    'channels',
  );
  const units = must(
    await call<ReferenceDto[]>(
      C.references.list,
      { entity: 'unit' },
      ADMIN_WINDOW,
    ),
    'units',
  );
  const mechanic = must(
    await call<ReferenceDto>(
      C.references.save,
      { entity: 'mechanic', name: 'Joko Susilo' },
      ADMIN_WINDOW,
    ),
    'mechanic',
  );
  const brand = must(
    await call<ReferenceDto>(
      C.references.save,
      { entity: 'vehicleBrand', name: 'Honda' },
      ADMIN_WINDOW,
    ),
    'brand',
  );
  const model = must(
    await call<ReferenceDto>(
      C.references.save,
      { entity: 'vehicleModel', brandId: brand.id, name: 'Vario 160 ABS' },
      ADMIN_WINDOW,
    ),
    'model',
  );
  const saved = must(
    await call<SaveCustomerResult>(
      C.customers.save,
      { name: 'Andi Wijaya Kusumanegara', phoneNumber: '0812-3456-7890' },
      CASHIER_WINDOW,
    ),
    'customer',
  );
  if (!saved.saved) throw new Error('customer not saved');
  const motor = must(
    await call<SaveVehicleResult>(
      C.vehicles.save,
      {
        plateNumber: 'D 1234 ABC',
        brandId: brand.id,
        vehicleModelId: model.id,
        ownerCustomerId: saved.customer.id,
      },
      CASHIER_WINDOW,
    ),
    'vehicle',
  );
  return {
    stockLocationId: stockLocation.id,
    call,
    now,
    bengkel: channels.find((c) => c.code === 'BENGKEL')!.id,
    pcs: units.find((u) => u.code === 'PCS')!.id,
    serviceUnit: units.find((u) => u.code === 'SERVICE')!.id,
    mechanicId: mechanic.id,
    customerId: saved.customer.id,
    vehicleId: motor.vehicle.id,
  };
}

/** A priced, stocked catalog item (price on the BENGKEL channel). */
export async function stockItem(
  shop: PrintShop,
  title: string,
  price: string,
  startAt: Instant,
): Promise<CatalogItemDto> {
  const { call } = shop;
  const item = must(
    await call<CatalogItemDto>(
      C.catalog.save,
      { type: 'STOCK_ITEM', title, unitId: shop.pcs },
      ADMIN_WINDOW,
    ),
    'item',
  );
  const preview = must(
    await call<PricePreviewDto>(
      C.catalog.previewPriceChange,
      {
        catalogItemId: item.id,
        channelId: shop.bengkel,
        effectiveStartAt: startAt,
        price,
      },
      ADMIN_WINDOW,
    ),
    'price preview',
  );
  must(
    await call(
      C.catalog.applyPriceChange,
      { token: preview.token },
      ADMIN_WINDOW,
    ),
    'price',
  );
  must(
    await call(
      C.inventory.openBalance,
      {
        stockLocationId: shop.stockLocationId,
        requestId: fixtureId(),
        catalogItemId: item.id,
        quantity: 500,
      },
      ADMIN_WINDOW,
    ),
    'opening',
  );
  return item;
}

export interface LineSpec {
  catalogItemId?: string;
  custom?: { type: 'SERVICE' | 'NON_STOCK_ITEM'; title: string; price: string };
  quantity?: number;
  discounts?: number[];
  mechanic?: boolean;
}

export interface InvoiceSpec {
  lines: LineSpec[];
  customer?: boolean;
  references?: boolean;
  odometerKm?: number;
  topDays?: number;
  invoiceDiscounts?: number[];
  note?: string;
  /** Checkout payments. */
  checkout?: { method: string; amount: string; reference?: string }[];
}

/** Builds a draft to the spec and finalizes it (as the CASHIER). */
export async function issueInvoice(
  shop: PrintShop,
  spec: InvoiceSpec,
): Promise<InvoiceView> {
  const { call } = shop;
  const w = CASHIER_WINDOW;
  const now = shop.now();
  let draft = must(
    await call<DraftView>(
      C.drafts.create,
      {
        requestId: fixtureId(),
        channelId: shop.bengkel,
        invoiceDate: businessDate(now),
        pricingAt: now,
      },
      w,
    ),
    'draft',
  );
  const apply = async (op: DraftOperation) => {
    draft = must(
      await call<DraftView>(
        C.drafts.apply,
        {
          requestId: fixtureId(),
          invoiceId: draft.id,
          expectedVersion: draft.version,
          op,
        },
        w,
      ),
      `apply ${op.kind}`,
    );
  };
  if (spec.references) {
    for (const entity of ['sales', 'expedition'] as const) {
      const master = must(
        await call<ReferenceDto>(
          C.references.save,
          {
            entity,
            code: `REF${fixtureId().slice(-8)}`,
            label:
              entity === 'sales'
                ? 'Sales <Andi> & Rekan — Cabang Utama Bandung Selatan'
                : 'Ekspedisi Aman & Cepat — Pengiriman Wilayah Bandung Selatan dan Sekitarnya',
          },
          ADMIN_WINDOW,
        ),
        'reference',
      );
      await apply({
        kind: 'updateHeader',
        changes: { [`${entity}Id`]: master.id },
      });
    }
  }
  for (const line of spec.lines) {
    if (line.custom) {
      await apply({
        kind: 'addCustomLine',
        type: line.custom.type,
        title: line.custom.title,
        unitPrice: line.custom.price,
        unitId: line.custom.type === 'SERVICE' ? shop.serviceUnit : shop.pcs,
        ...(line.quantity ? { quantity: line.quantity } : {}),
      } as DraftOperation);
    } else {
      await apply({
        kind: 'addCatalogLine',
        catalogItemId: line.catalogItemId!,
        ...(line.quantity ? { quantity: line.quantity } : {}),
      } as DraftOperation);
    }
    const added = draft.lines[draft.lines.length - 1]!;
    if (line.mechanic) {
      await apply({
        kind: 'updateLine',
        lineId: added.id,
        mechanicId: shop.mechanicId,
      } as DraftOperation);
    }
    if (line.discounts?.length) {
      await apply({
        kind: 'setLineDiscounts',
        lineId: added.id,
        stages: line.discounts,
      });
    }
  }
  const changes: Record<string, unknown> = {};
  if (spec.customer) {
    changes.customerId = shop.customerId;
    changes.vehicleId = shop.vehicleId;
  }
  if (spec.odometerKm !== undefined) changes.odometerKm = spec.odometerKm;
  changes.topDays = spec.topDays ?? 30;
  if (spec.note !== undefined) changes.note = spec.note;
  if (Object.keys(changes).length > 0) {
    await apply({ kind: 'updateHeader', changes } as DraftOperation);
  }
  if (spec.invoiceDiscounts?.length) {
    await apply({ kind: 'setInvoiceDiscounts', stages: spec.invoiceDiscounts });
  }
  if (spec.checkout?.length) {
    await apply({
      kind: 'setCashPayment',
      amount: spec.checkout
        .reduce((sum, payment) => sum + BigInt(payment.amount), 0n)
        .toString(),
    } as DraftOperation);
  }
  const preview = must(
    await call<FinalizePreviewDto>(
      C.invoices.previewFinalize,
      { invoiceId: draft.id },
      w,
    ),
    'preview',
  );
  if (preview.errors.length > 0) {
    throw new Error(`finalize errors: ${JSON.stringify(preview.errors)}`);
  }
  return must(
    await call<InvoiceView>(
      C.invoices.finalize,
      {
        requestId: fixtureId(),
        invoiceId: draft.id,
        expectedVersion: preview.draftVersion,
        acknowledgedWarnings: preview.warnings,
      },
      w,
    ),
    'finalize',
  );
}

/** Asia/Jakarta business day of an instant (fixtures use WIB). */
function businessDate(instant: Instant): string {
  const wib = new Date(Date.parse(instant) + 7 * 3_600_000);
  return wib.toISOString().slice(0, 10);
}

/** Spec 58: Rp100.000 with 30%, 50% and 10% -> Rp31.500. */
export async function criticalInvoice(shop: PrintShop, startAt: Instant) {
  const item = await stockItem(
    shop,
    'Ban Luar IRC 80/90-14',
    '100000',
    startAt,
  );
  return issueInvoice(shop, {
    lines: [{ catalogItemId: item.id, discounts: [3000, 5000, 1000] }],
  });
}

export const LONG_TITLE =
  'Kampas rem cakram depan original Honda Vario 125/150 PCX CBS tipe K59 lengkap dengan pegas anti-bunyi dan baut pengunci';

/**
 * Spec 61: long names, services with mechanics, sequential discounts,
 * partial payments (checkout + later), TOP, 40+ lines, customer and vehicle.
 * Returns the finalized view; the caller records the later payment.
 */
export async function acceptanceInvoice(
  shop: PrintShop,
  startAt: Instant,
  lineCount = 42,
) {
  const long = await stockItem(shop, LONG_TITLE, '185000', startAt);
  const oil = await stockItem(
    shop,
    'Oli Mesin MPX2 10W-30 0,8 L',
    '58000',
    startAt,
  );
  const lines: LineSpec[] = [
    { catalogItemId: long.id, quantity: 2, discounts: [1000, 550] },
    {
      custom: {
        type: 'SERVICE',
        title: 'Servis berkala CVT + pembersihan throttle body',
        price: '95000',
      },
      mechanic: true,
      discounts: [2000],
    },
    { catalogItemId: oil.id, quantity: 1 },
  ];
  for (let i = lines.length; i < lineCount; i += 1) {
    lines.push({
      custom: {
        type: 'NON_STOCK_ITEM',
        title: `Baut & mur set M${6 + (i % 5)} stainless (#${i + 1})`,
        price: String(5000 + i * 250),
      },
      quantity: 1 + (i % 3),
      ...(i % 7 === 0 ? { discounts: [500] } : {}),
    });
  }
  return issueInvoice(shop, {
    lines,
    customer: true,
    references: true,
    odometerKm: 23456,
    topDays: 14,
    invoiceDiscounts: [750],
    note: 'Pelanggan minta bagian lama dikembalikan.',
    checkout: [{ method: 'CASH', amount: '250000' }],
  });
}
