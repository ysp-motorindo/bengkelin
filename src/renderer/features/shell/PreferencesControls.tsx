import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import {
  APPEARANCES,
  LANGUAGES,
  type Appearance,
  type Language,
  type PublicSettings,
} from '@/shared/contracts';

interface PreferencesControlsProps {
  settings: PublicSettings;
  onChanged(settings: PublicSettings): void;
}

/**
 * Shop-wide language and appearance (spec 54), ADMIN only (main enforces
 * it). Applied live once main has saved them.
 */
export function PreferencesControls({
  settings,
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
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={languageId} className="text-muted-foreground">
        {t('shell.preferences.language')}
      </label>
      <Select
        id={languageId}
        className="h-8 w-auto py-0"
        disabled={busy}
        value={settings.language}
        onChange={(event) =>
          save(event.target.value as Language, settings.appearance)
        }
      >
        {LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(`shell.preferences.languages.${language}`)}
          </option>
        ))}
      </Select>
      <label htmlFor={appearanceId} className="text-muted-foreground">
        {t('shell.preferences.appearance')}
      </label>
      <Select
        id={appearanceId}
        className="h-8 w-auto py-0"
        disabled={busy}
        value={settings.appearance}
        onChange={(event) =>
          save(settings.language, event.target.value as Appearance)
        }
      >
        {APPEARANCES.map((appearance) => (
          <option key={appearance} value={appearance}>
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
