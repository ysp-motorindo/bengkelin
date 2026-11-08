import type { ReactElement } from 'react';
import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';

export interface NavigationItem {
  id: string;
  label: string;
  current?: 'page' | 'true';
  onSelect(): void;
}

export function NavigationRow({
  label,
  level,
  items,
}: {
  label: string;
  level: 'primary' | 'secondary';
  items: readonly NavigationItem[];
}): ReactElement {
  return (
    <nav
      aria-label={label}
      className="flex flex-nowrap gap-1 overflow-x-auto border-b border-border bg-card px-4 sm:px-6"
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          aria-current={item.current}
          onClick={item.onSelect}
          className={cn(
            'shrink-0 rounded-none px-3 py-2 text-sm font-medium',
            item.current
              ? level === 'primary'
                ? 'bg-accent text-accent-foreground'
                : 'border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </Button>
      ))}
    </nav>
  );
}
