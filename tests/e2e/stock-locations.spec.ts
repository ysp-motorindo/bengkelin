import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  copyFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { tr } from './helpers/i18n';

const t = (key: string) => tr('id', key);
const exact = { exact: true };

test('stock location setup, two-location invoice, frozen documents, void and export', async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(path.join(tmpdir(), 'stock-location-acceptance-'));
  const csv = path.join(dir, 'import.csv');
  const exported = path.join(dir, 'export.csv');
  const output = path.resolve(
    'output/stock-locations',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  await mkdir(output, { recursive: true });
  const skill = process.env.STOCK_LOCATION_EVIDENCE_SKILL;
  const bi = (en: string, id: string) => ({ en, id });
  const evidence = skill
    ? await (
        await import(skill)
      ).createEvidence(output, {
        title: bi('Stock locations', 'Lokasi stok'),
        fixture: false,
        environment: {
          startup:
            'npm run build:app; npx playwright test tests/e2e/stock-locations.spec.ts',
          baseURL: 'Electron local renderer',
          authentication: bi(
            'Temporary demo admin through the supported session API.',
            'Admin demo sementara melalui API sesi aplikasi.',
          ),
          roles: ['ADMIN'],
          locales: ['id'],
          pages: [
            'Reference Data',
            'Catalog import/export',
            'Inventory',
            'Invoice workspace',
            'Issued documents',
          ],
        },
      })
    : null;
  const previous = process.env.STOCK_LOCATION_RETEST_RUN;
  if (evidence && previous) {
    const prior = JSON.parse(
      await readFile(path.join(previous, 'run.json'), 'utf8'),
    );
    for (const failed of prior.steps.filter(
      (s: { status: string }) => s.status === 'Fail',
    )) {
      await copyFile(
        path.join(previous, failed.screenshot),
        path.join(output, failed.screenshot),
      );
      evidence.run.steps.push({
        ...failed,
        id: failed.id.startsWith('prior-') ? failed.id : `prior-${failed.id}`,
        userGuide: false,
      });
    }
    await evidence.save();
  }
  const launched = await launchApp({
    dataDir: path.join(dir, 'profile'),
    env: {
      BENGKELIN_TEST_OPEN_CSV_PATH: csv,
      BENGKELIN_TEST_SAVE_CSV_PATH: exported,
    },
  });
  const { page } = launched;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let sequence = 0;
  async function step(
    id: string,
    en: string,
    indonesian: string,
    action: () => Promise<void>,
  ) {
    if (evidence) {
      const result = await evidence.step(
        page,
        {
          id,
          caseId: 'STOCK-LOCATION',
          role: 'ADMIN',
          locale: 'id',
          title: bi(en, indonesian),
          expected: bi(en, indonesian),
          actual: bi(en, indonesian),
          ...(evidence.run.steps.some(
            (s: { id: string }) => s.id === `prior-${id}`,
          )
            ? { retestOf: `prior-${id}` }
            : {}),
          userGuide: true,
        },
        action,
      );
      expect(result.status, id).toBe('Pass');
    } else {
      await action();
      await page.screenshot({
        path: path.join(output, `${++sequence}-${id}.png`),
      });
    }
  }
  try {
    await page.setViewportSize({ width: 1800, height: 1040 });
    await page.evaluate(async () => {
      const b = window.bengkelin;
      const setup = await b.settings.completeSetup({
        shop: {
          name: 'Demo Workshop',
          address: 'Demo address',
          timezone: 'Asia/Jakarta',
        },
        admin: {
          username: 'admin',
          displayName: 'Demo Admin',
          password: 'demo-acceptance-password',
        },
        preferences: { language: 'id', appearance: 'LIGHT' },
      });
      if (!setup.ok) throw new Error(setup.error.code);
      const login = await b.auth.login({
        username: 'admin',
        password: 'demo-acceptance-password',
      });
      if (!login.ok) throw new Error(login.error.code);
    });
    await page.reload();
    await step(
      'fresh-install',
      'Fresh installations require location setup before an invoice can be created.',
      'Instalasi baru memerlukan lokasi stok sebelum membuat faktur.',
      async () => {
        await expect(
          page.getByText(t('errors.STOCK_LOCATION_REQUIRED')),
        ).toBeVisible();
      },
    );
    const nav = page.getByRole('navigation');
    await nav
      .getByRole('button', { name: t('shell.nav.references'), ...exact })
      .click();
    await page.getByRole('tab', { name: 'Lokasi stok', ...exact }).click();
    await writeFile(
      csv,
      'code,name,is_active,is_default\n01,Gudang,true,true\nB,Cabang,true,false\n',
    );
    await page.getByRole('button', { name: 'Impor CSV', ...exact }).click();
    await page.getByRole('button', { name: 'Pilih CSV...', ...exact }).click();
    await step(
      'master-preview',
      'Review two stock locations before importing the master CSV.',
      'Periksa dua lokasi stok sebelum mengimpor CSV master.',
      async () => {
        await expect(page.getByRole('dialog')).toContainText('Gudang');
        await expect(page.getByRole('dialog')).toContainText('Cabang');
      },
    );
    await page
      .getByRole('button', {
        name: t('catalogTransfer.preview.commit'),
        ...exact,
      })
      .click();
    await expect(page.getByRole('dialog')).toContainText('2');
    await page.keyboard.press('Escape');
    await step(
      'master-imported',
      'Imported locations retain their exact codes and the Default flag.',
      'Lokasi impor mempertahankan kode persis dan penanda Default.',
      async () => {
        await expect(
          page.getByRole('cell', { name: 'Gudang (Default)', ...exact }),
        ).toBeVisible();
      },
    );
    await writeFile(
      csv,
      'sku,title,type,unit,price_bengkel,stock_location,opening_stock\nDEMO-OIL,Demo Oil,STOCK_ITEM,PCS,1000,01,10\n',
    );
    await nav
      .getByRole('button', { name: t('shell.nav.catalogTransfer'), ...exact })
      .click();
    await page
      .getByRole('button', { name: t('catalogTransfer.import'), ...exact })
      .click();
    await step(
      'catalog-preview',
      'Tracked catalog rows show their resolved stock location.',
      'Baris katalog terlacak menampilkan lokasi stok yang ditemukan.',
      async () => {
        await expect(page.getByTestId('import-rows')).toContainText(
          '01 · Gudang',
        );
        await expect(
          page.getByTestId('import-count-openingBalances'),
        ).toHaveText('1');
      },
    );
    await page
      .getByRole('button', {
        name: t('catalogTransfer.preview.commit'),
        ...exact,
      })
      .click();
    await expect(page.getByTestId('catalog-import-result')).toBeVisible();
    const ids = await page.evaluate(async () => {
      const b = window.bengkelin;
      const locations = await b.references.listActive({
        entity: 'stockLocation',
      });
      const catalog = await b.catalog.search({ query: 'DEMO-OIL' });
      if (!locations.ok || !catalog.ok) throw new Error('master data');
      const a = locations.value.find((l) => l.code === '01')!;
      const branch = locations.value.find((l) => l.code === 'B')!;
      const item = catalog.value.results[0]!;
      const received = await b.inventory.receive({
        requestId: crypto.randomUUID(),
        catalogItemId: item.id,
        stockLocationId: branch.id,
        quantity: 20,
      });
      const channels = await b.references.listActive({ entity: 'channel' });
      const customer = await b.customers.save({ name: 'Demo Buyer' });
      if (!received.ok || !channels.ok || !customer.ok || !customer.value.saved)
        throw new Error('setup');
      const d = await b.drafts.create({
        requestId: crypto.randomUUID(),
        channelId: channels.value.find((c) => c.code === 'BENGKEL')!.id,
        invoiceDate: '2026-09-30',
        pricingAt: '2026-09-30T03:00:00.000Z',
      });
      if (!d.ok) throw new Error(d.error.code);
      const line = await b.drafts.apply({
        requestId: crypto.randomUUID(),
        invoiceId: d.value.id,
        expectedVersion: d.value.version,
        op: {
          kind: 'addCatalogLine',
          catalogItemId: item.id,
          quantity: 2,
          unitPrice: '1000',
        },
      });
      if (!line.ok) throw new Error(line.error.code);
      const credit = await b.drafts.apply({
        requestId: crypto.randomUUID(),
        invoiceId: d.value.id,
        expectedVersion: line.value.version,
        op: {
          kind: 'updateHeader',
          changes: { customerId: customer.value.customer.id, topDays: 30 },
        },
      });
      if (!credit.ok) throw new Error(credit.error.code);
      return { a: a.id, branch: branch.id, item: item.id, draft: d.value.id };
    });
    await nav
      .getByRole('button', { name: t('shell.nav.inventory'), ...exact })
      .click();
    const inventoryLocation = page.getByRole('combobox', {
      name: 'Lokasi stok',
      ...exact,
    });
    await inventoryLocation.selectOption(ids.a);
    await step(
      'inventory-gudang',
      'Inventory shows ten units in Gudang.',
      'Persediaan menampilkan sepuluh unit di Gudang.',
      async () => {
        await expect(page.getByTestId('stock-row')).toContainText('10');
      },
    );
    await inventoryLocation.selectOption(ids.branch);
    await step(
      'inventory-branch',
      'Selecting Cabang shows its independent twenty-unit stock.',
      'Memilih Cabang menampilkan stok terpisah sebanyak dua puluh unit.',
      async () => {
        await expect(page.getByTestId('stock-row')).toContainText('20');
      },
    );
    await page.reload();
    const location = page.getByRole('combobox', {
      name: 'Lokasi stok',
      ...exact,
    });
    await step(
      'invoice-location',
      'Invoices default to Gudang and the header has three equal columns with nested proportions.',
      'Faktur memilih Gudang dan header memiliki tiga kolom sama lebar dengan proporsi bertingkat.',
      async () => {
        await expect(location).toHaveValue(ids.a);
        const grid = page.getByTestId('invoice-header-fields');
        const widths = await grid.evaluate((el) =>
          getComputedStyle(el)
            .gridTemplateColumns.split(' ')
            .map(Number.parseFloat),
        );
        expect(widths).toHaveLength(3);
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
        const top = await page
          .getByLabel(t('workspace.header.topDays'), exact)
          .boundingBox();
        const due = await page.getByTestId('header-due-date').boundingBox();
        expect(due!.width / top!.width).toBeCloseTo(2, 0);
        await expect(page.getByTestId('header-due-date')).toHaveAttribute(
          'readonly',
          '',
        );
      },
    );
    await location.focus();
    await page.keyboard.press('b');
    await page.keyboard.press('Enter');
    await location.selectOption(ids.branch);
    await step(
      'invoice-switched',
      'Changing the invoice location updates line stock while retaining prices.',
      'Mengganti lokasi faktur memperbarui stok baris dan mempertahankan harga.',
      async () => {
        await expect(location).toHaveValue(ids.branch);
        await expect
          .poll(() =>
            page.evaluate(async (id) => {
              const d = await window.bengkelin.drafts.get(id);
              return d.ok ? d.value.lines[0]?.currentStock : null;
            }, ids.draft),
          )
          .toBe(20);
      },
    );
    await page.setViewportSize({ width: 900, height: 1040 });
    await expect(page.getByTestId('invoice-header-fields')).toHaveCSS(
      'grid-template-columns',
      /[0-9.]+px/,
    );
    const smallColumns = await page
      .getByTestId('invoice-header-fields')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' '));
    expect(smallColumns).toHaveLength(1);
    await page.screenshot({
      path: path.join(output, 'small-window-900x1040.png'),
    });
    await page.setViewportSize({ width: 1800, height: 1040 });
    const issued = await page.evaluate(async (ids) => {
      const b = window.bengkelin;
      const d = await b.drafts.get(ids.draft);
      const p = await b.invoices.previewFinalize({ invoiceId: ids.draft });
      if (!d.ok || !p.ok || p.value.errors.length) throw new Error('preview');
      const result = await b.invoices.finalize({
        requestId: crypto.randomUUID(),
        invoiceId: ids.draft,
        expectedVersion: d.value.version,
        acknowledgedWarnings: p.value.warnings,
      });
      if (!result.ok) throw new Error(result.error.code);
      for (const format of ['A4', 'THERMAL_58', 'THERMAL_80'] as const) {
        const print = await b.printing.preview({
          invoiceId: result.value.id,
          format,
        });
        if (!print.ok || !print.value.html.includes('B · Cabang'))
          throw new Error('location snapshot missing from ' + format);
      }
      const renamed = await b.references.save({
        entity: 'stockLocation',
        id: ids.branch,
        label: 'Renamed branch',
        isDefault: false,
      });
      const inactive = await b.references.deactivate({
        entity: 'stockLocation',
        id: ids.branch,
      });
      if (!renamed.ok || !inactive.ok) throw new Error('rename');
      const voided = await b.invoices.void({
        requestId: crypto.randomUUID(),
        invoiceId: result.value.id,
        reason: 'Demo cancellation',
      });
      const a = await b.inventory.getStock({
        catalogItemId: ids.item,
        stockLocationId: ids.a,
      });
      const branch = await b.inventory.getStock({
        catalogItemId: ids.item,
        stockLocationId: ids.branch,
      });
      if (!voided.ok || !a.ok || !branch.ok) throw new Error('void');
      return {
        number: result.value.invoiceNumber,
        frozen: voided.value.stockLocation,
        a: a.value.quantity,
        branch: branch.value.quantity,
      };
    }, ids);
    expect(issued).toMatchObject({
      frozen: { code: 'B', label: 'Cabang' },
      a: 10,
      branch: 20,
    });
    await nav
      .getByRole('button', { name: t('shell.nav.history'), ...exact })
      .click();
    await step(
      'issued-history',
      'Voiding restores the original location even after it was renamed and deactivated.',
      'VOID mengembalikan stok ke lokasi asal setelah nama dan statusnya berubah.',
      async () => {
        await expect(page.getByText(issued.number, exact)).toBeVisible();
      },
    );
    await page
      .getByRole('button', {
        name: t('history.table.openInvoice').replace(
          '{{number}}',
          issued.number,
        ),
      })
      .click();
    await page
      .getByTestId('invoice-detail')
      .getByRole('button', { name: t('printing.actions.preview'), ...exact })
      .click();
    const printDialog = page.getByRole('dialog', {
      name: t('printing.preview.title'),
    });
    await printDialog
      .getByLabel(t('printing.preview.format'), exact)
      .selectOption('A4');
    await step(
      'printed-a4',
      'A4 documents retain the original location after rename and void.',
      'Dokumen A4 mempertahankan lokasi asal setelah penggantian nama dan VOID.',
      async () => {
        await expect(
          printDialog
            .getByTestId('print-preview-document')
            .getByText('B · Cabang', exact),
        ).toBeVisible();
      },
    );
    await step(
      'printed-a4-bottom',
      'The full A4 totals remain readable below the header.',
      'Total A4 tetap terbaca di bawah header.',
      async () => {
        await printDialog
          .getByTestId('print-preview-document')
          .locator('[data-money="amount"]')
          .scrollIntoViewIfNeeded();
      },
    );
    await printDialog
      .getByLabel(t('printing.preview.format'), exact)
      .selectOption('THERMAL_58');
    await step(
      'printed-thermal',
      'Thermal documents use the same frozen location facts.',
      'Dokumen termal memakai fakta lokasi beku yang sama.',
      async () => {
        await printDialog
          .getByTestId('print-preview-document')
          .getByText('B · Cabang', exact)
          .scrollIntoViewIfNeeded();
        await expect(
          printDialog
            .getByTestId('print-preview-document')
            .getByText('B · Cabang', exact),
        ).toBeVisible();
      },
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await nav
      .getByRole('button', { name: t('shell.nav.catalogTransfer'), ...exact })
      .click();
    await page
      .getByRole('combobox', { name: 'Lokasi stok', ...exact })
      .selectOption(ids.a);
    await page
      .getByRole('button', { name: t('catalogTransfer.export'), ...exact })
      .click();
    await step(
      'location-export',
      'Catalog export includes the selected location and leaves opening stock blank.',
      'Ekspor katalog memuat lokasi pilihan dan mengosongkan stok awal.',
      async () => {
        await expect
          .poll(async () =>
            (await readFile(exported, 'utf8')).includes('stock_location'),
          )
          .toBe(true);
        expect(await readFile(exported, 'utf8')).toContain('01');
      },
    );
    expect(errors).toEqual([]);
    if (evidence) {
      evidence.run.checklist = [
        'Access and required labels',
        'Indonesian interface text',
        'Desktop and small-window layout',
        'Master/import/inventory/invoice/print/export behavior',
        'No unresolved defects in exercised cases',
      ].map((label) => ({
        label: bi(label, label),
        status: 'Pass',
        notes: bi(
          'Assertions passed; screenshots require final visual review.',
          'Asersi lulus; screenshot menunggu pemeriksaan visual akhir.',
        ),
      }));
      await evidence.save();
    }
  } finally {
    await launched.close();
    await rm(dir, { recursive: true, force: true });
  }
});
