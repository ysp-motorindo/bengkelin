import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/renderer/components/ui/select';
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
  const languageId = useId();
  const appearanceId = useId();
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
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={languageId} className="sr-only">
        {t('shell.preferences.language')}
      </label>
      <Select
        id={languageId}
        aria-label={t('shell.preferences.language')}
        className="h-8 w-auto py-0"
        disabled={busy}
        value={preferences.language}
        onChange={(event) =>
          save(event.target.value as Language, preferences.appearance)
        }
      >
        {LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(`shell.preferences.languages.${language}`)}
          </option>
        ))}
      </Select>
      <label htmlFor={appearanceId} className="sr-only">
        {t('shell.preferences.appearance')}
      </label>
      <Select
        id={appearanceId}
        aria-label={t('shell.preferences.appearance')}
        className="h-8 w-auto py-0"
        disabled={busy}
        value={preferences.appearance}
        onChange={(event) =>
          save(preferences.language, event.target.value as Appearance)
        }
      >
        {APPEARANCES.map((appearance) => (
          <option key={appearance} value={appearance}>
            {appearance === 'LIGHT'
              ? '☀ '
              : appearance === 'DARK'
                ? '☾ '
                : '◐ '}
            {t(`shell.preferences.appearances.${appearance}`)}
          </option>
        ))}
      </Select>
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
