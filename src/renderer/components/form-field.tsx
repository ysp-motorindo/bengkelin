import { useId, type ReactElement, cloneElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/renderer/components/ui/label';

interface FormFieldProps {
  label: string;
  /** i18n key of the error (a `validation.*` key), if any. */
  error?: string | undefined;
  hint?: string | undefined;
  /** A single control (Input/Select); it receives id and aria wiring. */
  children: ReactElement<{
    id?: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
  }>;
}

/** Label + control + translated error, wired for screen readers. */
export function FormField({ label, error, hint, children }: FormFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const messageId = `${id}-message`;
  const message = error
    ? t(error, { defaultValue: t('validation.invalid') })
    : hint;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': message ? messageId : undefined,
      })}
      {message ? (
        <p
          id={messageId}
          className={
            error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
          }
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
