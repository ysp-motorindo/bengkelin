import type { Page } from '@playwright/test';
import { tr, type Lang } from './i18n';

const areas = {
  workspace: 'workspace',
  history: 'workspace',
  receivables: 'workspace',
  purchases: 'purchases',
  catalog: 'catalogStock',
  inventory: 'catalogStock',
  catalogTransfer: 'catalogStock',
  customers: 'customers',
  reports: 'reports',
  references: 'administration',
  cashiers: 'administration',
  settings: 'administration',
} as const;
export type NavigationView = keyof typeof areas;

export async function navigateTo(
  page: Page,
  view: NavigationView,
  language?: Lang,
): Promise<void> {
  const lang =
    language ??
    ((await page.locator('html').getAttribute('lang')) === 'en' ? 'en' : 'id');
  const area = areas[view];
  await page
    .getByRole('navigation', { name: tr(lang, 'shell.nav.label'), exact: true })
    .getByRole('button', { name: tr(lang, `shell.nav.${area}`), exact: true })
    .click();
  if (['purchases', 'customers', 'reports'].includes(view)) return;
  const label = tr(lang, 'shell.nav.secondaryLabel').replace(
    '{{area}}',
    tr(lang, `shell.nav.${area}`),
  );
  await page
    .getByRole('navigation', { name: label, exact: true })
    .getByRole('button', {
      name: tr(
        lang,
        view === 'workspace' ? 'shell.nav.newSale' : `shell.nav.${view}`,
      ),
      exact: true,
    })
    .click();
}
