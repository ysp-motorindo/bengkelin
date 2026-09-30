import type { TFunction } from 'i18next';

export interface ResultError {
  code: string;
  messageKey: string;
  fieldErrors?: Record<string, string> | undefined;
  params?: Record<string, string> | undefined;
}

/**
 * Translates a Result error by its `messageKey`. Unknown keys fall back to the
 * generic internal-error message rather than showing a raw key or code.
 */
export function errorMessage(t: TFunction, error: ResultError): string {
  return t(error.messageKey, {
    ...error.params,
    defaultValue: t('errors.INTERNAL_ERROR'),
  });
}
