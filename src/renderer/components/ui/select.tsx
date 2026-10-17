import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/renderer/lib/utils';
import { controlClass } from './input';

/**
 * Native <select>: fully keyboard- and screen-reader-operable with no extra
 * dependency. Styled to match Input.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex">
      <select
        className={cn(controlClass, 'appearance-none pr-9', className)}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
