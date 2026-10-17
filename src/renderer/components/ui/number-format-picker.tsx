import { useTranslation } from 'react-i18next';
import { NUMBER_FORMATS, type NumberFormat } from '@/shared/contracts';
import { formatNumericText, resolveNumberLocale } from '@/shared/number-format';
import { useNumberFormat } from '@/renderer/lib/number-format';
import { FormField } from '../form-field';
import { Select } from './select';

export function NumberFormatPicker({
  value,
  onChange,
  disabled = false,
  systemLocale,
}: {
  value: NumberFormat;
  onChange(value: NumberFormat): void;
  disabled?: boolean;
  systemLocale?: string;
}) {
  const { t } = useTranslation();
  const context = useNumberFormat();
  return (
    <FormField label={t('shell.preferences.numberFormat')}>
      <Select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as NumberFormat)}
      >
        {NUMBER_FORMATS.map((format) => (
          <option key={format} value={format}>
            {t(`shell.preferences.numberFormats.${format}`)} —{' '}
            {formatNumericText(
              '1234567.89',
              resolveNumberLocale(format, systemLocale ?? context.locale),
            )}
          </option>
        ))}
      </Select>
    </FormField>
  );
}
