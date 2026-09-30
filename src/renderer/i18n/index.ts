import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Language } from '@/shared/contracts';

export const DEFAULT_LANGUAGE: Language = 'id';

// Every file in locales/<lang>/ becomes a top-level key of that language:
// locales/id/errors.json -> t('errors.<KEY>'). Server `messageKey`s such as
// `errors.INVALID_CREDENTIALS` and `validation.required` resolve directly.
const files = import.meta.glob('../locales/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>;

function buildResources() {
  const resources: Record<string, { translation: Record<string, unknown> }> =
    {};
  for (const [file, content] of Object.entries(files)) {
    const match = /locales\/([a-z]+)\/([A-Za-z0-9-]+)\.json$/.exec(file);
    if (!match) continue;
    const [, language, namespace] = match as unknown as [
      string,
      string,
      string,
    ];
    resources[language] ??= { translation: {} };
    resources[language].translation[namespace] = content;
  }
  return resources;
}

export const resources = buildResources();

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

/** Switches language and keeps <html lang> in step (screen readers, hyphenation). */
export function setLanguage(language: Language): void {
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

export { i18n };
