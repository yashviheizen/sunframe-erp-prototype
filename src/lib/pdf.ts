import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fmtDate } from './format';

import type { Settings } from './types';

/** Company block printed on every document. Blank settings print a clearly labelled placeholder — nothing is invented. */
export interface CompanyLines { legal: string; address: string; gst: string; contact: string }
const ph = (what: string) => `[${what} not set · Settings > Company]`;
export function companyInfo(s?: Partial<Settings>): CompanyLines {
  return {
    legal: s?.legalName?.trim() || ph('Legal name'),
    address: s?.address?.trim() || ph('Address'),
    gst: s?.gstin?.trim() ? `GSTIN: ${s.gstin.trim()}` : ph('GSTIN'),
    contact: s?.contact?.trim() || ph('Contact'),
  };
}

export interface DocSpec {
  title: string;              // e.g. QUOTATION
  ref: string;
  meta: [string, string][];   // right-side key/values
  partyLabel: string;         // Bill to / Supplier
  partyLines: string[];
  columns: string[];
  rows: (string | number)[][];
  totals: [string, string, boolean?][]; // label, value, bold
  sections: { heading: string; body: string }[];
  footerNote?: string;
  company: CompanyLines;
}

// jsPDF's built-in fonts lack the ₹ glyph, so PDFs use "Rs." for currency.
export const pdfMoney = (n: number) => 'Rs. ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildPdf(spec: DocSpec): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const navy: [number, number, number] = [20, 34, 56];
  const amber: [number, number, number] = [217, 151, 34];
  const grey: [number, number, number] = [102, 112, 133];

  // Brand mark: sun + frame
  doc.setFillColor(...amber); doc.circle(M + 11, 52, 7, 'F');
  doc.setDrawColor(...navy); doc.setLineWidth(1.6);
  doc.line(M + 1, 74, M + 5, 64); doc.line(M + 5, 64, M + 17, 64); doc.line(M + 17, 64, M + 21, 74); doc.line(M, 74, M + 22, 74);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(...navy);
  doc.text('SunFrame', M + 30, 62);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...grey);
  doc.text(spec.company.legal, M + 30, 74);
  doc.text([spec.company.address, spec.company.gst, spec.company.contact].flatMap(l => doc.splitTextToSize(l, 300)), M, 92);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...navy);
  doc.text(spec.title, W - M, 58, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...grey);
  doc.text(spec.ref, W - M, 74, { align: 'right' });

  doc.setDrawColor(...amber); doc.setLineWidth(2); doc.line(M, 124, W - M, 124);

  let y = 146;
  doc.setFontSize(8); doc.setTextColor(...grey); doc.setFont('helvetica', 'bold');
  doc.text(spec.partyLabel.toUpperCase(), M, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...navy);
  const partyText = spec.partyLines.filter(Boolean).flatMap(l => doc.splitTextToSize(l, 260));
  doc.text(partyText, M, y + 14);

  let my = y;
  for (const [k, v] of spec.meta) {
    doc.setFontSize(8); doc.setTextColor(...grey); doc.text(k, W - M - 200, my);
    doc.setFontSize(10); doc.setTextColor(...navy);
    doc.text(doc.splitTextToSize(v || '—', 120), W - M, my, { align: 'right' });
    my += 15;
  }
  y = Math.max(y + 14 + partyText.length * 12, my) + 14;

  autoTable(doc, {
    startY: y, head: [spec.columns], body: spec.rows.map(r => r.map(String)), margin: { left: M, right: M },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: navy, lineColor: [228, 231, 236], lineWidth: 0.5 },
    headStyles: { fillColor: [247, 248, 250], textColor: navy, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(spec.columns.map((c, i) => [i, /qty|rate|amount|total/i.test(c) ? { halign: 'right' } : {}])),
  });
  // @ts-expect-error lastAutoTable is added by the plugin
  y = doc.lastAutoTable.finalY + 14;

  for (const [label, val, bold] of spec.totals) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(bold ? 11 : 9.5);
    doc.setTextColor(...(bold ? navy : grey)); doc.text(label, W - M - 220, y);
    doc.setTextColor(...navy); doc.text(val, W - M, y, { align: 'right' });
    y += bold ? 18 : 14;
  }
  y += 8;

  for (const s of spec.sections) {
    if (!s.body.trim()) continue;
    const lines = doc.splitTextToSize(s.body, W - 2 * M);
    if (y + 20 + lines.length * 12 > doc.internal.pageSize.getHeight() - 60) { doc.addPage(); y = 50; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...navy); doc.text(s.heading, M, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...grey); doc.text(lines, M, y + 13);
    y += 20 + lines.length * 12;
  }

  const H = doc.internal.pageSize.getHeight();
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8); doc.setTextColor(...grey);
    doc.text(spec.footerNote ?? `SunFrame · Generated ${fmtDate(new Date().toISOString())}`, M, H - 28);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 28, { align: 'right' });
  }
  return doc.output('blob');
}
