import type { BomLine, DB, Employee, Lead, Material, PriceLine, SupplierPO } from './types';
import { addDays, round3, todayISO, uid } from './format';
import { buildPdf, companyInfo, pdfMoney } from './pdf';
import { isSampleFile, tagSampleFile } from './sampleTag';
import { availableQty, currentUser, materialById, reservedQty, supplierById } from '../store';

/*
 * Demo prefill. Creation forms open with valid, editable sample values so a walkthrough needs no typing.
 *
 * Rules (see README → "Demo prefill"):
 * - Everything here is PURE: it reads the DB and returns values. Nothing is saved, reserved, approved or stored —
 *   that only happens when the user saves the form, through the existing store actions.
 * - Forms call these from useState initialisers only, so re-renders never reset edits. Editing a saved record keeps
 *   using the saved values; values from the linked record (BOM → quote → Client PO → SO …) win over generic samples.
 * - Sample people/companies are fictional; emails use the reserved .example domain.
 * - Sample attachments are real, generated PDFs marked "FICTIONAL SAMPLE" on every page and in the file name.
 */

const year = () => new Date().getFullYear();
const pick = <T,>(pool: T[], taken: (x: T) => boolean): T | undefined => pool.find(x => !taken(x));
const lower = (s?: string) => (s ?? '').trim().toLowerCase();
/** Whole units for count-like units, 3 decimals otherwise. */
const roundFor = (unit: string | undefined, n: number) => (['pcs', 'sets', 'rolls'].includes(unit ?? '') ? Math.round(n) : round3(n));

/* ------------------------------------------------------------------ CRM */

const LEAD_POOL = [
  { company: 'Bhoomi Agro Exports Pvt Ltd', contact: 'Rakesh Kulkarni', project: '800 kWp rooftop, Chakan MIDC', site: 'Plot A-14, Chakan MIDC Phase II, Pune 410501', sets: 42 },
  { company: 'Sindhudurg Seafoods Pvt Ltd', contact: 'Meghana Naik', project: '450 kWp cold-store rooftop, Kudal', site: 'MIDC Kudal, Sindhudurg 416520', sets: 24 },
  { company: 'Wardha Cotton Processors Ltd', contact: 'Amol Deshmukh', project: '1.4 MWp ground mount, Wardha', site: 'Gat 112, Nagpur road, Wardha 442001', sets: 70 },
  { company: 'Nashik Valley Wines Pvt Ltd', contact: 'Sneha Pawar', project: '600 kWp carport, Dindori', site: 'Dindori road, Nashik 422202', sets: 32 },
  { company: 'Kolhapur Foundry Works Pvt Ltd', contact: 'Sachin Jadhav', project: '1.0 MWp rooftop, Shiroli MIDC', site: 'Shiroli MIDC, Kolhapur 416122', sets: 52 },
  { company: 'Indrayani Textiles Pvt Ltd', contact: 'Pooja Bhosale', project: '700 kWp rooftop, Talegaon', site: 'Talegaon MIDC, Pune 410507', sets: 36 },
];
const slug = (company: string) => company.toLowerCase().replace(/(pvt|ltd|llp|\.)/g, '').trim().split(/\s+/).slice(0, 2).join('');

export function sampleLead(db: DB) {
  const used = new Set(db.leads.map(l => lower(l.company)));
  const p = pick(LEAD_POOL, x => used.has(lower(x.company)));
  const n = db.leads.length + 1;
  const base = p ?? { ...LEAD_POOL[n % LEAD_POOL.length], company: `${LEAD_POOL[n % LEAD_POOL.length].company.replace(/ (Pvt )?Ltd$/, '')} Unit ${n} Pvt Ltd` };
  const first = base.contact.split(' ')[0].toLowerCase();
  return {
    company: base.company, contact: base.contact, email: `${first}@${slug(base.company)}.example`,
    phone: `+91 00000 ${String(10000 + ((n * 7919) % 89999)).slice(0, 5)}`,
    project: base.project, estValue: Math.round(base.sets * 80000 * 1.18 / 100000) * 100000,
    owner: currentUser(db)?.name ?? '', nextFollowUp: addDays(todayISO(), 3),
  };
}

/* ------------------------------------------------------------------ Inventory */

const MATERIAL_POOL: Omit<Material, 'id' | 'code' | 'onHand'>[] = [
  { name: 'HR coil 2.5 mm', category: 'Steel coil', unit: 'kg' },
  { name: 'Spring washer M10 HDG', category: 'Fasteners', unit: 'pcs' },
  { name: 'Cold galvanizing spray 400 ml', category: 'Zinc / galvanizing', unit: 'pcs' },
  { name: 'Stretch film 23 micron', category: 'Packaging', unit: 'rolls' },
  { name: 'Cutting disc 355 mm', category: 'Consumables', unit: 'pcs' },
  { name: 'MS flat 50 × 6 mm', category: 'Steel coil', unit: 'kg' },
];
export function sampleMaterial(db: DB, initialName = '') {
  const used = new Set(db.materials.map(m => lower(m.name)));
  const p = pick(MATERIAL_POOL, x => used.has(lower(x.name))) ?? { ...MATERIAL_POOL[0], name: `HR coil 2.5 mm (lot ${db.materials.length + 1})` };
  const onHand = p.unit === 'kg' ? 2500 : p.unit === 'rolls' ? 40 : 1000;
  // A name typed in a material dropdown wins; keep the sample category/unit then.
  return { name: initialName || p.name, category: p.category, unit: p.unit, onHand };
}

/** A physical-count correction that never goes below what MOs have reserved. */
export function sampleAdjustment(db: DB, m: Material) {
  const res = reservedQty(db, m.id);
  const counted = m.onHand > 0 ? roundFor(m.unit, m.onHand * 0.98) : m.unit === 'kg' ? 500 : 100;
  return { onHand: Math.max(res, counted), note: `Physical stock count ${todayISO()}` };
}

/* ------------------------------------------------------------------ Sales */

/** BOM for a lead: scales the most recent per-set BOM (existing materials and units) to the lead's size. */
export function sampleBom(db: DB, lead: Lead) {
  const tpl = [...db.boms].reverse().find(b => b.outputUnit === 'sets' && b.outputQty > 0 && b.lines.every(l => materialById(db, l.materialId)));
  const est = lead.estValue ? Math.round(lead.estValue / 1.18 / 80000) : 0;
  const sets = Math.min(400, Math.max(10, est || 40));
  const lines: BomLine[] = tpl
    ? tpl.lines.map(l => ({ id: uid(), materialId: l.materialId, qty: roundFor(materialById(db, l.materialId)?.unit, (l.qty / tpl.outputQty) * sets) || 1 }))
    : db.materials.slice(0, 4).map(m => ({ id: uid(), materialId: m.id, qty: m.unit === 'kg' ? 85 * sets : 10 * sets }));
  return {
    productName: `Fixed-tilt MMS, HDG — ${(lead.project || lead.company).split(',')[0]}`,
    outputQty: sets, outputUnit: 'sets',
    lines: lines.length ? lines : [{ id: uid(), materialId: '', qty: 0 }],
    notes: tpl?.notes || 'Tilt 20°, 2P × 13 modules per table. HDG min. 80 µm.',
  };
}

/** Client PO number in the client's style, unused across existing Client POs. */
export function sampleClientPoNumber(db: DB, lead: Lead) {
  const initials = lead.company.split(/\s+/).filter(w => /^[A-Z]/.test(w) && !/^(Pvt|Ltd|LLP)$/.test(w)).map(w => w[0]).join('').slice(0, 4) || 'CL';
  const used = new Set(db.clientPOs.map(c => lower(c.poNumber)));
  let n = db.clientPOs.length + 101, no = '';
  do { no = `${initials}/PO/${year()}/${String(n++).padStart(4, '0')}`; } while (used.has(lower(no)));
  return no;
}

/* ------------------------------------------------------------------ Procurement */

const SUPPLIER_POOL = [
  { name: 'Deccan Steel Traders', category: 'Steel coil', contact: 'Vivek Sharma', gst: '27AAFCD4821K1Z3' },
  { name: 'Ganesh Fasteners & Hardware', category: 'Fasteners', contact: 'Mahesh Bhide', gst: '27AAGFG7712M1Z8' },
  { name: 'Shree Zinc Industries', category: 'Zinc / galvanizing', contact: 'Ketan Shah', gst: '24AAHCS3390P1Z1' },
  { name: 'Pune Pack Solutions', category: 'Packaging', contact: 'Rupali Gokhale', gst: '27AAJFP5506Q1Z4' },
  { name: 'Western Weld Consumables', category: 'Consumables', contact: 'Nitin Rane', gst: '27AAKFW1184R1Z6' },
];
export function sampleSupplier(db: DB) {
  const used = new Set(db.suppliers.map(s => lower(s.name)));
  const p = pick(SUPPLIER_POOL, x => used.has(lower(x.name))) ?? { ...SUPPLIER_POOL[0], name: `Deccan Steel Traders (Unit ${db.suppliers.length + 1})` };
  const first = p.contact.split(' ')[0].toLowerCase();
  return { name: p.name, gst: p.gst, contact: p.contact, phone: `+91 00000 4${String(1000 + db.suppliers.length * 37).slice(-4)}`,
    email: `${first}@${slug(p.name)}.example`, category: p.category, active: true };
}

export function sampleQuotationRef(db: DB, supplierId: string) {
  const sup = supplierById(db, supplierId);
  const initials = (sup?.name ?? 'SUP').split(/\s+/).filter(w => /^[A-Z]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'SUP';
  const used = new Set(db.supplierQuotations.map(q => lower(q.reference)));
  let n = db.supplierQuotations.length + 101, ref = '';
  do { ref = `${initials}/Q/${year()}/${n++}`; } while (used.has(lower(ref)));
  return ref;
}

/** Last approved PO rate for the material, else a typical rate for its unit. */
export function sampleRate(db: DB, materialId: string) {
  for (const po of db.supplierPOs) { const l = po.lines.find(x => x.materialId === materialId && x.rate > 0); if (l) return l.rate; }
  const u = materialById(db, materialId)?.unit;
  return u === 'kg' ? 65 : u === 'MT' ? 65000 : u === 'litres' ? 220 : u === 'rolls' ? 1450 : 25;
}
/** An active supplier for the material's category (else any active supplier). */
export function sampleSupplierFor(db: DB, materialId?: string) {
  const cat = materialById(db, materialId ?? '')?.category;
  return (db.suppliers.find(s => s.active && s.category === cat) ?? db.suppliers.find(s => s.active))?.id ?? '';
}
/** The tightest material (least available vs reserved) — what a buyer would most likely reorder. */
export function sampleShortMaterial(db: DB) {
  const mats = db.materials.filter(m => !/\[demo\]/i.test(m.name));
  return [...mats].sort((a, b) => availableQty(db, a.id) - availableQty(db, b.id))[0];
}
export const sampleReorderQty = (m?: Material) => (m?.unit === 'kg' ? 2000 : m?.unit === 'MT' ? 2 : m?.unit === 'rolls' ? 20 : 500);

export function samplePR(db: DB) {
  const m = sampleShortMaterial(db);
  const avail = m ? availableQty(db, m.id) : 0;
  const qty = roundFor(m?.unit, Math.max(sampleReorderQty(m), avail < 0 ? -avail : 0));
  return { lines: [{ id: uid(), materialId: m?.id ?? '', qty: m ? qty : 0 }], notes: m ? `Replenish ${m.name} — stock running low.` : '' };
}

/** Defaults for a new or "Details required" supplier PO. Quantities are never changed (PR quantities stay as approved). */
export function samplePO(db: DB, po?: SupplierPO) {
  if (po) {
    const supplierId = po.supplierId ?? sampleSupplierFor(db, po.lines[0]?.materialId);
    return {
      supplierId, lines: po.lines.map(l => ({ ...l, rate: l.rate > 0 ? l.rate : sampleRate(db, l.materialId) })),
      terms: (po.paymentTermsDays ?? 30) as 30 | 60 | 90, quotationIds: po.quotationIds.length ? po.quotationIds : latestQuotation(db, supplierId, po.lines[0]?.materialId),
    };
  }
  const m = sampleShortMaterial(db);
  const supplierId = sampleSupplierFor(db, m?.id);
  return {
    supplierId, lines: [{ id: uid(), materialId: m?.id ?? '', qty: m ? sampleReorderQty(m) : 0, rate: m ? sampleRate(db, m.id) : 0 }],
    terms: 30 as const, quotationIds: latestQuotation(db, supplierId, m?.id),
  };
}
export function latestQuotation(db: DB, supplierId: string, materialId?: string) {
  const cat = materialById(db, materialId ?? '')?.category;
  const q = db.supplierQuotations.filter(x => x.supplierId === supplierId).sort((a, b) => (a.category === cat ? -1 : 0) - (b.category === cat ? -1 : 0) || b.date.localeCompare(a.date))[0];
  return q ? [q.id] : [];
}

/* ------------------------------------------------------------------ Dispatch & finance */

const TRANSPORTERS = [['MH 12 KT 4821', 'Deccan Roadlines', 'Santosh Jadhav · +91 00000 10137'], ['GJ 06 BV 2290', 'Saurashtra Freight Carriers', 'Imtiyaz Pathan · +91 00000 10274']];
export function sampleDispatch(db: DB, leadId: string) {
  // Reuse the transporter last used for this client, if any.
  const prev = db.dispatches.find(d => d.leadId === leadId && d.status === 'Dispatched' && d.vehicleNo);
  const t = TRANSPORTERS[db.dispatches.length % TRANSPORTERS.length];
  const usedLr = new Set(db.dispatches.map(d => lower(d.lrNumber)));
  let n = db.dispatches.length + 1001, lr = '';
  do { lr = `LR-${year()}-${n++}`; } while (usedLr.has(lower(lr)));
  return { dispatchDate: todayISO(), vehicleNo: prev?.vehicleNo ?? t[0], transporter: prev?.transporter ?? t[1], driver: prev?.driver ?? t[2], lrNumber: lr, dueDate: addDays(todayISO(), 30) };
}

/* ------------------------------------------------------------------ People */

const EMP_POOL = [
  { name: 'Rahul Shinde', department: 'Production', designation: 'Fitter', lineShift: 'Line 1 · Shift A', salary: 22000 },
  { name: 'Swati Kale', department: 'Quality', designation: 'QC inspector', lineShift: 'Shift A', salary: 26000 },
  { name: 'Ajay Thorat', department: 'Stores', designation: 'Store assistant', lineShift: 'Shift B', salary: 20000 },
  { name: 'Nikhil Gawde', department: 'Production', designation: 'Welder', lineShift: 'Line 2 · Shift B', salary: 24000 },
  { name: 'Priya Salunkhe', department: 'Accounts', designation: 'Accounts assistant', lineShift: 'General', salary: 25000 },
];
export function sampleEmployee(db: DB) {
  const used = new Set(db.employees.map(e => lower(e.name)));
  const p = pick(EMP_POOL, x => used.has(lower(x.name))) ?? { ...EMP_POOL[0], name: `Rahul Shinde ${db.employees.length + 1}` };
  return { name: p.name, department: p.department, designation: p.designation, lineShift: p.lineShift,
    phone: `+91 00000 ${String(52000 + db.employees.length * 13).slice(-5)}`, joinedOn: todayISO(), monthlySalary: p.salary, status: 'Active' as const };
}
/** Next week, for the first active employee without leave on those dates (the store rejects overlaps). */
export function sampleLeave(db: DB, staff: Employee[]) {
  for (let start = 7; start < 60; start += 7) {
    const from = addDays(todayISO(), start), to = addDays(from, 1);
    const e = staff.find(s => !db.leaves.some(x => x.employeeId === s.id && x.status !== 'Rejected' && x.from <= to && from <= x.to));
    if (e) return { employeeId: e.id, type: 'Casual' as const, from, to, reason: 'Family function' };
  }
  return { employeeId: staff[0]?.id ?? '', type: 'Casual' as const, from: todayISO(), to: todayISO(), reason: '' };
}
/** First month from the current one that has no payroll run yet. */
export function samplePayrollMonth(db: DB) {
  const d = new Date(); d.setDate(1);
  for (let i = 0; i < 24; i++) {
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!db.payrollRuns.some(r => r.month === m)) return m;
    d.setMonth(d.getMonth() + 1);
  }
  return '';
}
const USER_POOL = [
  { name: 'Rohit Kamble', title: 'Dispatch coordinator', department: 'Stores' },
  { name: 'Shweta Mane', title: 'Sales coordinator', department: 'Sales' },
  { name: 'Ganesh Pujari', title: 'Quality engineer', department: 'Quality' },
];
export function sampleUser(db: DB) {
  const used = new Set(db.users.map(u => lower(u.name)));
  const p = pick(USER_POOL, x => used.has(lower(x.name))) ?? { ...USER_POOL[0], name: `Rohit Kamble ${db.users.length + 1}` };
  let email = `${p.name.split(' ')[0].toLowerCase()}@sunframe.example`;
  if (db.users.some(u => lower(u.email) === email)) email = `${p.name.toLowerCase().replace(/\s+/g, '.')}${db.users.length + 1}@sunframe.example`;
  return { name: p.name, title: p.title, department: p.department, email, role: 'user' as const };
}

/* ------------------------------------------------------------------ Sample attachments */

export { isSampleFile };

export type SampleKind = 'Supplier quotation' | 'Client PO' | 'GRN' | 'POD' | 'Payment proof' | 'Document';
export interface SampleFileInput {
  kind: SampleKind; ref: string; party?: string; partyLabel?: string;
  meta?: [string, string][]; rows?: (string | number)[][]; columns?: string[]; total?: string; note?: string;
}

/**
 * A real PDF, generated in memory (nothing is stored until the form is saved). Every page carries a
 * FICTIONAL SAMPLE footer and the title/file name start with SAMPLE, so it can never pass for a real document.
 */
export function sampleFile(db: DB, s: SampleFileInput): File {
  const blob = buildPdf({
    title: `SAMPLE ${s.kind.toUpperCase()}`, ref: s.ref,
    meta: [['Date', todayISO()], ...(s.meta ?? [])],
    partyLabel: s.partyLabel ?? 'Party', partyLines: [s.party ?? '—'],
    columns: s.columns ?? ['Description', 'Qty'], rows: s.rows?.length ? s.rows : [['Sample content for demonstration', '—']],
    totals: s.total ? [['Total', s.total, true]] : [],
    sections: [{ heading: 'FICTIONAL SAMPLE DOCUMENT', body: `Generated by the SunFrame ERP prototype to demonstrate the ${s.kind.toLowerCase()} step. It is not a real ${s.kind.toLowerCase()} and has no legal or commercial validity.${s.note ? ' ' + s.note : ''}` }],
    footerNote: 'FICTIONAL SAMPLE — generated for a SunFrame ERP demo · not a real document',
    company: companyInfo(db.settings),
  });
  const safe = s.ref.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const f = new File([blob], `SAMPLE-${s.kind.replace(/\s+/g, '-')}-${safe}.pdf`, { type: 'application/pdf' });
  return tagSampleFile(f);
}

/* Convenience builders for each attachment slot, filled from the linked record. */
export function sampleClientPoFile(db: DB, lead: Lead, f: { poNumber: string; lines: PriceLine[]; amount: number; paymentTerms: string }) {
  return sampleFile(db, { kind: 'Client PO', ref: f.poNumber, partyLabel: 'Issued by', party: lead.company, meta: [['Payment terms', f.paymentTerms]],
    columns: ['Description', 'Qty', 'Unit', 'Rate'], rows: f.lines.map(l => [l.description, l.qty, l.unit, pdfMoney(l.rate)]), total: pdfMoney(f.amount) });
}
export function sampleQuotationFile(db: DB, supplierId: string, reference: string, category: string) {
  const sup = supplierById(db, supplierId);
  const m = db.materials.find(x => x.category === category);
  return sampleFile(db, { kind: 'Supplier quotation', ref: reference, partyLabel: 'Supplier', party: sup?.name, meta: [['Category', category]],
    columns: ['Item', 'Unit', 'Rate'], rows: m ? [[m.name, m.unit, pdfMoney(sampleRate(db, m.id))]] : undefined });
}
export function sampleGrnFile(db: DB, po: SupplierPO, grnNo: string) {
  return sampleFile(db, { kind: 'GRN', ref: `${grnNo} · ${po.ref}`, partyLabel: 'Received from', party: supplierById(db, po.supplierId)?.name, meta: [['Against PO', po.ref]],
    columns: ['Material', 'Qty', 'Unit'], rows: po.lines.map(l => { const m = materialById(db, l.materialId); return [m?.name ?? '', l.qty, m?.unit ?? '']; }) });
}
export function samplePodFile(db: DB, d: { ref: string; leadId: string; qty: number; unit: string }) {
  return sampleFile(db, { kind: 'POD', ref: d.ref, partyLabel: 'Delivered to', party: db.leads.find(l => l.id === d.leadId)?.company,
    columns: ['Item', 'Qty', 'Unit'], rows: [['Finished goods as per dispatch', d.qty, d.unit]], note: 'Received in good condition (sample).' });
}
export function sampleProofFile(db: DB, ref: string, party: string, amount: number, reference: string) {
  return sampleFile(db, { kind: 'Payment proof', ref, partyLabel: 'Party', party, meta: [['UTR / reference', reference]],
    columns: ['Description', 'Amount'], rows: [[`Payment against ${ref}`, pdfMoney(amount)]], total: pdfMoney(amount) });
}
export function sampleDocumentFile(db: DB, name: string, category: string, party?: string) {
  return sampleFile(db, { kind: 'Document', ref: name, partyLabel: 'Linked to', party: party || 'Not linked', meta: [['Category', category]] });
}

