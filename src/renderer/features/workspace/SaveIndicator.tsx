import { CloudAlert, CloudCheck, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';
import type { SaveState } from './draft-command-queue';

interface SaveIndicatorProps {
  state: SaveState;
  onRetry(): void;
}

/**
 * Saving / Saved / Failed. "Saved" is only shown when every command has been
 * acknowledged by main and no debounced input is waiting.
 */
export function SaveIndicator({ state, onRetry }: SaveIndicatorProps) {
  const { t } = useTranslation();
  const Icon =
    state === 'saving'
      ? LoaderCircle
      : state === 'failed'
        ? CloudAlert
        : CloudCheck;
  return (
    <div className="flex items-center gap-2">
      <Icon
        aria-hidden="true"
        className={cn(
          'size-4',
          state === 'saving' && 'animate-spin text-muted-foreground',
          state === 'saved' && 'text-success',
          state === 'failed' && 'text-destructive',
        )}
      />
      <p
        role="status"
        data-testid="save-state"
        data-state={state}
        className={cn(
          'text-sm',
          state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {t(`workspace.save.${state}`)}
      </p>
      {state === 'failed' ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('workspace.save.retry')}
        </Button>
      ) : null}
    </div>
  );
}
