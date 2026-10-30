import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/renderer/components/ui/dialog';
import { errorMessage } from '@/renderer/lib/errors';
import type { ReferenceDto } from '@/shared/contracts';
import { SaveIndicator } from './SaveIndicator';
import { CustomLineEntry } from './CustomLineEntry';
import { ScannerCombobox, type ScanOutcome } from './ScannerCombobox';
import type { DraftCommands } from './use-draft-commands';
export interface LineEntryRowHandle {
  focusSearch(): void;
  startCustom(): void;
}
interface Props {
  commands: DraftCommands;
  units: ReferenceDto[];
  mechanics: ReferenceDto[];
  entryRef?: Ref<LineEntryRowHandle>;
}
export function LineEntryRow({ commands, units, mechanics, entryRef }: Props) {
  const { t } = useTranslation();
  const search = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const submissions = useRef(Promise.resolve<ScanOutcome>('other'));
  const [custom, setCustom] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [priceFocus, setPriceFocus] = useState<string | null>(null);
  const { markInvalid } = commands;
  const dirty = useCallback(
    (value: boolean) => markInvalid('entry', value),
    [markInvalid],
  );
  useEffect(() => () => markInvalid('entry', false), [markInvalid]);
  const focus = () => search.current?.focus();
  function startCustom() {
    revision.current++;
    dirty(false);
    setCustom(true);
  }
  useImperativeHandle(entryRef, () => ({ focusSearch: focus, startCustom }));
  function closeCustom() {
    if (customBusy) return;
    setCustom(false);
    dirty(false);
  }
  useEffect(() => {
    if (!priceFocus) return;
    const input = document.querySelector<HTMLInputElement>(
      `[data-line-id="${priceFocus}"] [data-price-input]`,
    );
    if (input) {
      input.focus();
      setPriceFocus(null);
    }
  }, [priceFocus, commands.view.lines]);
  function enqueue(
    target: { barcode: string } | { catalogItemId: string },
  ): Promise<ScanOutcome> {
    const submittedRevision = revision.current;
    const next = submissions.current.then(async (): Promise<ScanOutcome> => {
      dirty(true);
      const before = new Set(commands.getView().lines.map((line) => line.id));
      try {
        const result = await commands.send({
          kind: 'addCatalogLine',
          ...target,
          quantity: 1,
        });
        if (!result.ok) {
          const message = errorMessage(t, result.error);
          setFeedback(
            'barcode' in target ? `${message} (${target.barcode})` : message,
          );
          return result.error.code === 'UNKNOWN_BARCODE' ? 'unknown' : 'other';
        }
        if (submittedRevision === revision.current) {
          dirty(false);
          setFeedback(null);
          const unpriced = result.value.lines.find(
            (line) => !before.has(line.id) && !line.priceEntryConfirmed,
          );
          if (
            unpriced &&
            (document.activeElement === search.current ||
              document.activeElement === document.body)
          )
            setPriceFocus(unpriced.id);
        }
        return 'added';
      } catch {
        setFeedback(t('errors.INTERNAL_ERROR'));
        return 'other';
      }
    });
    submissions.current = next;
    return next;
  }
  return (
    <tr
      data-testid="line-entry"
      className="border-t-2 border-amber-300 bg-amber-50/60 dark:bg-amber-950/20"
    >
      <td colSpan={11} className="px-2 py-2">
        <ScannerCombobox
          compact
          inputRef={search}
          onCustom={startCustom}
          onScan={(barcode) => enqueue({ barcode })}
          onPick={async (item) => {
            await enqueue({ catalogItemId: item.id });
          }}
          feedback={feedback}
          onClearFeedback={() => setFeedback(null)}
          onTextChange={(text) => {
            revision.current++;
            dirty(!!text);
          }}
        />
        {custom ? (
          <Dialog
            title={t('workspace.custom.title')}
            onClose={closeCustom}
            returnFocus={focus}
            closeLabel={t('workspace.common.close')}
          >
            {commands.saveState === 'failed' ? (
              <SaveIndicator
                state={commands.saveState}
                onRetry={commands.retry}
              />
            ) : null}
            <CustomLineEntry
              existingLineIds={commands.view.lines.map((line) => line.id)}
              units={units}
              mechanics={mechanics}
              send={commands.send}
              onClose={() => {
                setCustom(false);
                dirty(false);
              }}
              onDirtyChange={dirty}
              onBusyChange={setCustomBusy}
            />
          </Dialog>
        ) : null}
      </td>
    </tr>
  );
}
