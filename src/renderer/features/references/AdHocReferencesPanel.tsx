import { useNumberFormat } from '@/renderer/lib/number-format';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import type { AdHocReferenceDto } from '@/shared/contracts';

/**
 * ADMIN custom-line references (spec 12): every reference with its status,
 * a title filter, description editing, and deactivate/reactivate. An
 * inactive reference leaves the cashier autocomplete; invoice lines that
 * used it keep their title and link.
 */
export function AdHocReferencesPanel() {
  const { formatIdr } = useNumberFormat();
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AdHocReferenceDto[]>([]);
  const [editing, setEditing] = useState<AdHocReferenceDto | null>(null);
  const { busy, error, run, check } = useAction();

  const load = useCallback(
    (text: string) => {
      void run(async () => {
        const result = await window.bengkelin.adHocReferences.list(
          text.trim() ? { query: text } : {},
        );
        if (check(result)) setItems(result.value);
      });
    },
    [run, check],
  );

  useEffect(() => load(''), [load]);

  const replace = (next: AdHocReferenceDto) =>
    setItems((current) => current.map((c) => (c.id === next.id ? next : c)));

  function toggle(item: AdHocReferenceDto) {
    void run(async () => {
      const call = item.isActive
        ? window.bengkelin.adHocReferences.deactivate
        : window.bengkelin.adHocReferences.reactivate;
      const result = await call({ id: item.id });
      if (check(result)) replace(result.value);
    });
  }

  function search(event: FormEvent) {
    event.preventDefault();
    load(query);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t('adHocReferences.description')}
      </p>
      {error && !editing ? <Alert>{error}</Alert> : null}
      <form role="search" onSubmit={search} className="flex items-end gap-2">
        <div className="flex-1">
          <FormField label={t('adHocReferences.search')}>
            <Input
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </FormField>
        </div>
        <Button type="submit" variant="outline" disabled={busy}>
          {t('adHocReferences.search')}
        </Button>
      </form>

      {editing ? (
        <DescriptionForm
          item={editing}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            replace(saved);
            setEditing(null);
          }}
        />
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('adHocReferences.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="p-2">
                  {t('adHocReferences.fields.title')}
                </th>
                <th scope="col" className="p-2">
                  {t('adHocReferences.fields.type')}
                </th>
                <th scope="col" className="p-2">
                  {t('adHocReferences.fields.description')}
                </th>
                <th scope="col" className="p-2 text-right">
                  {t('adHocReferences.fields.defaultPrice')}
                </th>
                <th scope="col" className="p-2">
                  {t('adHocReferences.fields.status')}
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">
                    {t('adHocReferences.actions.label')}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  data-testid="adhoc-row"
                  className="border-b border-border"
                >
                  <td className="p-2">{item.title}</td>
                  <td className="p-2">
                    {t(`adHocReferences.types.${item.type}`)}
                  </td>
                  <td className="p-2 text-muted-foreground">
                    {item.description ?? ''}
                  </td>
                  <td className="tabular p-2 text-right">
                    {item.defaultPrice === null
                      ? ''
                      : formatIdr(item.defaultPrice)}
                  </td>
                  <td className="p-2">
                    {item.isActive
                      ? t('adHocReferences.status.active')
                      : t('adHocReferences.status.inactive')}
                  </td>
                  <td className="flex justify-end gap-2 p-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`${t('adHocReferences.actions.edit')}: ${item.title}`}
                      onClick={() => setEditing(item)}
                    >
                      {t('adHocReferences.actions.edit')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${t(item.isActive ? 'adHocReferences.actions.deactivate' : 'adHocReferences.actions.reactivate')}: ${item.title}`}
                      onClick={() => toggle(item)}
                    >
                      {t(
                        item.isActive
                          ? 'adHocReferences.actions.deactivate'
                          : 'adHocReferences.actions.reactivate',
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DescriptionForm({
  item,
  onCancel,
  onSaved,
}: {
  item: AdHocReferenceDto;
  onCancel(): void;
  onSaved(item: AdHocReferenceDto): void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState(item.description ?? '');
  const { busy, error, fieldErrors, run, check } = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await window.bengkelin.adHocReferences.update({
        id: item.id,
        description,
      });
      if (check(result)) onSaved(result.value);
    });
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={t('adHocReferences.editTitle', { title: item.title })}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <h2 className="font-medium">
        {t('adHocReferences.editTitle', { title: item.title })}
      </h2>
      {error ? <Alert>{error}</Alert> : null}
      <FormField
        label={t('adHocReferences.fields.description')}
        error={fieldErrors.description}
      >
        <Input
          autoFocus
          autoComplete="off"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {t('adHocReferences.actions.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('adHocReferences.actions.cancel')}
        </Button>
      </div>
    </form>
  );
}
