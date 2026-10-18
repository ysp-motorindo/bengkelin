import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/renderer/lib/utils';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium',
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-card hover:bg-muted',
        ghost: 'hover:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        'destructive-outline':
          'border border-destructive bg-card text-destructive hover:bg-destructive/10',
        'input-action': 'bg-transparent hover:bg-transparent',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        icon: 'size-10 p-0',
        'icon-sm': 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export function IconButton({
  label,
  destructive = false,
  size = 'sm',
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'aria-label'> & {
  label: string;
  destructive?: boolean;
  size?: 'default' | 'sm';
}) {
  return (
    <Button
      variant="ghost"
      size={size === 'sm' ? 'icon-sm' : 'icon'}
      aria-label={label}
      title={label}
      className={cn(
        destructive
          ? 'text-destructive hover:text-destructive'
          : 'text-muted-foreground hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
