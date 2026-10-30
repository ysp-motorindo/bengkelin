import { FilePlus, FolderOpen, RefreshCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { controlClass } from '@/renderer/components/ui/input';
import { errorMessage } from '@/renderer/lib/errors';
import type {
  DraftLineDto,
  DraftSummary,
  DraftView,
  ReferenceDto,
} from '@/shared/contracts';
import { CheckoutReviewDialog } from './checkout/CheckoutReviewDialog';
import {
  bridgeFinalizeClient,
  type FinalizeClient,
} from './checkout/finalize-client';
import { CheckoutPanel } from './checkout/CheckoutPanel';
import { DraftHeader } from './DraftHeader';
import { DraftSwitcher } from './DraftSwitcher';
import type { QueueNotice } from './draft-command-queue';
import { LinesTable } from './LinesTable';
import { RepricingDialog } from './RepricingDialog';
import { SaveIndicator } from './SaveIndicator';
import { LineEntryRow, type LineEntryRowHandle } from './LineEntryRow';
import { useSyncedValue } from './synced-field';
import { useDraftCommands } from './use-draft-commands';
import { registerWorkspaceActions } from './workspace-actions';

export interface WorkspaceReferences {
  sales: ReferenceDto[];
  expeditions: ReferenceDto[];
  channels: ReferenceDto[];
  mechanics: ReferenceDto[];
  units: ReferenceDto[];
}

interface DraftWorkspaceProps {
  active: boolean;
  toolbarSlot?: HTMLElement | null;
  initialView: DraftView;
  timezone: string;
  references: WorkspaceReferences;
  /** Draft lifecycle, owned by the screen (flushes before switching). */
  onNewDraft(): Promise<void>;
  onOpenDraft(id: string): Promise<void>;
  onDiscardOther(summary: DraftSummary): Promise<string | null>;
  /** The draft was discarded/finalized elsewhere (or here): leave it. */
  onLeave(code: string): void;
  /** Finalization from the review step (default: the preload bridge). */
  finalizer?: FinalizeClient | undefined;
}

type Dialog = { kind: 'repricing' | 'switcher' | 'review' } | null;

/**
 * One open draft: toolbar (drafts, new, review prices, save state), header,
 * scanner + lines table, and the persistent checkout panel. Every change
 * goes through the draft's command queue (useDraftCommands).
 */
export function DraftWorkspace({
  active,
  toolbarSlot,
  initialView,
  timezone,
  references,
  onNewDraft,
  onOpenDraft,
  onDiscardOther,
  onLeave,
  finalizer = bridgeFinalizeClient,
}: DraftWorkspaceProps) {
  const { t } = useTranslation();
  const entryRef = useRef<LineEntryRowHandle>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;

  const onNotice = useCallback(
    (queueNotice: QueueNotice) => {
      if (queueNotice.kind === 'conflictReloaded') {
        setNotice(t('workspace.notices.conflictReloaded'));
      } else if (queueNotice.kind === 'closed') {
        leaveRef.current(queueNotice.code);
      } else if (queueNotice.kind === 'failed') {
        setNotice(errorMessage(t, queueNotice.error));
      }
    },
    [t],
  );
  const commands = useDraftCommands(initialView.id, {
    initialView,
    onNotice,
  });
  const { view, send, flush, reload } = commands;
  const wasActive = useRef(active);
  useEffect(() => {
    const returning = active && !wasActive.current;
    wasActive.current = active;
    if (returning) {
      void flush()
        .then((saved) => (saved ? reload() : undefined))
        .catch(() => setError(t('errors.INTERNAL_ERROR')));
    }
  }, [active, flush, reload, t]);

  const focusSearch = useCallback(() => {
    entryRef.current?.focusSearch();
  }, []);

  useEffect(() => {
    focusSearch();
  }, [focusSearch]);

  const openReview = useCallback(async () => {
    const flushed = await flush();
    if (!flushed) {
      setError(t('workspace.notices.unsaved'));
      return;
    }
    setError(null);
    setDialog({ kind: 'review' });
  }, [flush, t]);

  useEffect(
    () =>
      registerWorkspaceActions({
        newTransaction: onNewDraft,
        focusSearch,
        addCustomItem: () => entryRef.current?.startCustom(),
        saveDraft: flush,
        openCheckoutReview: openReview,
      }),
    [flush, focusSearch, onNewDraft, openReview],
  );

  const closeDialog = useCallback(() => setDialog(null), []);

  async function removeLine(line: DraftLineDto) {
    const result = await send({ kind: 'removeLine', lineId: line.id });
    if (!result.ok && result.error.code !== 'QUEUE_CLOSED') {
      setError(errorMessage(t, result.error));
    }
    if (result.ok) focusSearch();
    return result.ok;
  }

  async function discard(summary: DraftSummary): Promise<string | null> {
    if (summary.id !== view.id) return onDiscardOther(summary);
    await flush();
    const result = await send({ kind: 'discard' });
    if (result.ok) {
      setDialog(null);
      onLeave('DRAFT_DISCARDED');
      return null;
    }
    return errorMessage(t, result.error);
  }

  const differing = view.lines.filter(
    (line) => line.pricing.listedPriceDiffersFromCurrent,
  ).length;

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialog({ kind: 'switcher' })}
        >
          <FolderOpen aria-hidden="true" />
          {t('workspace.drafts.open')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void onNewDraft()}>
          <FilePlus aria-hidden="true" />
          {t('workspace.drafts.new')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialog({ kind: 'repricing' })}
        >
          <RefreshCcw aria-hidden="true" />
          {t('workspace.repricing.open')}
          {differing > 0 ? (
            <span className="rounded-full bg-warning-surface px-1.5 text-xs text-warning">
              {differing}
            </span>
          ) : null}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <SaveIndicator state={commands.saveState} onRetry={commands.retry} />
      </div>
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {notice ? (
        <p
          role="status"
          className="flex items-center justify-between gap-2 rounded-md border border-warning/50 bg-warning-surface px-3 py-2 text-sm"
        >
          {notice}
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
            {t('workspace.common.dismiss')}
          </Button>
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {toolbarSlot ? createPortal(toolbar, toolbarSlot) : toolbar}
      <DraftHeader
        commands={commands}
        channels={references.channels}
        sales={references.sales}
        expeditions={references.expeditions}
        timezone={timezone}
        onError={setError}
      />

      <section
        aria-label={t('workspace.lines.label')}
        className="min-h-48 min-w-0 flex-1 overflow-auto lg:min-h-0"
      >
        <LinesTable
          lines={view.lines}
          commands={commands}
          mechanics={references.mechanics}
          onRemove={removeLine}
          entryRow={
            <LineEntryRow
              commands={commands}
              units={references.units}
              mechanics={references.mechanics}
              entryRef={entryRef}
            />
          }
        />
      </section>
      <div className="grid shrink-0 items-start gap-3 border-t border-border bg-card pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(23rem,0.45fr)]">
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            {t('workspace.header.cashier')}: {view.lastEditedBy.displayName}
          </p>
          <TransactionNote commands={commands} />
        </div>
        <CheckoutPanel
          commands={commands}
          onReview={() => void openReview()}
          onError={setError}
        />
      </div>

      {dialog?.kind === 'repricing' ? (
        <RepricingDialog
          commands={commands}
          timezone={timezone}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'switcher' ? (
        <DraftSwitcher
          currentId={view.id}
          timezone={timezone}
          onResume={async (id) => {
            setDialog(null);
            await onOpenDraft(id);
          }}
          onDiscard={discard}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'review' ? (
        <CheckoutReviewDialog
          view={view}
          finalizer={finalizer}
          onClose={closeDialog}
          onNewTransaction={() => {
            setDialog(null);
            void onNewDraft();
          }}
        />
      ) : null}
    </div>
  );
}

function TransactionNote({
  commands,
}: {
  commands: import('./use-draft-commands').DraftCommands;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useSyncedValue(commands.view.note ?? '', () =>
    commands.isDirty('note'),
  );
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      {t('workspace.header.note')}
      <textarea
        aria-label={t('workspace.header.note')}
        rows={4}
        maxLength={1000}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          commands.edit('note', {
            kind: 'updateHeader',
            changes: { note: event.target.value },
          });
        }}
        className={`${controlClass} h-auto min-h-24 resize-y text-sm font-normal`}
      />
    </label>
  );
}
