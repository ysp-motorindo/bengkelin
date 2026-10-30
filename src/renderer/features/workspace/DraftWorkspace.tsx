import {
  Check,
  FilePlus,
  FolderOpen,
  ListPlus,
  PencilLine,
  RefreshCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { controlClass } from '@/renderer/components/ui/input';
import { errorMessage } from '@/renderer/lib/errors';
import type {
  CatalogItemDto,
  DraftLineDto,
  DraftOperation,
  DraftSummary,
  DraftView,
  ReferenceDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import { CheckoutReviewDialog } from './checkout/CheckoutReviewDialog';
import {
  bridgeFinalizeClient,
  type FinalizeClient,
} from './checkout/finalize-client';
import { CheckoutPanel } from './checkout/CheckoutPanel';
import { CustomLineDialog } from './CustomLineDialog';
import { DraftHeader } from './DraftHeader';
import { DraftSwitcher } from './DraftSwitcher';
import type { QueueNotice } from './draft-command-queue';
import { ItemEditorDialog } from './ItemEditorDialog';
import { LinesTable } from './LinesTable';
import { ManualPriceDialog } from './ManualPriceDialog';
import { RepricingDialog } from './RepricingDialog';
import { SaveIndicator } from './SaveIndicator';
import { ScannerCombobox, type ScanOutcome } from './ScannerCombobox';
import { formatWithOffset } from './shop-time';
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

type Dialog =
  | { kind: 'editor'; line: DraftLineDto }
  | {
      kind: 'manualPrice';
      source: { barcode: string } | { catalogItemId: string };
      label: string;
    }
  | { kind: 'custom' }
  | { kind: 'repricing' }
  | { kind: 'note' }
  | { kind: 'switcher' }
  | { kind: 'review' }
  | null;

/**
 * One open draft: toolbar (drafts, new, review prices, save state), header,
 * scanner + lines table, and the persistent checkout panel. Every change
 * goes through the draft's command queue (useDraftCommands).
 */
export function DraftWorkspace({
  active,
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
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
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
        setNotice(null);
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
    searchRef.current?.focus();
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
        addCustomItem: () => setDialog({ kind: 'custom' }),
        saveDraft: flush,
        openCheckoutReview: openReview,
      }),
    [flush, focusSearch, onNewDraft, openReview],
  );

  const closeDialog = useCallback(() => setDialog(null), []);

  /** Shared handling of an addCatalogLine result from scan/pick/manual price. */
  function afterAdd(
    result: Result<DraftView>,
    source: { barcode: string } | { catalogItemId: string },
    label: string,
  ): ScanOutcome {
    if (result.ok) {
      setFeedback(null);
      focusSearch();
      return 'added';
    }
    const { code } = result.error;
    if (code === 'PRICE_REQUIRED') {
      setFeedback(null);
      setDialog({ kind: 'manualPrice', source, label });
      return 'other';
    }
    if (code === 'QUEUE_CLOSED') return 'other';
    if (code === 'DRAFT_VERSION_CONFLICT') {
      setFeedback(t('workspace.search.conflict'));
      return 'other';
    }
    const message = errorMessage(t, result.error);
    setFeedback(
      'barcode' in source ? `${message} (${source.barcode})` : message,
    );
    return code === 'UNKNOWN_BARCODE' ? 'unknown' : 'other';
  }

  async function scan(code: string): Promise<ScanOutcome> {
    const result = await send({ kind: 'addCatalogLine', barcode: code });
    let label = code;
    if (!result.ok && result.error.code === 'PRICE_REQUIRED') {
      try {
        const item = await window.bengkelin.catalog.lookupBarcode({ code });
        if (item.ok) label = item.value.title;
      } catch {
        // The code itself is a fine label.
      }
    }
    return afterAdd(result, { barcode: code }, label);
  }

  async function pick(item: CatalogItemDto): Promise<void> {
    const result = await send({
      kind: 'addCatalogLine',
      catalogItemId: item.id,
    });
    afterAdd(result, { catalogItemId: item.id }, item.title);
  }

  async function addWithManualPrice(
    source: { barcode: string } | { catalogItemId: string },
    unitPrice: string,
    reason: string,
  ): Promise<string | null> {
    const op: DraftOperation = {
      kind: 'addCatalogLine',
      ...source,
      unitPrice,
      ...(reason ? { reason } : {}),
    };
    const result = await send(op);
    if (result.ok) {
      setDialog(null);
      setFeedback(null);
      return null;
    }
    return errorMessage(t, result.error);
  }

  async function removeLine(line: DraftLineDto) {
    const result = await send({ kind: 'removeLine', lineId: line.id });
    if (!result.ok && result.error.code !== 'QUEUE_CLOSED') {
      setError(errorMessage(t, result.error));
    }
    focusSearch();
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold leading-tight tracking-tight">
            {t('workspace.title')}
          </h1>
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
            disabled={view.lines.every((line) => line.source !== 'CATALOG')}
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog({ kind: 'note' })}
          >
            <PencilLine aria-hidden="true" />
            {view.note?.trim()
              ? t('workspace.header.updateNote')
              : t('workspace.header.addNote')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {t('workspace.drafts.by', {
              creator: view.createdBy.displayName,
              editor: view.lastEditedBy.displayName,
            })}
          </span>
          <SaveIndicator state={commands.saveState} onRetry={commands.retry} />
        </div>
      </div>

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

      <DraftHeader
        commands={commands}
        channels={references.channels}
        sales={references.sales}
        expeditions={references.expeditions}
        timezone={timezone}
        onError={setError}
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          aria-label={t('workspace.lines.label')}
          className="flex min-w-0 flex-col gap-3"
        >
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <ScannerCombobox
                inputRef={searchRef}
                onScan={scan}
                onPick={pick}
                feedback={feedback}
                onClearFeedback={() => setFeedback(null)}
              />
            </div>
            <Button
              variant="outline"
              className="mt-6 h-12"
              onClick={() => setDialog({ kind: 'custom' })}
            >
              <ListPlus aria-hidden="true" />
              {t('workspace.custom.open')}
            </Button>
          </div>
          <LinesTable
            lines={view.lines}
            onEdit={(line) => setDialog({ kind: 'editor', line })}
            onRemove={(line) => void removeLine(line)}
          />
        </section>
        <CheckoutPanel
          commands={commands}
          onReview={() => void openReview()}
          onError={setError}
        />
      </div>

      {dialog?.kind === 'editor' ? (
        <ItemEditorDialog
          line={dialog.line}
          mechanics={references.mechanics}
          send={send}
          onClose={closeDialog}
          returnFocus={focusSearch}
        />
      ) : null}
      {dialog?.kind === 'manualPrice' ? (
        <ManualPriceDialog
          itemLabel={dialog.label}
          onSubmit={(price, reason) =>
            addWithManualPrice(dialog.source, price, reason)
          }
          onClose={closeDialog}
          returnFocus={focusSearch}
        />
      ) : null}
      {dialog?.kind === 'custom' ? (
        <CustomLineDialog
          existingLineIds={view.lines.map((line) => line.id)}
          units={references.units}
          mechanics={references.mechanics}
          send={send}
          onClose={closeDialog}
          returnFocus={focusSearch}
        />
      ) : null}
      {dialog?.kind === 'repricing' ? (
        <RepricingDialog
          commands={commands}
          timezoneLabel={formatWithOffset(view.pricingAt, timezone)}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === 'note' ? (
        <DraftNoteDialog
          value={view.note ?? ''}
          onSave={(note) => {
            commands.edit('note', {
              kind: 'updateHeader',
              changes: { note },
            });
            setDialog(null);
          }}
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

function DraftNoteDialog({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave(note: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(value);

  return (
    <Dialog
      title={t('workspace.header.note')}
      onClose={onClose}
      closeLabel={t('workspace.common.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose}>
              <X aria-hidden="true" />
              {t('workspace.common.cancel')}
            </Button>
          }
        >
          <Button type="submit" form="draft-note-form">
            <Check aria-hidden="true" />
            {t('workspace.header.saveNote')}
          </Button>
        </DialogActions>
      }
    >
      <form
        id="draft-note-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(note);
        }}
      >
        <label htmlFor="draft-note" className="sr-only">
          {t('workspace.header.note')}
        </label>
        <textarea
          id="draft-note"
          rows={5}
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className={`${controlClass} h-auto min-h-32 resize-y`}
        />
      </form>
    </Dialog>
  );
}
