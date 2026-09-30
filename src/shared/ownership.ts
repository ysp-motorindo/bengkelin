/**
 * True when a customer is selected and the vehicle's current owner is someone
 * else. Anonymous selection (null) and unowned vehicles never warn. This is a
 * warning only: ownership changes exclusively through the explicit
 * `vehicles.transferOwnership` action, never by selecting a pair.
 */
export function detectOwnerMismatch(
  activeOwnerId: string | null,
  selectedCustomerId: string | null,
): boolean {
  return (
    activeOwnerId !== null &&
    selectedCustomerId !== null &&
    activeOwnerId !== selectedCustomerId
  );
}
