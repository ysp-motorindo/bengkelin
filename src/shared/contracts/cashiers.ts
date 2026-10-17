import { z } from 'zod';
import type { Instant } from '../primitives';
import {
  appearanceSchema,
  languageSchema,
  passwordSchema,
  requiredText,
  roleSchema,
  usernameSchema,
  uuidSchema,
  type Role,
  type UUID,
} from './common';

export const createCashierInputSchema = z.strictObject({
  username: usernameSchema,
  displayName: requiredText(100),
  password: passwordSchema,
  role: roleSchema,
  language: languageSchema.optional(),
  appearance: appearanceSchema.optional(),
});
export type CreateCashierInput = z.infer<typeof createCashierInputSchema>;

export const cashierIdInputSchema = z.strictObject({ cashierId: uuidSchema });
export type CashierIdInput = z.infer<typeof cashierIdInputSchema>;

export const updateDisplayNameInputSchema = z.strictObject({
  cashierId: uuidSchema,
  displayName: requiredText(100),
});
export type UpdateDisplayNameInput = z.infer<
  typeof updateDisplayNameInputSchema
>;

export const changeRoleInputSchema = z.strictObject({
  cashierId: uuidSchema,
  role: roleSchema,
});
export type ChangeRoleInput = z.infer<typeof changeRoleInputSchema>;

export const resetPasswordInputSchema = z.strictObject({
  cashierId: uuidSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

/**
 * Names only, for filters (history, daily report) in any session: no
 * username, role or timestamps.
 */
export interface CashierNameDto {
  id: UUID;
  displayName: string;
  isActive: boolean;
}

/** Never includes the password hash. */
export interface CashierDto {
  id: UUID;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}
