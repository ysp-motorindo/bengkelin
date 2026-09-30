import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import {
  CATALOG_ITEM_TYPES,
  type CatalogItemDto,
  type CatalogItemType,
  type ReferenceDto,
} from '@/shared/contracts';

interface ItemFormProps {
  /** Absent: create. */
  item?: CatalogItemDto | undefined;
  onSaved(item: CatalogItemDto): void;
  onCancel(): void;
}

/** ADMIN create/edit form. Services never track inventory (disabled + off). */
export function ItemForm({ item, onSaved, onCancel }: ItemFormProps) {
  const { t } = useTranslation();
  const [units, setUnits] = useState<ReferenceDto[]>([]);
  const [type, setType] = useState<CatalogItemType>(item?.type ?? 'STOCK_ITEM');
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [sku, setSku] = useState(item?.sku ?? '');
  const [unitId, setUnitId] = useState(item?.unitId ?? '');
  const [weight, setWeight] = useState(
    item?.weight === null || item?.weight === undefined
      ? ''
      : String(item.weight),
  );
  const [trackInventory, setTrackInventory] = useState(
    item?.trackInventory ?? true,
  );
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const { busy, error, fieldErrors, run, check } = useAction();

  useEffect(() => {
    void run(async () => {
      const result = await window.bengkelin.references.listActive({
        entity: 'unit',
      });
      if (!check(result)) return;
      setUnits(result.value);
      setUnitId(
        (current) =>
          current ||
          result.value.find((unit) => unit.code === 'PCS')?.id ||
          result.value[0]?.id ||
          '',
      );
    });
  }, [run, check]);

  function changeType(next: CatalogItemType) {
    setType(next);
    if (next === 'SERVICE') setTrackInventory(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const trimmedWeight = weight.trim();
      const result = await window.bengkelin.catalog.save({
        ...(item ? { id: item.id } : {}),
        type,
        title,
        description,
        sku,
        unitId,
        weight: trimmedWeight === '' ? null : Number(trimmedWeight),
        trackInventory: type === 'SERVICE' ? false : trackInventory,
        isActive,
      });
      if (check(result)) onSaved(result.value);
    });
  }

  const unitOptions =
    units.some((unit) => unit.id === unitId) || !item
      ? units
      : [
          ...units,
          {
            id: item.unitId,
            label: item.unitLabel,
            code: item.unitCode,
          } as ReferenceDto,
        ];

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={
        item ? t('catalog.form.editTitle') : t('catalog.form.createTitle')
      }
      className="flex max-w-xl flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">
        {item ? t('catalog.form.editTitle') : t('catalog.form.createTitle')}
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      <FormField label={t('catalog.form.type')} error={fieldErrors.type}>
        <Select
          value={type}
          onChange={(event) =>
            changeType(event.target.value as CatalogItemType)
          }
        >
          {CATALOG_ITEM_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`catalog.type.${value}`)}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label={t('catalog.form.title')} error={fieldErrors.title}>
        <Input
          autoComplete="off"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </FormField>
      <FormField
        label={t('catalog.form.description')}
        error={fieldErrors.description}
      >
        <Input
          autoComplete="off"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>
      <FormField label={t('catalog.form.sku')} error={fieldErrors.sku}>
        <Input
          autoComplete="off"
          value={sku}
          onChange={(event) => setSku(event.target.value)}
        />
      </FormField>
      <FormField label={t('catalog.form.unit')} error={fieldErrors.unitId}>
        <Select
          value={unitId}
          onChange={(event) => setUnitId(event.target.value)}
        >
          {unitOptions.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label={t('catalog.form.weight')} error={fieldErrors.weight}>
        <Input
          inputMode="numeric"
          autoComplete="off"
          value={weight}
          onChange={(event) => setWeight(event.target.value)}
        />
      </FormField>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={type === 'SERVICE' ? false : trackInventory}
            disabled={type === 'SERVICE'}
            onChange={(event) => setTrackInventory(event.target.checked)}
          />
          {t('catalog.form.trackInventory')}
        </label>
        {type === 'SERVICE' ? (
          <p className="text-sm text-muted-foreground">
            {t('catalog.form.trackInventoryHintService')}
          </p>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        {t('catalog.form.active')}
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t('common.saving') : t('catalog.form.save')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {t('catalog.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
