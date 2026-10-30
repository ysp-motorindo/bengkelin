import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { errorMessage } from '@/renderer/lib/errors';
import { flushAll } from '@/renderer/lib/flush-registry';
import { watchSessionError } from '@/renderer/lib/session-events';
import type {
  DraftSummary,
  DraftView,
  ReferenceDto,
  ShopSettingsDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';
import type { FinalizeClient } from './checkout/finalize-client';
import { DraftWorkspace, type WorkspaceReferences } from './DraftWorkspace';
import { nowInstant, todayInShop } from './shop-time';

interface CashierWorkspaceProps {
  active?: boolean;
  /** Finalization from the review step (default: the preload bridge). */
  finalizer?: FinalizeClient | undefined;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | {
      kind: 'ready';
      shop: ShopSettingsDto;
      references: WorkspaceReferences;
      draft: DraftView;
    };

class LoadError extends Error {
  constructor(readonly result: Extract<Result<unknown>, { ok: false }>) {
    super(result.error.code);
  }
}

function must<T>(result: Result<T>): T {
  if (!result.ok) {
    watchSessionError(result.error);
    throw new LoadError(result);
  }
  return result.value;
}

async function ensureInvoiceNumber(draft: DraftView): Promise<DraftView> {
  if (draft.invoiceNumber !== null) return draft;
  const command = {
    requestId: crypto.randomUUID(),
    invoiceId: draft.id,
    expectedVersion: draft.version,
    op: { kind: 'reserveInvoiceNumber' as const },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return must(await window.bengkelin.drafts.apply(command));
    } catch (error) {
      if (error instanceof LoadError || attempt >= 3) throw error;
    }
  }
}

/**
 * "New Transaction" (spec 49), the default post-login screen. Loads shop
 * context and pickers, then resumes the most recently updated shared draft
 * or starts a new one. Switching drafts and starting new ones always flush
 * pending input first.
 */
export function CashierWorkspace({
  finalizer,
  active = true,
}: CashierWorkspaceProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const context = useRef<{
    shop: ShopSettingsDto;
    references: WorkspaceReferences;
  } | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      setPhase({
        kind: 'failed',
        message:
          error instanceof LoadError
            ? errorMessage(t, error.result.error)
            : t('errors.INTERNAL_ERROR'),
      });
    },
    [t],
  );

  const show = useCallback((draft: DraftView) => {
    const ctx = context.current;
    if (ctx) setPhase({ kind: 'ready', ...ctx, draft });
  }, []);

  const createDraft = useCallback(async (): Promise<DraftView> => {
    const ctx = context.current!;
    const channel =
      ctx.references.channels.find((c) => c.code === 'BENGKEL') ??
      ctx.references.channels[0];
    if (!channel) throw new Error('no active channel');
    const input = {
      // One requestId per "new transaction", reused on retry.
      requestId: crypto.randomUUID(),
      channelId: channel.id,
      invoiceDate: todayInShop(ctx.shop.timezone),
      pricingAt: nowInstant(),
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        return must(await window.bengkelin.drafts.create(input));
      } catch (error) {
        if (error instanceof LoadError || attempt >= 3) throw error;
      }
    }
  }, []);

  /** Most recently updated open draft, else a new one. */
  const resumeOrCreate = useCallback(
    async (skipId?: string): Promise<DraftView> => {
      const drafts: DraftSummary[] = must(await window.bengkelin.drafts.list());
      for (const summary of drafts) {
        if (summary.id === skipId) continue;
        const draft = await window.bengkelin.drafts.get(summary.id);
        if (draft.ok) return ensureInvoiceNumber(draft.value);
      }
      return createDraft();
    },
    [createDraft],
  );

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const b = window.bengkelin;
      const [shop, channels, mechanics, units, sales, expeditions] =
        await Promise.all([
          b.settings.getShop(),
          b.references.listActive({ entity: 'channel' }),
          b.references.listActive({ entity: 'mechanic' }),
          b.references.listActive({ entity: 'unit' }),
          b.references.listActive({ entity: 'sales' }),
          b.references.listActive({ entity: 'expedition' }),
        ]);
      context.current = {
        shop: must(shop),
        references: {
          sales: must<ReferenceDto[]>(sales),
          expeditions: must<ReferenceDto[]>(expeditions),
          channels: must<ReferenceDto[]>(channels),
          mechanics: must<ReferenceDto[]>(mechanics),
          units: must<ReferenceDto[]>(units),
        },
      };
      show(await resumeOrCreate());
    } catch (error) {
      fail(error);
    }
  }, [fail, resumeOrCreate, show]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([
      window.bengkelin.references.listActive({ entity: 'sales' }),
      window.bengkelin.references.listActive({ entity: 'expedition' }),
    ])
      .then(([sales, expeditions]) => {
        if (cancelled || !context.current) return;
        const references = {
          ...context.current.references,
          sales: must(sales),
          expeditions: must(expeditions),
        };
        context.current.references = references;
        setPhase((current) =>
          current.kind === 'ready' ? { ...current, references } : current,
        );
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [active, fail]);

  const flushOrWarn = useCallback(async () => {
    const flushed = await flushAll();
    if (!flushed) setNotice(t('workspace.notices.unsaved'));
    return flushed;
  }, [t]);

  const newDraft = useCallback(async () => {
    if (!(await flushOrWarn())) return;
    try {
      setNotice(null);
      show(await createDraft());
    } catch (error) {
      setNotice(
        error instanceof LoadError
          ? errorMessage(t, error.result.error)
          : t('errors.INTERNAL_ERROR'),
      );
    }
  }, [createDraft, flushOrWarn, show, t]);

  const openDraft = useCallback(
    async (id: string) => {
      if (!(await flushOrWarn())) return;
      try {
        setNotice(null);
        show(
          await ensureInvoiceNumber(
            must(await window.bengkelin.drafts.get(id)),
          ),
        );
      } catch (error) {
        setNotice(
          error instanceof LoadError
            ? errorMessage(t, error.result.error)
            : t('errors.INTERNAL_ERROR'),
        );
      }
    },
    [flushOrWarn, show, t],
  );

  const discardOther = useCallback(
    async (summary: DraftSummary): Promise<string | null> => {
      try {
        const result = await window.bengkelin.drafts.apply({
          requestId: crypto.randomUUID(),
          invoiceId: summary.id,
          expectedVersion: summary.version,
          op: { kind: 'discard' },
        });
        if (result.ok) return null;
        watchSessionError(result.error);
        return errorMessage(t, result.error);
      } catch {
        return t('errors.INTERNAL_ERROR');
      }
    },
    [t],
  );

  const leave = useCallback(
    (code: string) => {
      const current = phase.kind === 'ready' ? phase.draft.id : undefined;
      setNotice(
        code === 'DRAFT_DISCARDED'
          ? t('workspace.notices.discarded')
          : t('workspace.notices.left'),
      );
      resumeOrCreate(current).then(show, fail);
    },
    [fail, phase, resumeOrCreate, show, t],
  );

  if (phase.kind === 'loading') {
    return (
      <p role="status" className="text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert>{phase.message}</Alert>
        <Button onClick={() => void load()}>{t('common.retry')}</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <p
          role="status"
          data-testid="workspace-notice"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}
      <DraftWorkspace
        key={phase.draft.id}
        active={active}
        initialView={phase.draft}
        timezone={phase.shop.timezone}
        references={phase.references}
        onNewDraft={newDraft}
        onOpenDraft={openDraft}
        onDiscardOther={discardOther}
        onLeave={leave}
        finalizer={finalizer}
      />
    </div>
  );
}
