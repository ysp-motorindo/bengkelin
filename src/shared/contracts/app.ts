import { z } from 'zod';

/** Help > About (readable before login: no business data). */
export interface AboutDto {
  appVersion: string;
  /** SQLite `user_version` of the open database. */
  schemaVersion: number;
}

/**
 * What the renderer currently shows that the native menu depends on.
 * `printable`: a committed invoice's print actions are on screen (the
 * finalized-success view or an invoice detail), so File > Print applies.
 */
export const menuContextInputSchema = z.strictObject({
  printable: z.boolean('validation.invalid'),
});
export type MenuContextInput = z.infer<typeof menuContextInputSchema>;
