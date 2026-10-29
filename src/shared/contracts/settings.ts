import { z } from 'zod';
import {
  appearanceSchema,
  languageSchema,
  numberFormatSchema,
  optionalText,
  passwordSchema,
  requiredText,
  timezoneSchema,
  usernameSchema,
  type Appearance,
  type Language,
} from './common';

/** Shop identity, spec 32. `logo` arrives with the printing task. */
export const shopSettingsInputSchema = z.strictObject({
  name: requiredText(120),
  address: requiredText(300),
  phoneNumber: optionalText(40),
  complaintPhoneNumber: optionalText(40),
  socialMediaUrl: optionalText(500).refine((value) => {
    if (value === null) return true;
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hostname !== ''
      );
    } catch {
      return false;
    }
  }, 'validation.invalidUrl'),
  email: z
    .string('validation.invalid')
    .trim()
    .max(200, 'validation.tooLong')
    .refine(
      (v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      'validation.invalidEmail',
    )
    .nullish()
    .transform((value) => (value ? value : null)),
  invoiceFooter: optionalText(500),
  timezone: timezoneSchema,
});
export type ShopSettingsInput = z.input<typeof shopSettingsInputSchema>;

export const preferencesInputSchema = z.strictObject({
  language: languageSchema,
  appearance: appearanceSchema,
  numberFormat: numberFormatSchema.default('ID'),
});
export type PreferencesInput = z.infer<typeof preferencesInputSchema>;

/** Optional printer step of the wizard (spec 31). Omitted when skipped. */
export const printerSetupSchema = z.strictObject({
  thermalPrinterName: optionalText(200),
  a4PrinterName: optionalText(200),
  thermalPaperWidthMm: z.union(
    [z.literal(58), z.literal(80)],
    'validation.invalid',
  ),
});

export const setupInputSchema = z.strictObject({
  shop: shopSettingsInputSchema,
  admin: z.strictObject({
    username: usernameSchema,
    displayName: requiredText(100),
    password: passwordSchema,
  }),
  preferences: preferencesInputSchema,
  printer: printerSetupSchema.optional(),
});
export type SetupInput = z.input<typeof setupInputSchema>;

/** Readable before login: just enough to render the login screen. */
export interface PublicSettings {
  setupCompleted: boolean;
  language: Language;
  appearance: Appearance;
  shopName: string;
  systemNumberLocale: string;
}

/**
 * Shop identity for signed-in screens (spec 32). The workspace needs the
 * timezone for "today" and local pricing times.
 */
export interface ShopSettingsDto {
  name: string;
  address: string;
  phoneNumber: string | null;
  complaintPhoneNumber: string | null;
  socialMediaUrl: string | null;
  email: string | null;
  invoiceFooter: string | null;
  timezone: string;
}

/** Parsed (post-transform) shapes handed to main-process services. */
export type ShopSettingsData = z.output<typeof shopSettingsInputSchema>;
export type SetupData = z.output<typeof setupInputSchema>;
