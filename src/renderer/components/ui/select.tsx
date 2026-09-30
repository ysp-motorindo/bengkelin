import type { ComponentProps } from 'react';
import { cn } from '@/renderer/lib/utils';
import { controlClass } from './input';

/**
 * Native <select>: fully keyboard- and screen-reader-operable with no extra
 * dependency. Styled to match Input.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(controlClass, className)} {...props} />;
}
