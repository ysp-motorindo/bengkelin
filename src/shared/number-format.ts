import type { NumberFormat } from './contracts/common';

export function resolveNumberLocale(
  format: NumberFormat = 'ID',
  systemLocale = 'id-ID',
): string {
  if (format !== 'SYSTEM') return format === 'US' ? 'en-US' : 'id-ID';
  try {
    return Intl.NumberFormat.supportedLocalesOf([systemLocale])[0] ?? 'id-ID';
  } catch {
    return 'id-ID';
  }
}

const formats = new Map<string, ReturnType<typeof makeFormat>>();
function makeFormat(locale: string) {
  const formatter = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  const parts = formatter.formatToParts(1234567890123n);
  const widths = parts
    .filter((part) => part.type === 'integer')
    .map((part) => part.value.length);
  return {
    group: parts.find((part) => part.type === 'group')?.value ?? '',
    decimal:
      formatter.formatToParts(1.1).find((part) => part.type === 'decimal')
        ?.value ?? '.',
    minimumGroupingDigits: formatter
      .formatToParts(1000n)
      .some((part) => part.type === 'group')
      ? 4
      : 5,
    primary: widths.at(-1) ?? 3,
    secondary: widths.at(-2) ?? widths.at(-1) ?? 3,
  };
}
export function numberSymbols(locale: string) {
  let format = formats.get(locale);
  if (!format) {
    format = makeFormat(locale);
    formats.set(locale, format);
  }
  return format;
}

/** Formats an ungrouped decimal string without rounding or Number conversion. */
export function formatNumericText(value: string, locale: string): string {
  const { group, decimal, primary, secondary, minimumGroupingDigits } =
    numberSymbols(locale);
  const negative = value.startsWith('-');
  const [integer = '', fraction] = (negative ? value.slice(1) : value).split(
    '.',
  );
  if (integer.length < minimumGroupingDigits)
    return `${negative ? '-' : ''}${integer}${fraction === undefined ? '' : decimal + fraction}`;
  const groups: string[] = [];
  let end = integer.length;
  let width = primary;
  while (end > 0) {
    groups.unshift(integer.slice(Math.max(0, end - width), end));
    end -= width;
    width = secondary;
  }
  return `${negative ? '-' : ''}${groups.join(group)}${fraction === undefined ? '' : decimal + fraction}`;
}

export interface NumericTextOptions {
  decimal?: boolean;
  negative?: boolean;
}

/** Strict grouping is for pasted text; typed edits may temporarily shift existing groups. */
export function parseNumericText(
  text: string,
  locale: string,
  options: NumericTextOptions = {},
  strictGrouping = false,
): string | null {
  const { group, decimal, primary, secondary } = numberSymbols(locale);
  if (group && /^\s+$/.test(group))
    text = text.replace(/[ \u00a0\u202f]/g, group);
  const negative = text.startsWith('-');
  if (negative && !options.negative) return null;
  const unsigned = negative ? text.slice(1) : text;
  const parts = unsigned.split(decimal);
  if (parts.length > 2 || (parts.length === 2 && !options.decimal)) return null;
  const integer = parts[0] ?? '';
  const fraction = parts[1];
  if (fraction !== undefined && !/^\d*$/.test(fraction)) return null;
  if (strictGrouping && group && integer.includes(group)) {
    const groups = integer.split(group);
    if (
      groups.some(
        (part, index) =>
          !/^\d+$/.test(part) ||
          (index === 0
            ? part.length > secondary
            : part.length !==
              (index === groups.length - 1 ? primary : secondary)),
      )
    )
      return null;
  }
  const digits = group ? integer.split(group).join('') : integer;
  if (!/^\d*$/.test(digits)) return null;
  return `${negative ? '-' : ''}${digits}${fraction === undefined ? '' : '.' + fraction}`;
}
