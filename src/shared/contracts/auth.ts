import { z } from 'zod';
import type { Role, UUID } from './common';

export const loginInputSchema = z.strictObject({
  username: z
    .string('validation.required')
    .trim()
    .min(1, 'validation.required')
    .max(100, 'validation.tooLong'),
  // Never trimmed and not held to the creation rules: login must not leak them.
  password: z
    .string('validation.required')
    .min(1, 'validation.required')
    .max(256, 'validation.tooLong'),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/** What the renderer knows about the signed-in cashier. */
export interface CashierSession {
  cashierId: UUID;
  username: string;
  displayName: string;
  role: Role;
}
