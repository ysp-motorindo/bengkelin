import { z } from 'zod';

/**
 * Contract conventions (every feature copies these):
 * - Input schemas are `z.strictObject` so unknown keys are rejected.
 * - Error messages are i18n keys under `validation.*`; the renderer translates.
 * - DTOs are JSON/structured-clone safe: money is a Rupiah string, flags are
 *   booleans, no bigint, no Date.
 */
export type UUID = string;

export const ROLES = ['ADMIN', 'CASHIER'] as const;
export const roleSchema = z.enum(ROLES, 'validation.invalid');
export type Role = z.infer<typeof roleSchema>;

export const LANGUAGES = ['id', 'en'] as const;
export const languageSchema = z.enum(LANGUAGES, 'validation.invalid');
export type Language = z.infer<typeof languageSchema>;

export const NUMBER_FORMATS = ['ID', 'US', 'SYSTEM'] as const;
export const numberFormatSchema = z.enum(NUMBER_FORMATS, 'validation.invalid');
export type NumberFormat = z.infer<typeof numberFormatSchema>;

export const APPEARANCES = ['LIGHT', 'DARK', 'SYSTEM'] as const;
export const appearanceSchema = z.enum(APPEARANCES, 'validation.invalid');
export type Appearance = z.infer<typeof appearanceSchema>;

export const uuidSchema = z.uuid('validation.invalid');

/** Trimmed, required text with a maximum length. */
export const requiredText = (max: number) =>
  z
    .string('validation.required')
    .trim()
    .min(1, 'validation.required')
    .max(max, 'validation.tooLong');

/** Trimmed optional text; blank input becomes `null` ("not set"). */
export const optionalText = (max: number) =>
  z
    .string('validation.invalid')
    .trim()
    .max(max, 'validation.tooLong')
    .nullish()
    .transform((value) => (value ? value : null));

export const MIN_PASSWORD_LENGTH = 8;
export const passwordSchema = z
  .string('validation.required')
  .min(MIN_PASSWORD_LENGTH, 'validation.passwordTooShort')
  .max(256, 'validation.tooLong');

export const usernameSchema = z
  .string('validation.required')
  .trim()
  .min(3, 'validation.usernameTooShort')
  .max(50, 'validation.tooLong')
  .regex(/^[A-Za-z0-9._-]+$/, 'validation.usernameFormat');

export const timezoneSchema = z
  .string('validation.required')
  .trim()
  .refine((zone) => {
    if (zone.length === 0) return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'validation.invalidTimezone');

/** Input for commands that take no arguments. */
export const noInput = z.undefined('validation.invalid');

/** Optional phone as typed by the cashier; must contain at least one digit. */
export const optionalPhone = z
  .string('validation.invalid')
  .trim()
  .max(40, 'validation.tooLong')
  .refine((v) => v === '' || /\d/.test(v), 'validation.invalidPhone')
  .nullish()
  .transform((value) => (value ? value : null));

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isLocalDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(v);
}

/** Required calendar date `YYYY-MM-DD` (a LocalDate). */
export const localDateSchema = z
  .string('validation.required')
  .refine(isLocalDate, 'validation.invalidDate');

/** Optional calendar date `YYYY-MM-DD`; blank becomes `null`. */
export const optionalLocalDate = z
  .string('validation.invalid')
  .trim()
  .refine((v) => v === '' || isLocalDate(v), 'validation.invalidDate')
  .nullish()
  .transform((value) => (value ? value : null));
