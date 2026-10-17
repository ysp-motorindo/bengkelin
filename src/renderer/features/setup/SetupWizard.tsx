import { useNumberFormat } from '@/renderer/lib/number-format';
import { NumberFormatPicker } from '@/renderer/components/ui/number-format-picker';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Wrench,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { FormField } from '@/renderer/components/form-field';
import { Alert } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Select } from '@/renderer/components/ui/select';
import { errorMessage } from '@/renderer/lib/errors';
import {
  APPEARANCES,
  LANGUAGES,
  setupInputSchema,
  shopSettingsInputSchema,
  type Appearance,
  type Language,
  type NumberFormat,
  type PublicSettings,
  type SetupInput,
} from '@/shared/contracts';

const STEPS = ['shop', 'admin', 'preferences', 'printer', 'finish'] as const;
type Step = (typeof STEPS)[number];
const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;

interface Draft {
  shopName: string;
  address: string;
  phoneNumber: string;
  email: string;
  invoiceFooter: string;
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
  language: Language;
  appearance: Appearance;
  numberFormat: NumberFormat;
  timezone: string;
  thermalPrinterName: string;
  a4PrinterName: string;
  thermalPaperWidthMm: '58' | '80';
}

interface SetupWizardProps {
  language: Language;
  appearance: Appearance;
  systemNumberLocale: string;
  /** Live preview: language/appearance apply immediately as they are chosen. */
  onPreview(preferences: {
    language: Language;
    appearance: Appearance;
    numberFormat: NumberFormat;
  }): void;
  onCompleted(settings: PublicSettings): void;
}

const shopStepSchema = shopSettingsInputSchema.omit({ timezone: true });
const adminStepSchema = setupInputSchema.shape.admin;

/** Flattens Zod issues into `{ 'shop.name': 'validation.required' }`. */
function flatten(
  prefix: string,
  issues: z.core.$ZodIssue[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = [prefix, ...issue.path.map(String)].join('.');
    out[key] ??= issue.message.startsWith('validation.')
      ? issue.message
      : 'validation.invalid';
  }
  return out;
}

function stepOfField(field: string): Step {
  if (field.startsWith('admin.')) return 'admin';
  if (field.startsWith('preferences.') || field === 'shop.timezone')
    return 'preferences';
  if (field.startsWith('printer.')) return 'printer';
  return 'shop';
}

export function SetupWizard({
  language,
  appearance,
  systemNumberLocale,
  onPreview,
  onCompleted,
}: SetupWizardProps) {
  const { numberOptions } = useNumberFormat();
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('shop');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    shopName: '',
    address: '',
    phoneNumber: '',
    email: '',
    invoiceFooter: '',
    username: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    language,
    appearance,
    numberFormat: 'ID',
    timezone: 'Asia/Jakarta',
    thermalPrinterName: '',
    a4PrinterName: '',
    thermalPaperWidthMm: '58',
  });

  const index = STEPS.indexOf(step);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const printerConfigured =
    draft.thermalPrinterName.trim() !== '' || draft.a4PrinterName.trim() !== '';

  function toInput(): SetupInput {
    return {
      shop: {
        name: draft.shopName,
        address: draft.address,
        phoneNumber: draft.phoneNumber,
        email: draft.email,
        invoiceFooter: draft.invoiceFooter,
        timezone: draft.timezone,
      },
      admin: {
        username: draft.username,
        displayName: draft.displayName,
        password: draft.password,
      },
      preferences: {
        language: draft.language,
        appearance: draft.appearance,
        numberFormat: draft.numberFormat,
      },
      // Skipped (or left blank) printer setup stores nothing.
      ...(printerConfigured
        ? {
            printer: {
              thermalPrinterName: draft.thermalPrinterName,
              a4PrinterName: draft.a4PrinterName,
              thermalPaperWidthMm:
                draft.thermalPaperWidthMm === '80'
                  ? (80 as const)
                  : (58 as const),
            },
          }
        : {}),
    };
  }

  /** Validates the current step; returns true when it may advance. */
  function validateStep(): boolean {
    let found: Record<string, string> = {};
    if (step === 'shop') {
      const parsed = shopStepSchema.safeParse({
        name: draft.shopName,
        address: draft.address,
        phoneNumber: draft.phoneNumber,
        email: draft.email,
        invoiceFooter: draft.invoiceFooter,
      });
      if (!parsed.success) found = flatten('shop', parsed.error.issues);
    } else if (step === 'admin') {
      const parsed = adminStepSchema.safeParse({
        username: draft.username,
        displayName: draft.displayName,
        password: draft.password,
      });
      if (!parsed.success) found = flatten('admin', parsed.error.issues);
      if (
        !found['admin.password'] &&
        draft.password !== draft.confirmPassword
      ) {
        found['admin.confirmPassword'] = 'validation.passwordMismatch';
      }
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  function goTo(next: Step) {
    setErrors({});
    setFormError(null);
    setStep(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (step !== 'finish') {
      if (validateStep()) goTo(STEPS[index + 1] ?? 'finish');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await window.bengkelin.settings.completeSetup(toInput());
      if (result.ok) {
        onCompleted(result.value);
        return;
      }
      if (result.error.code === 'SETUP_ALREADY_COMPLETED') {
        // Another window/run finished setup: continue to the login screen.
        const current = await window.bengkelin.settings.getPublic();
        if (current.ok) {
          onCompleted(current.value);
          return;
        }
      }
      const fields = result.error.fieldErrors ?? {};
      const first = Object.keys(fields)[0];
      setErrors(fields);
      setFormError(errorMessage(t, result.error));
      if (first) setStep(stepOfField(first));
    } catch {
      setFormError(t('errors.INTERNAL_ERROR'));
    } finally {
      // Never leave the wizard stuck busy, even when the IPC call rejects.
      setBusy(false);
    }
  }

  function skipPrinter() {
    setDraft((current) => ({
      ...current,
      thermalPrinterName: '',
      a4PrinterName: '',
    }));
    goTo('finish');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <form onSubmit={submit} noValidate>
          <CardHeader>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wrench aria-hidden="true" className="size-4 text-primary" />
              <span>{t('common.appName')}</span>
              <span aria-hidden="true">/</span>
              <span>
                {t('setup.progress', {
                  ...numberOptions,
                  current: index + 1,
                  total: STEPS.length,
                })}
              </span>
            </div>
            <ol
              className="flex gap-1"
              aria-label={t('setup.progress', {
                ...numberOptions,
                current: index + 1,
                total: STEPS.length,
              })}
            >
              {STEPS.map((name, i) => (
                <li
                  key={name}
                  aria-current={i === index ? 'step' : undefined}
                  className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-primary' : 'bg-muted'}`}
                >
                  <span className="sr-only">{t(`setup.steps.${name}`)}</span>
                </li>
              ))}
            </ol>
            <CardTitle>{t(`setup.${step}.title`)}</CardTitle>
            <CardDescription>{t(`setup.${step}.description`)}</CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {formError ? <Alert>{formError}</Alert> : null}

            {step === 'shop' ? (
              <>
                <FormField
                  label={t('setup.shop.name')}
                  error={errors['shop.name']}
                >
                  <Input
                    autoFocus
                    autoComplete="off"
                    value={draft.shopName}
                    onChange={(e) => set('shopName', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.shop.address')}
                  error={errors['shop.address']}
                >
                  <Input
                    autoComplete="off"
                    value={draft.address}
                    onChange={(e) => set('address', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={`${t('setup.shop.phone')} (${t('common.optional')})`}
                  error={errors['shop.phoneNumber']}
                >
                  <Input
                    type="tel"
                    autoComplete="off"
                    value={draft.phoneNumber}
                    onChange={(e) => set('phoneNumber', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={`${t('setup.shop.email')} (${t('common.optional')})`}
                  error={errors['shop.email']}
                >
                  <Input
                    type="email"
                    autoComplete="off"
                    value={draft.email}
                    onChange={(e) => set('email', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={`${t('setup.shop.footer')} (${t('common.optional')})`}
                  error={errors['shop.invoiceFooter']}
                >
                  <Input
                    autoComplete="off"
                    value={draft.invoiceFooter}
                    onChange={(e) => set('invoiceFooter', e.target.value)}
                  />
                </FormField>
              </>
            ) : null}

            {step === 'admin' ? (
              <>
                <FormField
                  label={t('setup.admin.username')}
                  error={errors['admin.username']}
                >
                  <Input
                    autoFocus
                    autoComplete="username"
                    value={draft.username}
                    onChange={(e) => set('username', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.admin.displayName')}
                  error={errors['admin.displayName']}
                >
                  <Input
                    autoComplete="name"
                    value={draft.displayName}
                    onChange={(e) => set('displayName', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.admin.password')}
                  error={errors['admin.password']}
                  hint={t('setup.admin.passwordHint')}
                >
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={draft.password}
                    onChange={(e) => set('password', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.admin.confirmPassword')}
                  error={errors['admin.confirmPassword']}
                >
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={draft.confirmPassword}
                    onChange={(e) => set('confirmPassword', e.target.value)}
                  />
                </FormField>
              </>
            ) : null}

            {step === 'preferences' ? (
              <>
                <NumberFormatPicker
                  value={draft.numberFormat}
                  systemLocale={systemNumberLocale}
                  onChange={(format) => {
                    set('numberFormat', format);
                    onPreview({
                      language: draft.language,
                      appearance: draft.appearance,
                      numberFormat: format,
                    });
                  }}
                />
                <FormField
                  label={t('setup.preferences.language')}
                  error={errors['preferences.language']}
                >
                  <Select
                    autoFocus
                    value={draft.language}
                    onChange={(e) => {
                      const next = e.target.value as Language;
                      set('language', next);
                      onPreview({
                        language: next,
                        appearance: draft.appearance,
                        numberFormat: draft.numberFormat,
                      });
                    }}
                  >
                    {LANGUAGES.map((code) => (
                      <option key={code} value={code}>
                        {t(`setup.preferences.languages.${code}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={t('setup.preferences.appearance')}
                  error={errors['preferences.appearance']}
                >
                  <Select
                    value={draft.appearance}
                    onChange={(e) => {
                      const next = e.target.value as Appearance;
                      set('appearance', next);
                      onPreview({
                        language: draft.language,
                        appearance: next,
                        numberFormat: draft.numberFormat,
                      });
                    }}
                  >
                    {APPEARANCES.map((code) => (
                      <option key={code} value={code}>
                        {t(`setup.preferences.appearances.${code}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={t('setup.preferences.timezone')}
                  error={errors['shop.timezone']}
                >
                  <Select
                    value={draft.timezone}
                    onChange={(e) => set('timezone', e.target.value)}
                  >
                    {TIMEZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {t(`setup.preferences.timezones.${zone}`)}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </>
            ) : null}

            {step === 'printer' ? (
              <>
                <FormField
                  label={t('setup.printer.thermal')}
                  error={errors['printer.thermalPrinterName']}
                >
                  <Input
                    autoFocus
                    autoComplete="off"
                    value={draft.thermalPrinterName}
                    onChange={(e) => set('thermalPrinterName', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.printer.a4')}
                  error={errors['printer.a4PrinterName']}
                >
                  <Input
                    autoComplete="off"
                    value={draft.a4PrinterName}
                    onChange={(e) => set('a4PrinterName', e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('setup.printer.width')}
                  error={errors['printer.thermalPaperWidthMm']}
                >
                  <Select
                    value={draft.thermalPaperWidthMm}
                    onChange={(e) =>
                      set(
                        'thermalPaperWidthMm',
                        e.target.value === '80' ? '80' : '58',
                      )
                    }
                  >
                    <option value="58">{t('setup.printer.width58')}</option>
                    <option value="80">{t('setup.printer.width80')}</option>
                  </Select>
                </FormField>
              </>
            ) : null}

            {step === 'finish' ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">
                  {t('shell.preferences.numberFormat')}
                </dt>
                <dd>
                  {t(`shell.preferences.numberFormats.${draft.numberFormat}`)}
                </dd>
                <dt className="text-muted-foreground">
                  {t('setup.finish.summaryShop')}
                </dt>
                <dd data-testid="summary-shop">{draft.shopName}</dd>
                <dt className="text-muted-foreground">
                  {t('setup.finish.summaryAdmin')}
                </dt>
                <dd>
                  {draft.displayName} ({draft.username})
                </dd>
                <dt className="text-muted-foreground">
                  {t('setup.finish.summaryPrinter')}
                </dt>
                <dd>
                  {printerConfigured
                    ? [draft.thermalPrinterName, draft.a4PrinterName]
                        .filter(Boolean)
                        .join(', ')
                    : t('setup.finish.printerSkipped')}
                </dd>
              </dl>
            ) : null}
          </CardContent>

          <CardFooter className="justify-between">
            <div>
              {index > 0 ? (
                <Button
                  variant="ghost"
                  onClick={() => goTo(STEPS[index - 1] as Step)}
                  disabled={busy}
                >
                  <ChevronLeft aria-hidden="true" />
                  {t('common.back')}
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {step === 'printer' ? (
                <Button variant="outline" onClick={skipPrinter}>
                  {t('common.skip')}
                </Button>
              ) : null}
              {step === 'finish' ? (
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  {busy ? t('setup.finish.starting') : t('setup.finish.start')}
                </Button>
              ) : (
                <Button type="submit">
                  {t('common.next')}
                  <ChevronRight aria-hidden="true" />
                </Button>
              )}
            </div>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
