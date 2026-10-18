import { useId, type ReactElement, cloneElement } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
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
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {message ? (
          <span className="group relative inline-flex shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message}
              className={
                error
                  ? 'size-5 p-0 text-destructive hover:bg-transparent hover:text-destructive'
                  : 'size-5 p-0 text-muted-foreground hover:bg-transparent'
              }
            >
              {error ? (
                <TriangleAlert aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
            </Button>
            <span
              id={messageId}
              role="tooltip"
              className={`pointer-events-none absolute right-0 top-full z-50 mt-1 w-max max-w-64 rounded-md border bg-card px-2 py-1 text-xs text-popover-foreground shadow-md invisible opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 ${error ? 'border-destructive' : 'border-border'}`}
            >
              {message}
            </span>
          </span>
        ) : null}
      </div>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': message ? messageId : undefined,
      })}
    </div>
  );
}
