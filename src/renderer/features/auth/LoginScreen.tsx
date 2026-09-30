import { LoaderCircle, Wrench } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
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
import { errorMessage } from '@/renderer/lib/errors';
import type { CashierSession } from '@/shared/contracts';

interface LoginScreenProps {
  shopName: string;
  onLoggedIn(session: CashierSession): void;
}

export function LoginScreen({ shopName, onLoggedIn }: LoginScreenProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const result = await window.bengkelin.auth.login({ username, password });
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onLoggedIn(result.value);
      return;
    }
    setPassword('');
    setFieldErrors(result.error.fieldErrors ?? {});
    setError(errorMessage(t, result.error));
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <form onSubmit={submit} noValidate>
          <CardHeader>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wrench aria-hidden="true" className="size-4 text-primary" />
              <span>{shopName || t('common.appName')}</span>
            </div>
            <CardTitle>{t('auth.login.title')}</CardTitle>
            <CardDescription>{t('auth.login.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error ? <Alert>{error}</Alert> : null}
            <FormField
              label={t('auth.login.username')}
              error={fieldErrors.username}
            >
              <Input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </FormField>
            <FormField
              label={t('auth.login.password')}
              error={fieldErrors.password}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : null}
              {busy ? t('auth.login.submitting') : t('auth.login.submit')}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
