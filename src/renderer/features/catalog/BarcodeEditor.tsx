import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import type { CatalogItemDto } from '@/shared/contracts';

interface BarcodeEditorProps {
  item: CatalogItemDto;
  onChanged(item: CatalogItemDto): void;
}

/**
 * ADMIN barcode editor. Barcodes are text (leading zeros kept), unique across
 * all items, and never deleted: an unwanted one is deactivated.
 */
export function BarcodeEditor({ item, onChanged }: BarcodeEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const { busy, error, fieldErrors, run, check } = useAction();

  function save(barcode: string, isActive: boolean, clear: boolean) {
    void run(async () => {
      const result = await window.bengkelin.catalog.saveBarcodes({
        catalogItemId: item.id,
        barcodes: [{ barcode, isActive }],
      });
      if (!check(result)) return;
      if (clear) setValue('');
      onChanged(result.value);
    });
  }

  function add(event: FormEvent) {
    event.preventDefault();
    save(value, true, true);
  }

  return (
    <section
      aria-label={t('catalog.barcodes.title')}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">{t('catalog.barcodes.title')}</h2>
      {error ? <Alert>{error}</Alert> : null}
      {item.barcodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('catalog.barcodes.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {item.barcodes.map((entry) => (
            <li
              key={entry.id}
              data-testid="barcode-row"
              className="flex items-center gap-3"
            >
              <span
                className={
                  entry.isActive
                    ? 'font-mono'
                    : 'font-mono text-muted-foreground line-through'
                }
              >
                {entry.barcode}
              </span>
              <span className="text-muted-foreground">
                {entry.isActive
                  ? t('catalog.status.active')
                  : t('catalog.status.inactive')}
              </span>
              <Button
                variant={entry.isActive ? 'destructive-outline' : 'outline'}
                size="sm"
                disabled={busy}
                aria-label={`${entry.isActive ? t('catalog.barcodes.deactivate') : t('catalog.barcodes.activate')}: ${entry.barcode}`}
                onClick={() => save(entry.barcode, !entry.isActive, false)}
              >
                {entry.isActive
                  ? t('catalog.barcodes.deactivate')
                  : t('catalog.barcodes.activate')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} noValidate className="flex items-end gap-2">
        <div className="flex-1">
          <FormField
            label={t('catalog.barcodes.new')}
            hint={t('catalog.barcodes.hint')}
            error={fieldErrors['barcodes.0.barcode']}
          >
            <Input
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </FormField>
        </div>
        <Button type="submit" disabled={busy}>
          {t('catalog.barcodes.add')}
        </Button>
      </form>
    </section>
  );
}
