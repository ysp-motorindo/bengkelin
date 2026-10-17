import { ChevronDown } from 'lucide-react';
import { ID, US } from 'country-flag-icons/react/3x2';
import { useTranslation } from 'react-i18next';
import { useAction } from '@/renderer/lib/use-action';
import {
  APPEARANCES,
  LANGUAGES,
  type Appearance,
  type Language,
  type PreferencesInput,
} from '@/shared/contracts';

interface PreferencesControlsProps {
  preferences: PreferencesInput;
  onChanged(preferences: PreferencesInput): void;
}

export function PreferencesControls({
  preferences,
  onChanged,
}: PreferencesControlsProps) {
  const { t } = useTranslation();
  const { busy, error, run, check } = useAction();

  function save(language: Language, appearance: Appearance) {
    void run(async () => {
      const result = await window.bengkelin.settings.updatePreferences({
        language,
        appearance,
      });
      if (check(result)) onChanged(result.value);
    });
  }

  return (
    <div className="space-y-1">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('shell.preferences.language')}
          <ChevronDown
            aria-hidden="true"
            className="size-4 transition-transform group-open:rotate-180"
          />
        </summary>
        <div
          role="radiogroup"
          aria-label={t('shell.preferences.language')}
          className="space-y-1"
        >
          {LANGUAGES.map((language) => {
            const Flag = language === 'id' ? ID : US;
            return (
              <label
                key={language}
                className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring has-[:disabled]:opacity-50"
              >
                <input
                  type="radio"
                  name="language"
                  value={language}
                  checked={preferences.language === language}
                  disabled={busy}
                  onChange={() => save(language, preferences.appearance)}
                  className="sr-only"
                />
                <Flag
                  aria-hidden="true"
                  title={language === 'id' ? 'Indonesia' : 'United States'}
                  className="h-4 w-6"
                />
                <span>{t(`shell.preferences.languages.${language}`)}</span>
              </label>
            );
          })}
        </div>
      </details>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded px-2 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('shell.preferences.appearance')}
          <ChevronDown
            aria-hidden="true"
            className="size-4 transition-transform group-open:rotate-180"
          />
        </summary>
        <div
          role="radiogroup"
          aria-label={t('shell.preferences.appearance')}
          className="space-y-1"
        >
          {APPEARANCES.map((appearance) => (
            <label
              key={appearance}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring has-[:disabled]:opacity-50"
            >
              <input
                type="radio"
                name="appearance"
                value={appearance}
                checked={preferences.appearance === appearance}
                disabled={busy}
                onChange={() => save(preferences.language, appearance)}
                className="sr-only"
              />
              <span aria-hidden="true">
                {appearance === 'LIGHT'
                  ? '☀'
                  : appearance === 'DARK'
                    ? '☾'
                    : '◐'}
              </span>
              {t(`shell.preferences.appearances.${appearance}`)}
            </label>
          ))}
        </div>
      </details>
      {error ? (
        <span role="alert" className="block px-2 py-1 text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
