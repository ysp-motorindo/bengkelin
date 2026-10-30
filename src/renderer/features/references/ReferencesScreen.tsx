import { ReferenceImportDialog } from './ReferenceImportDialog';
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { cn } from '@/renderer/lib/utils';
import { useAction } from '@/renderer/lib/use-action';
import { AdHocReferencesPanel } from './AdHocReferencesPanel';
import {
  REFERENCE_ENTITIES,
  type ReferenceDto,
  type ReferenceEntity,
} from '@/shared/contracts';

type Tab = ReferenceEntity | 'adHoc';
const TABS: readonly Tab[] = [...REFERENCE_ENTITIES, 'adHoc'];

/**
 * ADMIN reference management (spec 55): one tab per entity with create, edit,
 * deactivate and reactivate, plus the custom-line references (spec 12).
 * Authorization is enforced in main; this screen is only reachable from the
 * ADMIN navigation.
 */
export function ReferencesScreen() {
  const { t } = useTranslation();
  const [entity, setEntity] = useState<Tab>('mechanic');

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(entity);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft')
      next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    setEntity(TABS[next] as Tab);
    requestAnimationFrame(() =>
      document.getElementById(`ref-tab-${TABS[next]}`)?.focus(),
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-xl font-semibold leading-tight tracking-tight">
        {t('references.title')}
      </h1>
      <div
        role="tablist"
        aria-label={t('references.title')}
        className="flex flex-wrap gap-1 border-b border-border"
        onKeyDown={onTabKey}
      >
        {TABS.map((name) => (
          <button
            key={name}
            id={`ref-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={entity === name}
            aria-controls="ref-panel"
            tabIndex={entity === name ? 0 : -1}
            onClick={() => setEntity(name)}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              entity === name
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {name === 'adHoc'
              ? t('adHocReferences.tab')
              : t(`references.entities.${name}`)}
          </button>
        ))}
      </div>
      <div id="ref-panel" role="tabpanel" aria-labelledby={`ref-tab-${entity}`}>
        {entity === 'adHoc' ? (
          <AdHocReferencesPanel />
        ) : (
          <EntityPanel key={entity} entity={entity} />
        )}
      </div>
    </div>
  );
}

type Editing = { kind: 'new' } | { kind: 'edit'; item: ReferenceDto } | null;

function EntityPanel({ entity }: { entity: ReferenceEntity }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ReferenceDto[]>([]);
  const [brands, setBrands] = useState<ReferenceDto[]>([]);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const { busy, error, run, check } = useAction();

  const load = useCallback(() => {
    void run(async () => {
      const list = await window.bengkelin.references.list({ entity });
      if (check(list)) setItems(list.value);
      if (entity === 'vehicleModel') {
        const all = await window.bengkelin.references.list({
          entity: 'vehicleBrand',
        });
        if (check(all)) setBrands(all.value);
      }
    });
  }, [entity, run, check]);

  useEffect(load, [load]);

  function toggle(item: ReferenceDto) {
    void run(async () => {
      const call = item.isActive
        ? window.bengkelin.references.deactivate
        : window.bengkelin.references.reactivate;
      const result = await call({ entity, id: item.id });
      if (check(result)) {
        setItems((current) =>
          current.map((c) => (c.id === item.id ? result.value : c)),
        );
      }
    });
  }

  const brandName = (id: string | null) =>
    brands.find((b) => b.id === id)?.label ?? '';

  return (
    <div className="flex flex-col gap-4">
      {importing && (entity === 'sales' || entity === 'expedition') ? (
        <ReferenceImportDialog
          entity={entity}
          onClose={() => setImporting(false)}
          onImported={load}
        />
      ) : null}
      {error && !editing ? <Alert>{error}</Alert> : null}
      <div className="flex gap-2">
        {entity === 'sales' || entity === 'expedition' ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setImporting(true)}
            >
              {t('references.import.title')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result =
                    await window.bengkelin.referenceTransfer.downloadTemplate({
                      entity,
                    });
                  if (check(result) && result.value.outcome === 'FAILED')
                    throw new Error(t('errors.EXPORT_FAILED'));
                })
              }
            >
              {t('references.import.template')}
            </Button>
          </>
        ) : null}
        <Button onClick={() => setEditing({ kind: 'new' })} disabled={busy}>
          {t('references.actions.add')}
        </Button>
      </div>

      {editing ? (
        <EntityForm
          key={editing.kind === 'edit' ? editing.item.id : 'new'}
          entity={entity}
          editing={editing}
          brands={brands.filter((b) => b.isActive || editing.kind === 'edit')}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setItems((current) => {
              const exists = current.some((c) => c.id === saved.id);
              return exists
                ? current.map((c) => (c.id === saved.id ? saved : c))
                : [...current, saved].sort((a, b) =>
                    a.label.localeCompare(b.label),
                  );
            });
          }}
        />
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('references.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {entity === 'channel' ||
              entity === 'unit' ||
              entity === 'sales' ||
              entity === 'expedition' ? (
                <th scope="col" className="p-2">
                  {t('references.fields.code')}
                </th>
              ) : null}
              <th scope="col" className="p-2">
                {t(
                  entity === 'channel' ||
                    entity === 'unit' ||
                    entity === 'sales' ||
                    entity === 'expedition'
                    ? 'references.fields.label'
                    : 'references.fields.name',
                )}
              </th>
              {entity === 'mechanic' || entity === 'sales' ? (
                <th scope="col" className="p-2">
                  {t('references.fields.phone')}
                </th>
              ) : null}
              {entity === 'vehicleModel' ? (
                <th scope="col" className="p-2">
                  {t('references.fields.brand')}
                </th>
              ) : null}
              <th scope="col" className="p-2">
                {t('references.fields.status')}
              </th>
              <th scope="col" className="p-2">
                <span className="sr-only">{t('references.actions.label')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border">
                {entity === 'channel' ||
                entity === 'unit' ||
                entity === 'sales' ||
                entity === 'expedition' ? (
                  <td className="p-2 font-mono">{item.code}</td>
                ) : null}
                <td className="p-2">{item.label}</td>
                {entity === 'mechanic' || entity === 'sales' ? (
                  <td className="p-2">{item.phoneNumber}</td>
                ) : null}
                {entity === 'vehicleModel' ? (
                  <td className="p-2">{brandName(item.brandId)}</td>
                ) : null}
                <td className="p-2">
                  {item.isActive
                    ? t('references.status.active')
                    : t('references.status.inactive')}
                </td>
                <td className="flex justify-end gap-2 p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${t('references.actions.edit')}: ${item.label}`}
                    onClick={() => setEditing({ kind: 'edit', item })}
                  >
                    {t('references.actions.edit')}
                  </Button>
                  <Button
                    variant={item.isActive ? 'destructive-outline' : 'outline'}
                    size="sm"
                    disabled={busy}
                    aria-label={`${t(item.isActive ? 'references.actions.deactivate' : 'references.actions.reactivate')}: ${item.label}`}
                    onClick={() => toggle(item)}
                  >
                    {t(
                      item.isActive
                        ? 'references.actions.deactivate'
                        : 'references.actions.reactivate',
                    )}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EntityForm({
  entity,
  editing,
  brands,
  onCancel,
  onSaved,
}: {
  entity: ReferenceEntity;
  editing: NonNullable<Editing>;
  brands: ReferenceDto[];
  onCancel(): void;
  onSaved(item: ReferenceDto): void;
}) {
  const { t } = useTranslation();
  const item = editing.kind === 'edit' ? editing.item : null;
  const coded =
    entity === 'channel' ||
    entity === 'unit' ||
    entity === 'sales' ||
    entity === 'expedition';
  const [label, setLabel] = useState(item?.label ?? '');
  const [address, setAddress] = useState(item?.address ?? '');
  const [city, setCity] = useState(item?.city ?? '');
  const [phone, setPhone] = useState(item?.phoneNumber ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [brandId, setBrandId] = useState(item?.brandId ?? '');
  const { busy, error, fieldErrors, run, check } = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const id = item?.id;
      const base = id ? { id } : {};
      let result;
      switch (entity) {
        case 'mechanic':
          result = await window.bengkelin.references.save({
            entity,
            ...base,
            name: label,
            phoneNumber: phone,
          });
          break;
        case 'vehicleBrand':
          result = await window.bengkelin.references.save({
            entity,
            ...base,
            name: label,
          });
          break;
        case 'vehicleModel':
          result = await window.bengkelin.references.save({
            entity,
            ...base,
            brandId,
            name: label,
          });
          break;
        case 'sales':
        case 'expedition':
          result = await window.bengkelin.references.save({
            entity,
            ...base,
            ...(item ? {} : { code }),
            label,
            address,
            city,
            ...(entity === 'sales' ? { phoneNumber: phone } : {}),
          });
          break;
        default:
          result = await window.bengkelin.references.save({
            entity,
            ...base,
            ...(item ? {} : { code }),
            label,
          });
      }
      if (check(result)) onSaved(result.value);
    });
  }

  const nameError = fieldErrors.name ?? fieldErrors.label;

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t(item ? 'references.form.edit' : 'references.form.create')}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <h2 className="font-medium">
        {t(item ? 'references.form.edit' : 'references.form.create')}
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      {entity === 'vehicleModel' ? (
        <FormField
          label={t('references.fields.brand')}
          error={fieldErrors.brandId}
        >
          <Select
            value={brandId}
            disabled={item !== null}
            onChange={(e) => setBrandId(e.target.value)}
          >
            <option value="" />
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.label}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
      {coded ? (
        <FormField
          label={t('references.fields.code')}
          error={fieldErrors.code}
          hint={t('references.codeHint')}
        >
          <Input
            value={code}
            disabled={item !== null}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </FormField>
      ) : null}
      <FormField
        label={t(coded ? 'references.fields.label' : 'references.fields.name')}
        error={nameError}
      >
        <Input
          autoFocus
          autoComplete="off"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </FormField>
      {entity === 'mechanic' || entity === 'sales' ? (
        <FormField
          label={t('references.fields.phone')}
          error={fieldErrors.phoneNumber}
        >
          <Input
            type="tel"
            autoComplete="off"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </FormField>
      ) : null}
      {entity === 'sales' || entity === 'expedition' ? (
        <>
          <FormField
            label={t('references.fields.address')}
            error={fieldErrors.address}
          >
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </FormField>
          <FormField
            label={t('references.fields.city')}
            error={fieldErrors.city}
          >
            <Input value={city} onChange={(e) => setCity(e.target.value)} />
          </FormField>
        </>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t('common.saving') : t('references.actions.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('references.actions.cancel')}
        </Button>
      </div>
    </form>
  );
}
