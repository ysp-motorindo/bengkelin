import { ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { useAction } from '@/renderer/lib/use-action';
import type { LogoDto } from '@/shared/contracts';

/**
 * Shop logo (spec 32), ADMIN only. Main shows the native file dialog and
 * validates the image; the renderer never sends a path.
 */
export function ShopLogoSection() {
  const { t } = useTranslation();
  const [logo, setLogo] = useState<LogoDto | null>(null);
  const [notice, setNotice] = useState('');
  const { busy, error, run, check } = useAction();

  useEffect(() => {
    void run(async () => {
      const result = await window.bengkelin.settings.getLogo();
      if (check(result)) setLogo(result.value);
    });
  }, [run, check]);

  function choose() {
    setNotice('');
    void run(async () => {
      const result = await window.bengkelin.settings.chooseLogo();
      if (!check(result)) return;
      if (result.value.outcome === 'UPDATED') {
        setLogo(result.value.logo);
        setNotice(t('printing.logo.updated'));
      }
    });
  }

  function remove() {
    setNotice('');
    void run(async () => {
      const result = await window.bengkelin.settings.removeLogo();
      if (check(result)) {
        setLogo(null);
        setNotice(t('printing.logo.removed'));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('printing.logo.title')}</CardTitle>
        <CardDescription>{t('printing.logo.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {logo ? (
          <img
            src={logo.dataUrl}
            alt={t('printing.logo.alt')}
            data-testid="shop-logo"
            className="max-h-24 max-w-64 rounded border border-border bg-white object-contain p-2"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('printing.logo.none')}
          </p>
        )}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={choose} disabled={busy}>
            <ImagePlus aria-hidden="true" />
            {t('printing.logo.choose')}
          </Button>
          <Button
            variant="destructive-outline"
            onClick={remove}
            disabled={busy || logo === null}
          >
            <Trash2 aria-hidden="true" />
            {t('printing.logo.remove')}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
