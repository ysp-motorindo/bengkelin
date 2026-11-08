import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from '@/main/database/connection';
import { withWriteTransaction } from '@/main/database/connection';
import { appendAudit } from '@/main/database/audit';
import { requireSession } from '@/main/features/auth/authorize';
import type { Session } from '@/main/features/auth/sessions';
import type { PrintingService } from '@/main/features/printing/service';
import type { FileDialogs, PrintDriver } from '@/main/features/printing/driver';
import { html } from '@/main/features/printing/escape';
import {
  documentShell,
  money,
} from '@/main/features/printing/templates/shared';
import { pageInfoFor } from '@/main/features/printing/templates';
import { SettingsRepository } from '@/main/features/settings/repository';
import { resolveNumberLocale } from '@/shared/number-format';
import { formatBpsAsPercentage } from '@/shared/percentage';
import {
  localDate as formatDisplayDate,
  localDateTime,
} from '@/main/features/printing/templates/shared';
import { localDateTime as localInstant } from '@/main/features/printing/model';
import type {
  PurchasePrintInput,
  PrintOutcomeDto,
  PrintPreviewDto,
} from '@/shared/contracts';
import { DomainError } from '@/shared/primitives';
import type { Clock } from '@/shared/time';
import { purchaseView } from './view';
import { PurchaseRepository } from './repository';
import { PURCHASE_LABELS } from './labels';
export class PurchasePrintingService {
  constructor(
    private readonly deps: {
      db: AppDatabase;
      clock: Clock;
      printing: PrintingService;
      driver: PrintDriver;
      dialogs: FileDialogs;
      systemNumberLocale: string;
    },
  ) {}
  private render(actor: Session, input: PurchasePrintInput) {
    return this.deps.db.transaction(() => {
      const { db, clock } = this.deps;
      const row = new PurchaseRepository(db).find(input.purchaseId);
      if (row.status === 'DRAFT')
        throw new DomainError('PURCHASE_NOT_FINALIZED');
      const p = purchaseView(db, clock, actor, input.purchaseId);
      const settings = new SettingsRepository(db);
      const language = settings.language();
      const labels = PURCHASE_LABELS[language];
      const timezone = settings.getShop().timezone;
      const locale = resolveNumberLocale(
        actor.numberFormat,
        this.deps.systemNumberLocale,
      );
      const receipt =
        input.documentType === 'RECEIPT'
          ? p.receipts.find((r) => r.id === input.documentId)
          : null;
      const credit =
        input.documentType === 'CREDIT'
          ? p.credits.find((c) => c.id === input.documentId)
          : null;
      if (
        (input.documentType === 'BILL' && input.documentId !== p.id) ||
        (input.documentType === 'RECEIPT' && !receipt) ||
        (input.documentType === 'CREDIT' && !credit)
      )
        throw new DomainError('PURCHASE_NOT_FOUND');
      const format = input.documentType === 'BILL' ? input.format : 'A4';
      const isReprint =
        db
          .prepare(
            "SELECT 1 FROM purchase_print_jobs WHERE document_type=? AND document_id=? AND action='PRINT' AND outcome='PRINTED' LIMIT 1",
          )
          .get(input.documentType, input.documentId) !== undefined;
      const number =
        receipt?.documentNumber ?? credit?.documentNumber ?? p.documentNumber;
      const title =
        input.documentType === 'BILL'
          ? labels.bill
          : receipt
            ? labels.receipt
            : labels.credit;
      const date = receipt?.createdAt ?? credit?.createdAt ?? p.finalizedAt;
      const lines = receipt
        ? receipt.lines.map((l) => ({
            title: p.lines.find((i) => i.id === l.purchaseLineId)!.title,
            quantity: l.quantity,
            unit: p.lines.find((i) => i.id === l.purchaseLineId)!.unitLabel,
            price: null,
            amount: null,
          }))
        : credit
          ? credit.lines.map((l) => ({
              title: p.lines.find((i) => i.id === l.purchaseLineId)!.title,
              quantity: l.quantity,
              unit: p.lines.find((i) => i.id === l.purchaseLineId)!.unitLabel,
              price: null,
              amount: l.amount,
            }))
          : p.lines.map((l) => ({
              title: l.title,
              quantity: l.quantity,
              unit: l.unitLabel,
              price: l.unitPrice,
              amount: l.amount,
            }));
      const total = credit?.amount ?? (receipt ? null : p.totals!.amount);
      const lineContent =
        format === 'A4'
          ? html`<table><thead><tr><th>${labels.item}</th><th>${labels.quantity}</th>${receipt ? html`` : html`<th>${labels.unitPrice}</th><th>${labels.amount}</th>`}</tr></thead><tbody>${lines.map((l, i) => html`<tr><td>${l.title}<small>${l.unit}</small></td><td class="num">${l.quantity}</td>${receipt ? html`` : html`<td class="num">${l.price === null ? '—' : money(`lines.${i}.unitPrice`, l.price, locale)}</td><td class="num">${money(`lines.${i}.amount`, l.amount!, locale)}</td>`}</tr>`)}</tbody></table>`
          : html`<section class="thermal-lines">${lines.map((l, i) => html`<article class="thermal-line"><p><strong>${l.title}</strong></p><p>${l.quantity} ${l.unit}${l.price === null ? html`` : html` × ${money(`lines.${i}.unitPrice`, l.price, locale)}`}</p>${l.amount === null ? html`` : html`<p class="num">${money(`lines.${i}.amount`, l.amount, locale)}</p>`}</article>`)}</section>`;
      const body = html`<main class="sheet"><header><h1>${p.shop.name}</h1><p>${p.shop.address}</p><p>${p.shop.phoneNumber}</p><h2>${title}</h2><p>${number}</p>${isReprint ? html`<strong>${labels.reprint}</strong>` : html``}${p.status === 'VOID' ? html`<strong class="mark">${labels.void}</strong>` : html``}${receipt?.reversedAt ? html`<strong class="mark">${labels.reversed}</strong>` : html``}</header>
 <dl><dt>${labels.supplier}</dt><dd>${p.supplier!.name}<br/>${p.supplier!.address}<br/>${p.supplier!.phoneNumber}</dd>${input.documentType === 'BILL' ? html`<dt>${labels.billDate}</dt><dd>${formatDisplayDate(p.billDate)}</dd>` : html``}<dt>${labels.recordedAt}</dt><dd>${localDateTime(localInstant(date, timezone))}</dd><dt>${labels.supplierReference}</dt><dd>${p.supplierBillReference}</dd>${receipt ? html`<dt>${labels.location}</dt><dd>${receipt.locationLabel}</dd>` : html``}</dl>
 ${lineContent}
 ${total !== null ? html`<dl class="totals">${credit ? html`<dt>${labels.taxSubtotal}</dt><dd>${money('taxSubtotal', credit.taxSubtotal, locale)}</dd><dt>${labels.vat}</dt><dd>${money('vatAmount', credit.vatAmount, locale)}</dd>` : html`<dt>${labels.discount}</dt><dd>${money('discountAmount', p.totals!.discountAmount, locale)}</dd><dt>${labels.taxSubtotal}</dt><dd>${money('taxSubtotal', p.totals!.taxSubtotal, locale)}</dd><dt>${labels.vat} (${formatBpsAsPercentage(p.vatRateBps)}%)</dt><dd>${money('vatAmount', p.totals!.vatAmount, locale)}</dd>`}<dt><strong>${labels.total}</strong></dt><dd><strong>${money('amount', total, locale)}</strong></dd>${input.documentType === 'BILL' ? html`<dt>${labels.credits}</dt><dd>${money('creditedAmount', p.creditedAmount, locale)}</dd><dt>${labels.adjustedTotal}</dt><dd>${money('netAmount', p.netAmount, locale)}</dd><dt>${labels.payments}</dt><dd>${money('paidAmount', p.paidAmount, locale)}</dd><dt>${labels.refunds}</dt><dd>${money('refundedAmount', p.refundedAmount, locale)}</dd><dt>${labels.outstanding}</dt><dd>${money('outstandingAmount', p.outstandingAmount, locale)}</dd><dt>${labels.refundDue}</dt><dd>${money('refundDue', p.refundDue, locale)}</dd><dt>${labels.dueDate}</dt><dd>${formatDisplayDate(p.dueDate)}</dd>` : html``}</dl>` : html``}
 <p>${credit?.reason ?? receipt?.note ?? p.note}</p>${p.void ? html`<p>${labels.reason}: ${p.void.reason}</p>` : html``}</main>`;
      const width =
        format === 'A4' ? '190mm' : format === 'THERMAL_58' ? '48mm' : '72mm';
      const css = `@page{size:${format === 'A4' ? 'A4' : format === 'THERMAL_58' ? '58mm auto' : '80mm auto'};margin:${format === 'A4' ? '10mm' : '3mm'}}body{font-family:Arial,sans-serif;font-size:${format === 'A4' ? '11pt' : '8pt'}}.sheet{width:${width};max-width:100%;margin:auto;font-family:Arial,sans-serif;font-size:${format === 'A4' ? '11pt' : '8pt'}}header{border-bottom:1px solid;padding-bottom:3mm;margin-bottom:3mm}h1{font-size:1.4em}h2{font-size:1.2em;margin-top:3mm!important}p{margin:1mm 0!important;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1fr;gap:2mm;margin:4mm 0}dd{margin:0;overflow-wrap:anywhere}.totals dd{text-align:right}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border-bottom:1px solid #bbb;padding:2mm 1mm;overflow-wrap:anywhere}th{text-align:left}th:first-child{width:38%}small{display:block;color:#555}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.thermal-line{padding:2mm 0;border-bottom:1px solid #bbb;break-inside:avoid}.thermal-line .num{margin-top:1mm}.thermal-lines{width:100%;min-width:0}.totals{grid-template-columns:minmax(0,1fr) auto}.totals dd{white-space:nowrap}.mark{display:block;border:2px solid;padding:2mm;margin:2mm 0}thead{display:table-header-group}tr{break-inside:avoid}`;
      return {
        html: documentShell({
          language,
          title: title + ' ' + number,
          css,
          body,
        }),
        format,
        pageInfo: pageInfoFor(format),
        isReprint,
        number,
      };
    })();
  }
  preview(
    session: Session | undefined,
    input: PurchasePrintInput,
  ): PrintPreviewDto {
    const actor = requireSession(session);
    const r = this.render(actor, input);
    return { html: r.html, format: r.format, pageInfo: r.pageInfo };
  }
  async print(
    session: Session | undefined,
    input: PurchasePrintInput,
  ): Promise<PrintOutcomeDto> {
    const actor = requireSession(session);
    const r = this.render(actor, input);
    const outcome = await this.deps.printing.sendDocument(r.html, r.format);
    this.record(actor, input, r.format, r.isReprint, 'PRINT', outcome);
    return { ...outcome, format: r.format, isReprint: r.isReprint };
  }
  async exportPdf(
    session: Session | undefined,
    input: PurchasePrintInput,
  ): Promise<PrintOutcomeDto> {
    const actor = requireSession(session);
    const r = this.render(actor, { ...input, format: 'A4' });
    const target = await this.deps.dialogs.choosePdfDestination(
      r.number + '.pdf',
    );
    let outcome: Pick<PrintOutcomeDto, 'outcome' | 'code'> = {
      outcome: 'CANCELLED',
    };
    if (target !== null) {
      try {
        const bytes = await this.deps.driver.printToPdf(r.html, 'A4');
        await writeFile(target, bytes);
        outcome = { outcome: 'PRINTED' };
      } catch {
        outcome = { outcome: 'FAILED', code: 'PDF_FAILED' };
      }
    }
    this.record(actor, input, 'A4', r.isReprint, 'PDF_EXPORT', outcome);
    return {
      ...outcome,
      format: 'A4',
      isReprint: r.isReprint,
      ...(target !== null && outcome.outcome === 'PRINTED'
        ? { fileName: path.basename(target) }
        : {}),
    };
  }
  private record(
    actor: Session,
    input: PurchasePrintInput,
    format: string,
    reprint: boolean,
    action: string,
    outcome: Pick<PrintOutcomeDto, 'outcome' | 'code'>,
  ) {
    withWriteTransaction(this.deps.db, () => {
      this.deps.db
        .prepare(
          'INSERT INTO purchase_print_jobs(purchase_id,document_type,document_id,format,action,outcome,error_code,is_reprint,requested_at,requested_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.purchaseId,
          input.documentType,
          input.documentId,
          format,
          action,
          outcome.outcome,
          outcome.code ?? null,
          reprint ? 1 : 0,
          this.deps.clock.now(),
          actor.cashierId,
        );
      appendAudit(this.deps.db, this.deps.clock, {
        cashierId: actor.cashierId,
        action: 'PURCHASE_' + action,
        entityType: 'purchase',
        entityId: input.purchaseId,
        metadata: {
          documentType: input.documentType,
          documentId: input.documentId,
          outcome: outcome.outcome,
        },
      });
    });
  }
}
