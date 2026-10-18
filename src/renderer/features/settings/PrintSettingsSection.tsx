import { RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { Label } from '@/renderer/components/ui/label';
import { Select } from '@/renderer/components/ui/select';
import { useAction } from '@/renderer/lib/use-action';
import type {
  InvoiceFormat,
  PrintSettingsDto,
  PrinterDto,
} from '@/shared/contracts';

/**
 * Print settings (spec 31), ADMIN only (main enforces it). Printers come
 * from the OS via main; choosing one is always optional. A saved printer
 * that is no longer installed stays visible, marked "not found".
 */
export function PrintSettingsSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PrintSettingsDto | null>(null);
  const [printers, setPrinters] = useState<PrinterDto[]>([]);
  const [saved, setSaved] = useState(false);
  const load = useAction();
  const save = useAction();
  const ids = {
    format: useId(),
    width: useId(),
    a4: useId(),
    thermal: useId(),
    auto: useId(),
  };

  const { run: loadRun, check: loadCheck } = load;

  const loadPrinters = useCallback(
    () =>
      loadRun(async () => {
        const result = await window.bengkelin.printing.listPrinters();
        if (loadCheck(result)) setPrinters(result.value);
      }),
    [loadRun, loadCheck],
  );

  useEffect(() => {
    void loadRun(async () => {
      const result = await window.bengkelin.printing.getSettings();
      if (loadCheck(result)) setSettings(result.value);
      const listed = await window.bengkelin.printing.listPrinters();
      if (loadCheck(listed)) setPrinters(listed.value);
    });
  }, [loadRun, loadCheck]);

  function change(patch: Partial<PrintSettingsDto>) {
    setSaved(false);
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    void save.run(async () => {
      const result = await window.bengkelin.printing.updateSettings(settings);
      if (save.check(result)) {
        setSettings(result.value);
        setSaved(true);
      }
    });
  }

  function printerOptions(selected: string | null) {
    const names = printers.map((p) => p.name);
    return (
      <>
        <option value="">{t('printing.settings.noPrinter')}</option>
        {printers.map((printer) => (
          <option key={printer.name} value={printer.name}>
            {printer.displayName}
          </option>
        ))}
        {selected && !names.includes(selected) ? (
          <option value={selected}>
            {t('printing.settings.missingPrinter', { name: selected })}
          </option>
        ) : null}
      </>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printing.settings.title')}</CardTitle>
        <CardDescription>{t('printing.settings.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {load.error ? <Alert className="mb-3">{load.error}</Alert> : null}
        {settings ? (
          <form
            className="grid gap-3"
            onSubmit={submit}
            aria-label={t('printing.settings.title')}
          >
            <div className="grid gap-1">
              <Label htmlFor={ids.format}>
                {t('printing.settings.defaultFormat')}
              </Label>
              <Select
                id={ids.format}
                value={settings.defaultInvoiceFormat}
                onChange={(e) =>
                  change({
                    defaultInvoiceFormat: e.target.value as InvoiceFormat,
                  })
                }
              >
                <option value="THERMAL">
                  {t('printing.settings.formatThermal')}
                </option>
                <option value="A4">{t('printing.settings.formatA4')}</option>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.width}>
                {t('printing.settings.thermalWidth')}
              </Label>
              <Select
                id={ids.width}
                value={String(settings.thermalPaperWidthMm)}
                onChange={(e) =>
                  change({
                    thermalPaperWidthMm: e.target.value === '80' ? 80 : 58,
                  })
                }
              >
                <option value="58">{t('printing.settings.width58')}</option>
                <option value="80">{t('printing.settings.width80')}</option>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.a4}>{t('printing.settings.a4Printer')}</Label>
              <Select
                id={ids.a4}
                value={settings.defaultA4PrinterName ?? ''}
                onChange={(e) =>
                  change({ defaultA4PrinterName: e.target.value || null })
                }
              >
                {printerOptions(settings.defaultA4PrinterName)}
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.thermal}>
                {t('printing.settings.thermalPrinter')}
              </Label>
              <Select
                id={ids.thermal}
                value={settings.defaultThermalPrinterName ?? ''}
                onChange={(e) =>
                  change({ defaultThermalPrinterName: e.target.value || null })
                }
              >
                {printerOptions(settings.defaultThermalPrinterName)}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <input
                id={ids.auto}
                type="checkbox"
                className="size-4"
                checked={settings.autoPrintAfterFinalize}
                onChange={(e) =>
                  change({ autoPrintAfterFinalize: e.target.checked })
                }
              />
              <Label htmlFor={ids.auto}>
                {t('printing.settings.autoPrint')}
              </Label>
            </div>
            {save.error ? <Alert>{save.error}</Alert> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={save.busy}>
                <Save aria-hidden="true" />
                {t('printing.settings.save')}
              </Button>
              <Button
                variant="outline"
                disabled={load.busy}
                onClick={() => void loadPrinters()}
              >
                <RefreshCw aria-hidden="true" />
                {t('printing.settings.refreshPrinters')}
              </Button>
              <p role="status" className="text-sm text-muted-foreground">
                {saved ? t('printing.settings.saved') : ''}
              </p>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
      </CardContent>
    </Card>
  );
}
