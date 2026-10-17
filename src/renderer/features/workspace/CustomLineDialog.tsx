import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { Input, controlClass } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import { formatIdr, parseRupiahInput } from '@/renderer/lib/money';
import { watchSessionError } from '@/renderer/lib/session-events';
import { cn } from '@/renderer/lib/utils';
import {
  AD_HOC_ITEM_TYPES,
  MAX_LINE_QUANTITY,
  type AdHocItemType,
  type AdHocReferenceDto,
  type DraftOperation,
  type DraftView,
  type ReferenceDto,
} from '@/shared/contracts';
import type { Result } from '@/shared/primitives';

interface CustomLineDialogProps {
  /** Ids of the draft's current lines, to find the one this dialog adds. */
  existingLineIds: readonly string[];
  units: ReferenceDto[];
  mechanics: ReferenceDto[];
  send(op: DraftOperation): Promise<Result<DraftView>>;
  onClose(): void;
  returnFocus(): void;
}

/**
 * A free-form line (spec 12): SERVICE or NON_STOCK_ITEM with reusable
 * ad-hoc reference autocomplete. A mechanic (service lines only) is set with
 * a follow-up updateLine on the new line.
 */
export function CustomLineDialog({
  existingLineIds,
  units,
  mechanics,
  send,
  onClose,
  returnFocus,
}: CustomLineDialogProps) {
  const { t } = useTranslation();
  const listId = useId();
  const titleInputId = useId();
  const typeRef = useRef<HTMLSelectElement>(null);
  const [type, setType] = useState<AdHocItemType>('SERVICE');
  const [title, setTitle] = useState('');
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [mechanicId, setMechanicId] = useState('');
  const [suggestions, setSuggestions] = useState<AdHocReferenceDto[]>([]);
  const [active, setActive] = useState(-1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  /**
   * The line this dialog already added. When the follow-up mechanic
   * assignment failed, a retry only retries that assignment (never a
   * second addCustomLine).
   */
  const createdLineId = useRef<string | null>(null);

  useEffect(() => {
    const query = title.trim();
    if (!query || referenceId) {
      setSuggestions([]);
      return;
    }
    const current = ++seq.current;
    const timer = setTimeout(() => {
      window.bengkelin.adHocReferences
        .search({ query, type, limit: 8 })
        .then((result) => {
          if (current !== seq.current) return;
          if (!result.ok) {
            watchSessionError(result.error);
            return;
          }
          setSuggestions(result.value.results);
          setActive(-1);
        })
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(timer);
  }, [title, type, referenceId]);

  function choose(reference: AdHocReferenceDto) {
    setReferenceId(reference.id);
    setTitle(reference.title);
    setType(reference.type);
    if (reference.unitId) setUnitId(reference.unitId);
    if (reference.defaultPrice) setPrice(reference.defaultPrice);
    setSuggestions([]);
    setActive(-1);
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(
        (index) =>
          (Math.max(index, step > 0 ? -1 : 0) + step + suggestions.length) %
          suggestions.length,
      );
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(suggestions[active]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSuggestions([]);
    }
  }

  /** Sets the mechanic on the created line; false (with a message) on failure. */
  async function assignMechanic(lineId: string): Promise<boolean> {
    if (!mechanicId) return true;
    const assigned = await send({ kind: 'updateLine', lineId, mechanicId });
    if (!assigned.ok) {
      setFormError(errorMessage(t, assigned.error));
      return false;
    }
    return true;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (createdLineId.current) {
      setBusy(true);
      setFormError(null);
      try {
        if (await assignMechanic(createdLineId.current)) onClose();
      } catch {
        setFormError(t('errors.INTERNAL_ERROR'));
      } finally {
        setBusy(false);
      }
      return;
    }
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = 'validation.required';
    const unitPrice = parseRupiahInput(price);
    if (unitPrice === null) next.unitPrice = 'workspace.validation.money';
    const qty = /^\d+$/.test(quantity.trim())
      ? Number.parseInt(quantity.trim(), 10)
      : Number.NaN;
    if (!(qty >= 1 && qty <= MAX_LINE_QUANTITY)) {
      next.quantity = 'workspace.validation.quantity';
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || unitPrice === null) return;

    setBusy(true);
    setFormError(null);
    try {
      const op: Extract<DraftOperation, { kind: 'addCustomLine' }> = {
        kind: 'addCustomLine',
        type,
        title: title.trim(),
        unitPrice,
        quantity: qty,
        unitId: unitId || null,
      };
      if (referenceId) op.adHocItemReferenceId = referenceId;
      const before = new Set(existingLineIds);
      const added = await send(op);
      if (!added.ok) {
        setErrors(added.error.fieldErrors ?? {});
        setFormError(errorMessage(t, added.error));
        return;
      }
      if (type === 'SERVICE' && mechanicId) {
        const line = added.value.lines
          .filter((l) => !before.has(l.id) && l.source === 'CUSTOM')
          .sort((a, b) => b.position - a.position)[0];
        if (line) {
          createdLineId.current = line.id;
          if (!(await assignMechanic(line.id))) return;
        }
      }
      onClose();
    } catch {
      setFormError(t('errors.INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  const open = suggestions.length > 0;
  return (
    <Dialog
      title={t('workspace.custom.title')}
      onClose={onClose}
      initialFocus={typeRef}
      returnFocus={returnFocus}
      closeLabel={t('workspace.common.close')}
      footer={
        <div className="flex justify-between">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
            {t('workspace.common.cancel')}
          </Button>
          <Button type="submit" form="custom-line-form" disabled={busy}>
            <Check aria-hidden="true" />
            {t('workspace.custom.add')}
          </Button>
        </div>
      }
    >
      <form
        id="custom-line-form"
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
      >
        {formError ? <Alert>{formError}</Alert> : null}
        <FormField label={t('workspace.custom.type')}>
          <Select
            ref={typeRef}
            value={type}
            onChange={(event) => {
              setType(event.target.value as AdHocItemType);
              setReferenceId(null);
            }}
          >
            {AD_HOC_ITEM_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`workspace.itemType.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>

        <div className="relative flex flex-col gap-1.5">
          <Label htmlFor={titleInputId}>
            {t('workspace.custom.itemTitle')}
          </Label>
          <input
            id={titleInputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && active >= 0 ? `${listId}-${active}` : undefined
            }
            aria-invalid={errors.title ? true : undefined}
            autoComplete="off"
            className={controlClass}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setReferenceId(null);
            }}
            onKeyDown={onTitleKeyDown}
            onBlur={() => setSuggestions([])}
          />
          {errors.title ? (
            <p className="text-sm text-destructive">{t(errors.title)}</p>
          ) : null}
          <ul
            id={listId}
            role="listbox"
            aria-label={t('workspace.custom.suggestions')}
            hidden={!open}
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
          >
            {suggestions.map((reference, index) => (
              <li
                key={reference.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(reference);
                }}
                className={cn(
                  'flex cursor-pointer justify-between gap-2 px-3 py-2 text-sm',
                  index === active && 'bg-accent text-accent-foreground',
                )}
              >
                <span>{reference.title}</span>
                {reference.defaultPrice ? (
                  <span className="tabular text-muted-foreground">
                    {formatIdr(reference.defaultPrice)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            label={t('workspace.custom.price')}
            error={errors.unitPrice}
          >
            <Input
              type="number"
              autoComplete="off"
              className="tabular"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </FormField>
          <FormField
            label={t('workspace.custom.quantity')}
            error={errors.quantity}
          >
            <Input
              type="number"
              autoComplete="off"
              className="tabular"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </FormField>
          <FormField label={t('workspace.custom.unit')}>
            <Select
              value={unitId}
              onChange={(event) => setUnitId(event.target.value)}
            >
              <option value="">{t('workspace.custom.noUnit')}</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        {type === 'SERVICE' ? (
          <FormField label={t('workspace.custom.mechanic')}>
            <Select
              value={mechanicId}
              onChange={(event) => setMechanicId(event.target.value)}
            >
              <option value="">{t('workspace.editor.noMechanic')}</option>
              {mechanics.map((mechanic) => (
                <option key={mechanic.id} value={mechanic.id}>
                  {mechanic.label}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
      </form>
    </Dialog>
  );
}
