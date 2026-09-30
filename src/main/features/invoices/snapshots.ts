import type { CustomerRepository } from '@/main/features/customers/repository';
import type {
  DraftRepository,
  InvoiceRow,
} from '@/main/features/drafts/repository';
import type { SettingsRepository } from '@/main/features/settings/repository';
import {
  normalizePhone,
  normalizePlate,
} from '@/main/features/vehicles/normalization';
import type { VehicleRepository } from '@/main/features/vehicles/repository';
import type { ShopIdentitySnapshot } from '@/shared/contracts';
import type { HeaderSnapshots, InvoiceRepository } from './repository';

/**
 * Frozen snapshots (spec 15, 18, 60; Part A "Persistence additions"). An
 * issued invoice is printed and shown from these values only, so renaming a
 * customer, transferring a vehicle, renaming an item or channel, changing a
 * price or the shop identity never rewrites it.
 */

export interface SnapshotDeps {
  drafts: DraftRepository;
  invoices: InvoiceRepository;
  customers: CustomerRepository;
  vehicles: VehicleRepository;
  settings: SettingsRepository;
}

export function captureHeaderSnapshots(
  deps: SnapshotDeps,
  invoice: InvoiceRow,
  finalizerCashierId: string,
): HeaderSnapshots {
  const customer =
    invoice.customer_id === null
      ? undefined
      : deps.customers.find(invoice.customer_id);
  const vehicle =
    invoice.vehicle_id === null
      ? undefined
      : deps.vehicles.find(invoice.vehicle_id);
  const shop = deps.settings.getShop();
  const identity: ShopIdentitySnapshot = {
    name: shop.name,
    address: shop.address,
    phoneNumber: shop.phoneNumber,
    email: shop.email,
    invoiceFooter: shop.invoiceFooter,
    logo: null,
  };
  const customerPhone = customer?.phoneNumber ?? null;
  const plateNumber = vehicle?.plateNumber ?? null;
  return {
    customerName: customer?.name ?? null,
    customerPhone,
    // History searches these, never the live customer/vehicle (spec 35, 60).
    customerPhoneNormalized:
      customerPhone === null ? null : normalizePhone(customerPhone),
    plateNumber,
    plateNumberNormalized:
      plateNumber === null ? null : normalizePlate(plateNumber),
    vehicleDescription: vehicle
      ? [vehicle.brandName, vehicle.modelName].filter(Boolean).join(' ') || null
      : null,
    channelLabel: deps.drafts.channel(invoice.channel_id)?.label ?? '',
    cashierName: deps.drafts.cashierName(finalizerCashierId),
    shopIdentity: JSON.stringify(identity),
  };
}

/**
 * Writes every snapshot while the invoice is still a DRAFT: the 006 guard
 * triggers freeze the invoice lines once the status leaves DRAFT, and the
 * FINALIZED immutability trigger freezes the header columns.
 */
export function writeSnapshots(
  deps: SnapshotDeps,
  invoice: InvoiceRow,
  finalizerCashierId: string,
): void {
  deps.invoices.writeHeaderSnapshots(
    invoice.id,
    captureHeaderSnapshots(deps, invoice, finalizerCashierId),
  );
  deps.invoices.fillLineSnapshots(invoice.id);
}
