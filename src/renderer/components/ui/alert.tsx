import type { ComponentProps } from 'react';
import { cn } from '@/renderer/lib/utils';

/** Inline error/notice. Announced to assistive tech via role="alert". */
export function Alert({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive',
        className,
      )}
      {...props}
    />
  );
}
