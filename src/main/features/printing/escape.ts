/**
 * The ONE escape helper for print templates. Every dynamic value goes
 * through `escapeHtml`, normally via the `html` tagged template, which
 * escapes every interpolation unless it is already `SafeHtml` (the output
 * of another `html` call). Templates never concatenate raw strings.
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]!);
}

/** Markup that is already escaped (produced by `html`). */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Interpolation =
  | SafeHtml
  | string
  | number
  | null
  | undefined
  | false
  | readonly Interpolation[];

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value as string | number);
}

export function html(
  strings: TemplateStringsArray,
  ...values: Interpolation[]
): SafeHtml {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

/** Static, developer-written CSS or markup only (never data). */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
