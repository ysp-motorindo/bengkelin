import type { TFunction } from 'i18next';
import type { CustomerDto, OwnerSummaryDto } from '@/shared/contracts';

type Nameable = Pick<CustomerDto | OwnerSummaryDto, 'name' | 'phoneNumber'>;

/** "Budi - 0812..." with translated placeholders for a missing name/phone. */
export function customerLabel(t: TFunction, customer: Nameable): string {
  const name = customer.name ?? t('customers.noName');
  return customer.phoneNumber ? `${name} - ${customer.phoneNumber}` : name;
}

export function customerName(t: TFunction, customer: Nameable): string {
  return customer.name ?? customer.phoneNumber ?? t('customers.noName');
}
