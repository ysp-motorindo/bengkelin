import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { useAction } from '@/renderer/lib/use-action';
import type { PublicSettings, ShopSettingsDto } from '@/shared/contracts';

interface ShopForm {
  name: string;
  address: string;
  phoneNumber: string;
  complaintPhoneNumber: string;
  socialMediaUrl: string;
  email: string;
  invoiceFooter: string;
  timezone: string;
}

const toForm = (shop: ShopSettingsDto): ShopForm => ({
  name: shop.name,
  address: shop.address,
  phoneNumber: shop.phoneNumber ?? '',
  complaintPhoneNumber: shop.complaintPhoneNumber ?? '',
  socialMediaUrl: shop.socialMediaUrl ?? '',
  email: shop.email ?? '',
  invoiceFooter: shop.invoiceFooter ?? '',
  timezone: shop.timezone,
});

/** The same IANA check main applies (timezoneSchema). */
export function isKnownTimezone(zone: string): boolean {
  if (zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

function suggestedZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
  }
}

/**
 * ADMIN shop identity (spec 32, T17): name, address, phone, email, invoice
 * footer and timezone, saved with `settings.updateShop` (validated again in
 * main). A timezone change warns that report day boundaries and invoice
 * numbering follow the new zone from now on.
 */
export function ShopSettingsSection({
  onSaved,
}: {
  /** Receives the refreshed public settings (the header shows the name). */
  onSaved?: ((settings: PublicSettings) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<ShopForm | null>(null);
  const [form, setForm] = useState<ShopForm | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const { busy, error, fieldErrors, run, check } = useAction();
  const zones = useMemo(suggestedZones, []);

  useEffect(() => {
    void run(async () => {
      const result = await window.bengkelin.settings.getShop();
      if (check(result)) {
        setSaved(toForm(result.value));
        setForm(toForm(result.value));
      }
    });
  }, [run, check]);

  if (!form || !saved) {
    return error ? <Alert>{error}</Alert> : null;
  }

  const set = (field: keyof ShopForm) => (value: string) => {
    setForm((current) => (current ? { ...current, [field]: value } : current));
    setMessage(null);
  };
  const timezoneChanged = form.timezone.trim() !== saved.timezone;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setMessage(null);
    if (!isKnownTimezone(form.timezone)) {
      setLocalErrors({ timezone: 'validation.invalidTimezone' });
      return;
    }
    setLocalErrors({});
    const input = { ...form, timezone: form.timezone.trim() };
    void run(async () => {
      const result = await window.bengkelin.settings.updateShop(input);
      if (!check(result)) return;
      setSaved(input);
      setMessage(t('settings.shop.saved'));
      const next = await window.bengkelin.settings.getPublic();
      if (next.ok) onSaved?.(next.value);
    });
  }

  const errors = { ...fieldErrors, ...localErrors };
  const field = (
    name: keyof ShopForm,
    label: string,
    extra: { type?: string; hint?: string } = {},
  ) => (
    <FormField label={label} error={errors[name]} hint={extra.hint}>
      <Input
        type={extra.type ?? 'text'}
        autoComplete="off"
        value={form[name]}
        onChange={(e) => set(name)(e.target.value)}
      />
    </FormField>
  );

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label={t('settings.shop.title')}>
        <CardHeader>
          <CardTitle>{t('settings.shop.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('settings.shop.description')}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? <Alert>{error}</Alert> : null}
          {field('name', t('settings.shop.name'))}
          {field('address', t('settings.shop.address'))}
          <div className="grid gap-3 sm:grid-cols-2">
            {field('phoneNumber', t('settings.shop.phone'), { type: 'tel' })}
            {field('email', t('settings.shop.email'), { type: 'email' })}
          </div>
          {field(
            'complaintPhoneNumber',
            t('settings.shop.complaintPhoneNumber'),
            { type: 'tel', hint: t('settings.shop.contactHint') },
          )}
          {field('socialMediaUrl', t('settings.shop.socialMediaUrl'), {
            type: 'url',
            hint: t('settings.shop.contactHint'),
          })}
          {field('invoiceFooter', t('settings.shop.footer'))}
          <FormField
            label={t('settings.shop.timezone')}
            error={errors.timezone}
            hint={t('settings.shop.timezoneHint')}
          >
            <Input
              autoComplete="off"
              list="shop-timezones"
              value={form.timezone}
              onChange={(e) => set('timezone')(e.target.value)}
            />
          </FormField>
          <datalist id="shop-timezones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          {timezoneChanged ? (
            <p
              data-testid="timezone-warning"
              className="flex items-start gap-2 rounded-md border border-warning bg-warning-surface p-2 text-sm"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{t('settings.shop.timezoneWarning')}</span>
            </p>
          ) : null}
          <p role="status" className="text-sm text-muted-foreground">
            {message ?? ''}
          </p>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('settings.shop.save')}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
