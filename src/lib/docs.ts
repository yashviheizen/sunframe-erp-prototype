// Builders that turn records into printable document specs (used for preview + PDF).
import type { DB, Quote, SalesOrder, SupplierPO, Lead, PriceLine } from './types';
import { fmtDate, quoteTotals, lineTotal, addDays, linesSubtotal } from './format';
import { buildPdf, pdfMoney, companyInfo, type DocSpec } from './pdf';
import { getDB } from '../store';
import { storeFile } from './files';

const leadParty = (l: Lead, address?: string) => [l.company, `Attn: ${l.contact}`, l.project ? `Project: ${l.project}` : '', address ?? '', [l.email, l.phone].filter(Boolean).join(' · ')];
const priceRows = (ls: PriceLine[]) => ls.map((l, i) => [i + 1, l.description, l.qty.toLocaleString('en-IN'), l.unit, pdfMoney(+l.rate || 0), pdfMoney(lineTotal(l))]);

export function quoteSpec(q: Quote, lead: Lead): DocSpec {
  const t = quoteTotals(q);
  return {
    company: companyInfo(getDB().settings),
    title: 'QUOTATION', ref: `${q.ref}${q.version > 1 ? ' (rev ' + q.version + ')' : ''}`,
    meta: [['Date', fmtDate(q.date)], ['Valid until', fmtDate(addDays(q.date, q.validDays || 0))], ['Status', q.status]],
    partyLabel: 'Prepared for', partyLines: leadParty(lead),
    columns: ['#', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'], rows: priceRows(q.lines),
    totals: [
      ['Subtotal', pdfMoney(t.subtotal)],
      ...(t.discount ? [[`Discount (${q.discountPct}%)`, '- ' + pdfMoney(t.discount)] as [string, string]] : []),
      ...(q.freight ? [['Freight', pdfMoney(+q.freight)] as [string, string]] : []),
      [`GST (${q.gstPct}%)`, pdfMoney(t.gst)],
      ['Grand total', pdfMoney(t.total), true],
    ],
    sections: [
      { heading: 'Payment terms', body: q.paymentTerms },
      { heading: 'Delivery terms', body: q.deliveryTerms },
      { heading: 'Terms and conditions', body: q.terms },
    ],
  };
}

export function soSpec(so: Pick<SalesOrder, 'lines' | 'discountPct' | 'freight' | 'gstPct' | 'date' | 'expectedDelivery' | 'paymentTerms' | 'deliveryTerms' | 'deliveryAddress' | 'terms'> & { ref: string }, lead: Lead, clientPoNo: string, clientPoDate: string): DocSpec {
  const t = quoteTotals(so);
  return {
    company: companyInfo(getDB().settings),
    title: 'SALES ORDER', ref: so.ref,
    meta: [['SO date', fmtDate(so.date)], ['Client PO', clientPoNo], ['Client PO date', fmtDate(clientPoDate)], ['Expected delivery', fmtDate(so.expectedDelivery)]],
    partyLabel: 'Customer', partyLines: leadParty(lead),
    columns: ['#', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'], rows: priceRows(so.lines),
    totals: [
      ['Subtotal', pdfMoney(t.subtotal)],
      ...(t.discount ? [[`Discount (${so.discountPct}%)`, '- ' + pdfMoney(t.discount)] as [string, string]] : []),
      ...(so.freight ? [['Freight', pdfMoney(+so.freight)] as [string, string]] : []),
      [`GST (${so.gstPct}%)`, pdfMoney(t.gst)],
      ['Order total', pdfMoney(t.total), true],
    ],
    sections: [
      { heading: 'Delivery address', body: so.deliveryAddress },
      { heading: 'Payment terms', body: so.paymentTerms },
      { heading: 'Delivery terms', body: so.deliveryTerms },
      { heading: 'Terms and conditions', body: so.terms },
    ],
  };
}

export function poSpec(db: DB, po: SupplierPO): DocSpec {
  const sup = db.suppliers.find(s => s.id === po.supplierId);
  const pr = db.prs.find(p => p.id === po.prId);
  const rows = po.lines.map((l, i) => {
    const m = db.materials.find(x => x.id === l.materialId);
    return [i + 1, `${m?.code ?? ''} · ${m?.name ?? ''}`, l.qty.toLocaleString('en-IN'), m?.unit ?? '', pdfMoney(l.rate), pdfMoney(l.qty * l.rate)];
  });
  const total = po.lines.reduce((a, l) => a + l.qty * l.rate, 0);
  return {
    company: companyInfo(db.settings),
    title: 'PURCHASE ORDER', ref: po.ref,
    meta: [['PO date', fmtDate(po.date)], ['Against PR', pr?.ref ?? '—'], ['Expected delivery', fmtDate(po.expectedDelivery)], ['Payment terms', po.paymentTermsDays ? `${po.paymentTermsDays} days` : '—']],
    partyLabel: 'Supplier', partyLines: sup ? [sup.name, sup.contact ? `Attn: ${sup.contact}` : '', sup.gst ? `GSTIN: ${sup.gst}` : '', [sup.email, sup.phone].filter(Boolean).join(' · ')] : ['—'],
    columns: ['#', 'Material', 'Qty', 'Unit', 'Rate', 'Amount'], rows,
    totals: [['PO total (excl. GST)', pdfMoney(total), true]],
    sections: [{ heading: 'Notes', body: db.settings?.poNotes ?? '' }],
  };
}

export async function specToStoredPdf(spec: DocSpec, name: string) {
  return storeFile(buildPdf(spec), name);
}
