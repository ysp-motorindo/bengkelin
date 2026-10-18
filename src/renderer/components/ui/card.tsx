import type { ComponentProps } from 'react';
import { cn } from '@/renderer/lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col gap-1.5 p-6', className)} {...props} />
  );
}

export function CardTitle({
  className,
  level = 2,
  ...props
}: ComponentProps<'h2'> & { level?: 1 | 2 | 3 }) {
  const Heading = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
  return (
    <Heading
      className={cn(
        'wrap-anywhere font-semibold leading-tight tracking-tight',
        level === 1 ? 'text-xl' : 'text-lg',
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-2 p-6 pt-0', className)}
      {...props}
    />
  );
}
