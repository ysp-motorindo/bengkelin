import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Dialog } from '@/renderer/components/ui/dialog';
import { errorMessage } from '@/renderer/lib/errors';
import type { AboutDto } from '@/shared/contracts';

/** Help > About: application and database schema version. */
export function AboutDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const [about, setAbout] = useState<AboutDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.bengkelin.app.about().then(
      (result) => {
        if (!live) return;
        if (result.ok) setAbout(result.value);
        else setError(errorMessage(t, result.error));
      },
      () => live && setError(t('errors.INTERNAL_ERROR')),
    );
    return () => {
      live = false;
    };
  }, [t]);

  return (
    <Dialog
      title={t('shell.about.title')}
      description={t('shell.about.description')}
      onClose={onClose}
      closeLabel={t('shell.about.close')}
      footer={
        <div className="flex justify-start">
          <Button variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            {t('shell.about.close')}
          </Button>
        </div>
      }
    >
      {error ? <Alert>{error}</Alert> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('shell.about.version')}</dt>
        <dd className="tabular" data-testid="about-version">
          {about?.appVersion ?? ''}
        </dd>
        <dt className="text-muted-foreground">{t('shell.about.schema')}</dt>
        <dd className="tabular" data-testid="about-schema">
          {about ? String(about.schemaVersion) : ''}
        </dd>
      </dl>
    </Dialog>
  );
}
