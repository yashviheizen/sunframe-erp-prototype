// Versioned sample dataset (fictional companies, people and documents).
//
// The records are produced by replaying the real business actions — lead → BOM → quote → Client PO
// → SO → MO, shortage PR → supplier PO → GRN → allocation, issue → production → FG → dispatch →
// receivable, supplier PO → payable → payment — inside an in-memory sandbox on a historical clock.
// Every rule the UI enforces therefore applies, and the result is checked again by `validate` before
// anything is saved.
//
// The set is added in parts. Each part runs once, in order, and records its version in the same write
// as its records:
//  * part 1 — the original scenario (ids `s1-…`, unchanged so earlier installs are not duplicated);
//  * part 2 — additions for the restored views (repeat business per account, issue register, licences,
//    users and HRMS lists). It builds on the live data but only ADDS records: it uses its own materials,
//    so it never changes stock, reservations or balances of existing records;
//  * part 3 — a few lost deals for the CRM "Lost" stage (new fictional leads only; won deals are never changed).
//
// Safety:
//  * ids are stable (deterministic), records carry `isSample: true`; existing ids are never overwritten;
//  * the user's own records, files and selected user are left untouched;
//  * "Erase all data" sets `meta.seedOptOut`, so nothing is re-added afterwards;
//  * on any failure nothing from that part is committed and the next load simply tries again.
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { DB, ID, ISODate, Lead, PriceLine, FileMeta, LeadStage, User } from './lib/types';
import { useStore, getDB, createSandbox, quoteForLead, moForLead, reservedQty, receivableBalance, poTotal } from './store';
import { storeFile, deleteFile } from './lib/files';
import { quoteSpec, soSpec, poSpec, specToStoredPdf } from './lib/docs';
import { pdfMoney } from './lib/pdf';
import { todayISO, addDays, setClock, setIdGenerator, quoteTotals, parseTermsDays, fmtDate } from './lib/format';

export const SEED_VERSION = 3;

const needsPart = (db: DB, v: number) => !db.meta?.seedOptOut && (db.meta?.seedVersion ?? 0) < v;
export const needsSeed = (db: DB) => needsPart(db, SEED_VERSION);

let running: Promise<void> | null = null;
/** Idempotent entry point (safe under StrictMode double effects and repeated calls). */
export function ensureSampleData(): Promise<void> {
  if (!running) running = runSeed().catch(e => { console.error('[seed] Sample records were not added:', e); });
  return running;
}

type Sandbox = ReturnType<typeof createSandbox>;
type Rec = { id: ID; isSample?: boolean };
const COLLECTIONS = ['leads', 'materials', 'boms', 'quotes', 'clientPOs', 'salesOrders', 'mos', 'reservations', 'prs', 'suppliers',
  'supplierQuotations', 'supplierPOs', 'grns', 'fgItems', 'dispatches', 'receivables', 'payables', 'documents', 'activities',
  'materialIssues', 'employees', 'leaves', 'payrollRuns'] as const;
type Col = (typeof COLLECTIONS)[number];
const arr = (db: DB, k: Col) => (db[k] ?? []) as unknown as Rec[];

const PARTS: { version: number; build: (st: Sandbox, today: ISODate) => Promise<void> }[] = [
  { version: 1, build: part1 },
  { version: 2, build: part2 },
  { version: 3, build: part3 },
];

async function runSeed() {
  for (const part of PARTS) {
    if (!needsPart(getDB(), part.version)) continue;
    const ok = await runPart(part.version, part.build);
    if (!ok) return;
  }
}

async function runPart(version: number, build: (st: Sandbox, today: ISODate) => Promise<void>) {
  const legacyFiles: string[] = [];
  // Part 1 is built on the user's own records only (as originally); later parts on everything that exists.
  const base = version === 1 ? withoutSample(removeLegacyDemo(structuredClone(getDB()), legacyFiles)) : structuredClone(getDB());
  const sbx = createSandbox(base);
  let n = 0;
  setIdGenerator(() => `s${version}-${(++n).toString(36).padStart(4, '0')}`);
  try { await build(sbx, todayISO()); }
  finally { setIdGenerator(null); setClock(null); }
  const built = sbx.getState().db;
  const baseIds = new Set(COLLECTIONS.flatMap(k => arr(base, k).map(r => r.id)));
  validate(built, id => !baseIds.has(id));

  // One atomic write: (legacy cleanup) + new sample records + version flag.
  let committed = false;
  useStore.setState(s => {
    if (!needsPart(s.db, version)) return s;
    committed = true;
    const live = version === 1 ? removeLegacyDemo(structuredClone(s.db), []) : structuredClone(s.db);
    return { db: merge(live, built, base, version) };
  });
  if (committed) for (const f of legacyFiles) await deleteFile(f).catch(() => {});
  return committed;
}

/** Records that exist in `built` but not in `base` are the sample set; add the ones `live` doesn't already have. */
function merge(live: DB, built: DB, base: DB, version: number): DB {
  for (const k of COLLECTIONS) {
    const baseIds = new Set(arr(base, k).map(r => r.id));
    const liveIds = new Set(arr(live, k).map(r => r.id));
    const b = arr(built, k);
    const firstOld = b.findIndex(r => baseIds.has(r.id));
    const fresh = (r: Rec) => !baseIds.has(r.id) && !liveIds.has(r.id);
    const tag = (r: Rec) => ({ ...r, isSample: true });
    const front = (firstOld < 0 ? [] : b.slice(0, firstOld)).filter(fresh).map(tag);
    const back = (firstOld < 0 ? b : b.slice(firstOld)).filter(fresh).map(tag);
    let out = [...front, ...arr(live, k), ...back];
    if (k === 'activities') out = (out as unknown as DB['activities']).sort((a, z) => z.at.localeCompare(a.at)) as unknown as Rec[];
    if (k === 'documents') out = (out as unknown as DB['documents']).sort((a, z) => z.uploadedAt.localeCompare(a.uploadedAt)) as unknown as Rec[];
    if (k === 'materialIssues') out = (out as unknown as DB['materialIssues']).sort((a, z) => z.at.localeCompare(a.at)) as unknown as Rec[];
    (live as unknown as Record<Col, Rec[]>)[k] = out;
  }
  // Simulated users are matched by their fixed id; a user already present (possibly edited) is kept as-is.
  for (const u of built.users) if (!live.users.some(x => x.id === u.id)) live.users.push(u);
  for (const [k, v] of Object.entries(built.counters)) live.counters[k] = Math.max(live.counters[k] ?? 0, v);
  live.meta = { ...live.meta, seedVersion: version };
  return live;
}

const withoutSample = (db: DB): DB => {
  for (const k of COLLECTIONS) (db as unknown as Record<Col, Rec[]>)[k] = arr(db, k).filter(r => !r.isSample);
  return db;
};

/** Removes records created by the earlier "[Demo]" loader (identified by its labels), with everything linked to them. */
function removeLegacyDemo(db: DB, files: string[]): DB {
  const leads = new Set(db.leads.filter(l => l.company.startsWith('[Demo]')).map(l => l.id));
  const mats = new Set(db.materials.filter(m => m.name.endsWith('[Demo]') || m.code.startsWith('DEMO-')).map(m => m.id));
  const sups = new Set(db.suppliers.filter(s => s.name.startsWith('[Demo]')).map(s => s.id));
  if (!leads.size && !mats.size && !sups.size) return db;
  const mos = new Set(db.mos.filter(m => leads.has(m.leadId)).map(m => m.id));
  const prs = new Set(db.prs.filter(p => (p.moId && mos.has(p.moId)) || p.lines.some(l => mats.has(l.materialId))).map(p => p.id));
  const pos = new Set(db.supplierPOs.filter(p => (p.prId && prs.has(p.prId)) || (p.supplierId && sups.has(p.supplierId)) || p.lines.some(l => mats.has(l.materialId))).map(p => p.id));
  const drop = new Set<ID>();
  const keep = <T extends Rec>(xs: T[], gone: (x: T) => boolean) => xs.filter(x => { const g = gone(x); if (g) drop.add(x.id); return !g; });
  db.leads = keep(db.leads, l => leads.has(l.id));
  db.materials = keep(db.materials, m => mats.has(m.id));
  db.suppliers = keep(db.suppliers, s => sups.has(s.id));
  db.boms = keep(db.boms, x => leads.has(x.leadId));
  db.quotes = keep(db.quotes, x => leads.has(x.leadId));
  db.clientPOs = keep(db.clientPOs, x => leads.has(x.leadId));
  db.salesOrders = keep(db.salesOrders, x => leads.has(x.leadId));
  db.mos = keep(db.mos, x => mos.has(x.id));
  db.reservations = keep(db.reservations, x => mos.has(x.moId) || mats.has(x.materialId));
  db.prs = keep(db.prs, x => prs.has(x.id));
  db.supplierPOs = keep(db.supplierPOs, x => pos.has(x.id));
  db.supplierQuotations = keep(db.supplierQuotations, x => sups.has(x.supplierId));
  db.grns = keep(db.grns, x => pos.has(x.poId));
  db.payables = keep(db.payables, x => pos.has(x.poId));
  db.fgItems = keep(db.fgItems, x => leads.has(x.leadId));
  db.dispatches = keep(db.dispatches, x => leads.has(x.leadId));
  db.receivables = keep(db.receivables, x => leads.has(x.leadId));
  db.documents = keep(db.documents, d => {
    const gone = (d.leadId && leads.has(d.leadId)) || (d.supplierId && sups.has(d.supplierId)) || (d.refId && drop.has(d.refId)) || d.linkedRef.includes('[Demo]') || d.linkedRef.startsWith('DEMO-');
    if (gone) files.push(d.file.fileId);
    return !!gone;
  });
  db.activities = db.activities.filter(a => !(a.leadId && leads.has(a.leadId)) && !a.text.includes('[Demo]'));
  return db;
}

/* ------------------------------------------------------------------ consistency check */

/** Checks the records a part added (`isNew`); the user's own records are not judged. */
function validate(db: DB, isNew: (id: ID) => boolean) {
  const errs: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const nu = <T extends { id: ID }>(xs: T[]) => xs.filter(x => isNew(x.id));
  for (const m of nu(db.materials)) {
    if (m.onHand < 0) errs.push(`${m.code} negative stock`);
    if (reservedQty(db, m.id) > m.onHand + 0.0005) errs.push(`${m.code} reserved more than on hand`);
  }
  for (const r of nu(db.reservations)) {
    const mo = db.mos.find(x => x.id === r.moId);
    const req = mo?.requirements.find(x => x.materialId === r.materialId);
    if (!mo || !req || r.qty > req.required + 0.0005) errs.push(`reservation ${r.id} invalid`);
    if (!isNew(r.materialId)) errs.push(`reservation ${r.id} uses stock of an existing material`);
  }
  for (const so of nu(db.salesOrders)) {
    const cpo = db.clientPOs.find(c => c.id === so.clientPoId);
    if (!cpo || !near(cpo.amount, so.total)) errs.push(`${so.ref} total ≠ Client PO amount`);
    if (cpo && cpo.poDate > so.date) errs.push(`${so.ref} dated before its Client PO`);
    if (!near(so.total, Math.round(quoteTotals(so).total * 100) / 100)) errs.push(`${so.ref} total mismatch`);
  }
  for (const r of nu(db.receivables)) {
    const d = db.dispatches.find(x => x.id === r.dispatchId);
    const so = db.salesOrders.find(x => x.id === r.soId);
    if (!d || d.status !== 'Dispatched' || !d.dispatchDate) { errs.push(`${r.ref} without dispatch`); continue; }
    if (!so || !near(r.amount, so.total)) errs.push(`${r.ref} amount ≠ SO total`);
    const days = so ? parseTermsDays(so.paymentTerms) : null;
    if (days === null || r.dueDate !== addDays(d.dispatchDate, days)) errs.push(`${r.ref} due date does not follow terms`);
    if (r.payments.some(p => p.date < d.dispatchDate!)) errs.push(`${r.ref} payment before dispatch`);
    if (receivableBalance(r).outstanding < -0.004) errs.push(`${r.ref} overpaid`);
  }
  for (const p of nu(db.payables)) {
    const po = db.supplierPOs.find(x => x.id === p.poId);
    if (!po || po.status !== 'Approved') errs.push(`${p.ref} without approved PO`);
    if (p.dueDate !== addDays(p.poDate, p.termsDays)) errs.push(`${p.ref} due date does not follow terms`);
    if (po && !near(p.amount, poTotal(po))) errs.push(`${p.ref} amount ≠ PO total`);
    if (receivableBalance(p).outstanding < -0.004) errs.push(`${p.ref} overpaid`);
  }
  for (const f of nu(db.fgItems)) if (f.dispatchedQty > f.producedQty) errs.push('FG over-dispatched');
  for (const g of nu(db.grns)) { const po = db.supplierPOs.find(x => x.id === g.poId); if (!po || g.date < po.date) errs.push(`${g.number} dated before its PO`); }
  for (const l of nu(db.leads)) {
    const mo = moForLead(db, l.id);
    if (mo && db.reservations.some(r => r.moId === mo.id) && l.stage !== 'Closed') errs.push(`${l.ref} reserved without an order`);
    if (!mo && db.reservations.some(r => db.mos.find(m => m.id === r.moId)?.leadId === l.id)) errs.push(`${l.ref} reservation without MO`);
  }
  for (const i of nu(db.materialIssues ?? [])) {
    const res = db.reservations.find(r => `iss-${r.id}` === i.id);
    const mo = db.mos.find(m => m.id === i.moId);
    if (!res || res.status !== 'Issued' || !near(res.qty, i.qty) || !mo?.materialsIssued || mo.line !== i.line) errs.push(`issue ${i.id} inconsistent`);
  }
  for (const r of nu(db.payrollRuns ?? [])) if (!near(r.net, r.gross - r.deductions)) errs.push(`payroll ${r.month} net ≠ gross − deductions`);
  for (const l of nu(db.leaves ?? [])) if (!db.employees.some(e => e.id === l.employeeId) || l.to < l.from) errs.push(`leave ${l.id} invalid`);
  if (errs.length) throw new Error('Sample data failed validation: ' + errs.join('; '));
}

/* ------------------------------------------------------------------ fictional document files */

const ink: [number, number, number] = [32, 41, 56];
function paper(o: { from: string[]; title: string; ref: string; date: ISODate; to?: string[]; kv?: [string, string][]; table?: { head: string[]; rows: (string | number)[][] }; note?: string; sign?: string }) {
  const d = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = d.internal.pageSize.getWidth();
  d.setTextColor(...ink);
  d.setFont('helvetica', 'bold'); d.setFontSize(15); d.text(o.from[0], 40, 52);
  d.setFont('helvetica', 'normal'); d.setFontSize(9); d.setTextColor(90, 99, 112);
  o.from.slice(1).forEach((l, i) => d.text(l, 40, 68 + i * 12));
  d.setDrawColor(200, 205, 212); d.line(40, 104, W - 40, 104);
  d.setTextColor(...ink); d.setFont('helvetica', 'bold'); d.setFontSize(13); d.text(o.title, 40, 130);
  d.setFont('helvetica', 'normal'); d.setFontSize(10);
  d.text(`No. ${o.ref}`, W - 40, 122, { align: 'right' }); d.text(`Date: ${fmtDate(o.date)}`, W - 40, 136, { align: 'right' });
  let y = 160;
  if (o.to) { d.setFont('helvetica', 'bold'); d.text('To', 40, y); d.setFont('helvetica', 'normal'); o.to.forEach((l, i) => d.text(l, 40, y + 14 + i * 13)); y += 22 + o.to.length * 13; }
  for (const [k, v] of o.kv ?? []) { d.setTextColor(90, 99, 112); d.text(k, 40, y); d.setTextColor(...ink); d.text(String(v), 170, y); y += 15; }
  if (o.table) {
    autoTable(d, { startY: y + 6, head: [o.table.head], body: o.table.rows.map(r => r.map(String)), margin: { left: 40, right: 40 },
      styles: { fontSize: 9, cellPadding: 5 }, headStyles: { fillColor: [52, 64, 84] } });
    y = (d as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;
  }
  if (o.note) { d.setFontSize(9); d.setTextColor(90, 99, 112); d.text(d.splitTextToSize(o.note, W - 80), 40, y + 6); y += 40; }
  if (o.sign) { d.setTextColor(...ink); d.setFontSize(10); d.text('For ' + o.from[0], W - 40, y + 30, { align: 'right' }); d.text(o.sign, W - 40, y + 70, { align: 'right' }); }
  return d.output('blob');
}

function drawingPdf(company: string, project: string, ref: string, date: ISODate) {
  const d = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const W = d.internal.pageSize.getWidth(), H = d.internal.pageSize.getHeight();
  d.setDrawColor(...ink); d.setLineWidth(1.2); d.rect(20, 20, W - 40, H - 40);
  // elevation of one fixed-tilt table: rafters on front/rear posts with bracing
  d.setLineWidth(1);
  const gx = 90, gy = 380;
  d.line(gx - 30, gy, gx + 470, gy);
  for (const x of [gx + 40, gx + 360]) { d.line(x, gy, x, gy - (x === gx + 40 ? 90 : 210)); d.rect(x - 12, gy, 24, 26); }
  d.line(gx, gy - 70, gx + 420, gy - 230); // rafter
  d.line(gx + 40, gy - 20, gx + 360, gy - 200); // brace
  for (let i = 0; i < 6; i++) { const x = gx + 30 + i * 70; const y = gy - 70 - (x - gx) * (160 / 420); d.rect(x, y - 8, 16, 8); }
  d.setFontSize(9); d.setTextColor(...ink);
  d.text('FRONT POST  C 100×50×2.5', gx - 20, gy + 44); d.text('REAR POST  C 100×50×2.5', gx + 300, gy + 44);
  d.text('RAFTER  C 90×40×2.0 @ 2500 c/c', gx + 150, gy - 160); d.text('PURLIN  Ω 60×40×1.6 (6 nos.)', gx + 200, gy - 250);
  d.text('Tilt 20°  ·  Ground clearance 600 mm  ·  2P × 13 modules (2382 × 1134 mm)', gx - 30, gy + 80);
  d.text('Notes: all members HDG to IS 4759 (min. 80 µm). Fasteners M10 HDG 8.8. Anchor bolts M12 × 150 in M20 pedestal.', gx - 30, gy + 96);
  // title block
  const tx = W - 270, ty = H - 150;
  d.rect(tx, ty, 250, 130);
  [ty + 26, ty + 52, ty + 78, ty + 104].forEach(y => d.line(tx, y, tx + 250, y));
  d.setFontSize(10); d.setFont('helvetica', 'bold'); d.text('GENERAL ARRANGEMENT — MMS TABLE', tx + 8, ty + 17);
  d.setFont('helvetica', 'normal'); d.setFontSize(9);
  d.text(`Client: ${company}`, tx + 8, ty + 43); d.text(`Project: ${project}`, tx + 8, ty + 69);
  d.text(`Drg. no. ${ref}  ·  Rev R1`, tx + 8, ty + 95); d.text(`Date ${fmtDate(date)}  ·  Scale NTS  ·  Sheet 1 of 1`, tx + 8, ty + 121);
  return d.output('blob');
}


/* ------------------------------------------------------------------ the scenario */

type BomFn = (sets: number) => { id: string; materialId: ID; qty: number }[];
interface QuoteSpec {
  company: string; contact: string; email: string; phone: string; project: string;
  sets: number; rate: number; disc: number; freight: number; terms: string;
  bom: BomFn; product?: string; owner?: string;
}
interface OrderSpec extends QuoteSpec {
  site: string; cpoNo: string;
  mo: number; // days ago the MO was created; earlier commercial steps are derived from it
  negotiated?: boolean; drawing?: boolean;
  transport?: [vehicle: string, transporter: string, driver: string];
}

const OWNER = 'Abhineet Suryawanshi';
const DELIVERY = 'Door delivery to site in lots as per erection sequence; unloading by client.';
const TNC = 'Prices firm for 15 days. Structure designed for 170 km/h basic wind speed (IS 875 Part 3). Foundations, civil work and module installation excluded. Delivery schedule from receipt of Client PO and approved drawings.';
const productName = (o: { project: string; product?: string }) => o.product ?? `Fixed-tilt MMS, HDG — ${o.project.split(',')[0]}`;
const quoteLine = (o: QuoteSpec): Omit<PriceLine, 'id'> => ({ description: `${productName(o)} (2P × 13 modules per table), incl. fasteners & anchor bolts`, qty: o.sets, unit: 'sets', rate: o.rate });

/** Helpers that replay business actions on the sandbox at historical times. */
function makeKit(st: Sandbox, today: ISODate) {
  const A = () => st.getState();
  const db = () => st.getState().db;
  const D = (daysAgo: number) => addDays(today, -daysAgo);
  let tick = 0;
  /** Move the sandbox clock to `daysAgo` (working hours) and act as `user`. */
  const on = (daysAgo: number, user = 'u_admin') => {
    const t = new Date(D(daysAgo) + 'T09:40:00');
    t.setMinutes(t.getMinutes() + (tick++ % 30) * 13);
    setClock(() => new Date(t));
    if (db().currentUserId !== user) A().setUser(user);
  };
  const file = (blob: Blob, name: string): Promise<FileMeta> => storeFile(blob, name);

  const usedCodes = () => new Set(db().materials.map(m => m.code));
  const freeName = (name: string) => db().materials.some(m => m.name.toLowerCase() === name.toLowerCase()) ? `${name} (stock B)` : name;
  const mat = (name: string, category: string, unit: string, onHand: number) => {
    let i = db().materials.length + 1;
    while (usedCodes().has(`RM-${String(i).padStart(3, '0')}`)) i++;
    return A().addMaterial({ code: `RM-${String(i).padStart(3, '0')}`, name: freeName(name), category, unit, onHand });
  };
  const freeSup = (name: string) => db().suppliers.some(s => s.name.toLowerCase() === name.toLowerCase()) ? `${name} (Unit 2)` : name;
  const sup = (name: string, gst: string, contact: string, phone: string, email: string, category: string) =>
    A().saveSupplier({ name: freeSup(name), gst, contact, phone, email, category, active: true });
  const supLines = (id: ID) => { const s = db().suppliers.find(x => x.id === id)!; return [s.name, `GSTIN ${s.gst}`, `${s.contact} · ${s.phone} · ${s.email}`]; };
  const matName = (id: ID) => db().materials.find(m => m.id === id)!;

  const quotation = async (supId: ID, category: string, ref: string, daysAgo: number, items: [ID, number, number][]) => {
    on(daysAgo, 'u_meera');
    const blob = paper({ from: supLines(supId), title: 'QUOTATION', ref, date: D(daysAgo), to: ['Purchase department', 'SunFrame — Chakan, Pune'],
      table: { head: ['Material', 'Qty', 'Unit', 'Rate', 'Amount'], rows: items.map(([m, q, r]) => [matName(m).name, q.toLocaleString('en-IN'), matName(m).unit, pdfMoney(r), pdfMoney(q * r)]) },
      note: 'Rates ex-works, GST 18% extra. Validity 15 days. Delivery 3–5 working days from PO.', sign: 'Authorised signatory' });
    return A().addSupplierQuotation({ supplierId: supId, category, reference: ref, date: D(daysAgo), file: await file(blob, `${ref.replace(/\//g, '-')}.pdf`) });
  };
  const poPdf = async (poId: ID) => {
    const po = db().supplierPOs.find(p => p.id === poId)!;
    A().attachPODocument(poId, await specToStoredPdf(poSpec(db(), po), `${po.ref}.pdf`));
  };
  let grnSeq = 0;
  const receive = async (poId: ID, daysAgo: number, withFile = true, by = 'u_dinesh', checker = 'Dinesh Patil') => {
    on(daysAgo, by);
    const po = db().supplierPOs.find(p => p.id === poId)!;
    let number = '';
    do number = `GRN-${D(daysAgo).slice(0, 4)}-${String(++grnSeq).padStart(4, '0')}`; while (db().grns.some(g => g.number === number));
    const lines = po.lines.map(l => ({ materialId: l.materialId, qty: l.qty }));
    const f = withFile ? await file(paper({ from: ['SunFrame — Stores', 'Plot 14, MIDC Chakan Phase II, Pune 410501'], title: 'GOODS RECEIPT NOTE', ref: number, date: D(daysAgo),
      kv: [['Supplier', db().suppliers.find(s => s.id === po.supplierId)!.name], ['Against PO', po.ref], ['Vehicle', 'MH 12 RT 4471'], ['Checked by', checker]],
      table: { head: ['Material', 'Ordered', 'Received', 'Unit', 'Condition'], rows: lines.map(l => [matName(l.materialId).name, l.qty.toLocaleString('en-IN'), l.qty.toLocaleString('en-IN'), matName(l.materialId).unit, 'OK — no damage']) },
      note: 'Weighbridge slip and mill test certificate attached to the physical file.', sign: 'Stores in-charge' }), `${number}.pdf`) : undefined;
    A().receiveGoods(poId, { number, date: D(daysAgo), lines, file: f });
  };
  const payProof = (payer: string, payee: string, amount: number, utr: string, daysAgo: number) => paper({
    from: ['Payment advice', payer], title: 'NEFT / RTGS TRANSFER CONFIRMATION', ref: utr, date: D(daysAgo),
    kv: [['Beneficiary', payee], ['Amount', pdfMoney(amount)], ['UTR', utr], ['Status', 'Credited']] });
  const payVendor = async (match: (p: DB['payables'][number]) => boolean, daysAgo: number, amount: number | 'full', utr: string, by = 'u_admin') => {
    on(daysAgo, by);
    const p = db().payables.find(match)!;
    const amt = amount === 'full' ? receivableBalance(p).outstanding : amount;
    const supName = db().suppliers.find(s => s.id === p.supplierId)!.name;
    A().recordPayablePayment(p.id, { date: D(daysAgo), amount: amt, mode: 'Bank transfer (NEFT/RTGS)', reference: utr,
      proof: await file(payProof('SunFrame', supName, amt, utr, daysAgo), `Payment-${utr}.pdf`) });
  };

  const leadOf = (o: QuoteSpec, daysAgo: number, stage: LeadStage, followUp = '') => {
    on(daysAgo);
    return A().addLead({ company: o.company, contact: o.contact, email: o.email, phone: o.phone, project: o.project, estValue: Math.round(o.sets * o.rate * 1.18 / 100000) * 100000,
      owner: o.owner ?? OWNER, nextFollowUp: followUp, stage });
  };
  const drawing = async (lead: Lead, daysAgo: number) => {
    on(daysAgo);
    const ref = `SF-GA-${lead.ref.slice(-4)}`;
    A().addDocument({ name: `${ref} GA drawing R1.pdf`, file: await file(drawingPdf(lead.company, lead.project, ref, D(daysAgo)), `${ref}-GA-drawing-R1.pdf`),
      partyType: 'client', partyName: lead.company, category: 'Engineering drawing', linkedRef: lead.ref, leadId: lead.id, expiry: '' });
  };
  const quoteFor = async (lead: Lead, o: QuoteSpec, bomDay: number, quoteDay: number | null, send = true) => {
    on(bomDay);
    A().saveBom(lead.id, { productName: productName(o), outputQty: o.sets, outputUnit: 'sets', lines: o.bom(o.sets), notes: 'Tilt 20°, 2P × 13 modules per table. HDG min. 80 µm. Drawing ref. SF-GA series.' });
    if (quoteDay === null) return;
    on(quoteDay);
    A().saveQuote(lead.id, { date: D(quoteDay), validDays: 15, lines: [{ id: 'ql', ...quoteLine(o) }], discountPct: o.disc, freight: o.freight, gstPct: 18,
      paymentTerms: o.terms, deliveryTerms: DELIVERY, terms: TNC });
    if (!send) return;
    const q = quoteForLead(db(), lead.id)!;
    A().markQuoteSent(q.id, await specToStoredPdf(quoteSpec(q, lead), `${q.ref}.pdf`));
  };

  /** Lead → BOM → quote sent → (negotiation) → won → Client PO → SO → MO, dated backwards from the MO day. */
  const sell = async (o: OrderSpec, upTo: 'cpo' | 'mo' = 'mo') => {
    const t = o.mo;
    const lead = leadOf(o, t + 38, 'Warm');
    on(t + 33); A().setLeadStage(lead.id, 'Hot');
    if (o.drawing) await drawing(lead, t + 30);
    await quoteFor(lead, o, t + 29, t + 26);
    if (o.negotiated) { on(t + 18); A().setLeadStage(lead.id, 'Negotiation'); }
    on(t + 10); A().setLeadStage(lead.id, 'Closed');
    const q = quoteForLead(db(), lead.id)!;
    const lines = q.lines.map(l => ({ ...l }));
    const amount = Math.round(quoteTotals(q).total * 100) / 100;
    const cpoDate = D(t + 8);
    on(t + 7);
    const cpoFile = await file(paper({ from: [o.company, o.site, `Contact: ${o.contact} · ${o.phone}`], title: 'PURCHASE ORDER', ref: o.cpoNo, date: cpoDate,
      to: ['SunFrame', 'Plot 14, MIDC Chakan Phase II, Pune 410501'], kv: [['Your quotation', q.ref], ['Payment terms', o.terms], ['Delivery', o.site]],
      table: { head: ['Description', 'Qty', 'Unit', 'Rate', 'Amount'], rows: lines.map(l => [l.description, l.qty, l.unit, pdfMoney(l.rate), pdfMoney(l.qty * l.rate)]) },
      note: `Discount ${q.discountPct}% · Freight ${pdfMoney(q.freight)} · GST 18% extra. PO value incl. GST: ${pdfMoney(amount)}. ${TNC}`, sign: 'Head — Projects' }), `${o.cpoNo.replace(/\//g, '-')}.pdf`);
    A().saveClientPO(lead.id, { poNumber: o.cpoNo, poDate: cpoDate, lines, amount, paymentTerms: o.terms, deliveryTerms: DELIVERY, deliveryAddress: o.site, terms: TNC, file: cpoFile });
    if (upTo === 'cpo') return { lead, moId: '' };
    on(t + 6);
    const so = { date: D(t + 6), expectedDelivery: D(t - 42), lines, discountPct: q.discountPct, freight: q.freight, gstPct: q.gstPct,
      paymentTerms: o.terms, deliveryTerms: DELIVERY, deliveryAddress: o.site, terms: TNC };
    await A().createSO(lead.id, so, ref => specToStoredPdf(soSpec({ ...so, ref }, lead, o.cpoNo, cpoDate), `${ref}.pdf`));
    on(t);
    const mo = A().createMO(lead.id, D(t - 4));
    return { lead, moId: mo.id };
  };

  /** Assign → issue → advance `stages` times, spreading the advances evenly up to `lastDay`. */
  const produce = (moId: ID, line: 'Line 1' | 'Line 2', assignDay: number, issueDay: number | null, stages = 0, lastDay = 0, issuer = 'u_dinesh') => {
    on(assignDay); A().assignLine(moId, line);
    if (issueDay === null) return;
    on(issueDay, issuer); A().issueMaterials(moId);
    for (let i = 1; i <= stages; i++) { on(Math.round(issueDay - (issueDay - lastDay) * i / stages), 'u_dinesh'); A().advanceStage(moId); }
  };
  const dispatch = async (o: OrderSpec, moId: ID, daysAgo: number, podDay: number | null) => {
    on(daysAgo, 'u_dinesh');
    const d = db().dispatches.find(x => x.moId === moId)!;
    const [vehicleNo, transporter, driver] = o.transport!;
    const lr = `LR-${D(daysAgo).slice(2, 4)}${String(4100 + daysAgo * 7).padStart(5, '0')}`;
    A().confirmDispatch(d.id, { dispatchDate: D(daysAgo), vehicleNo, transporter, driver, lrNumber: lr });
    if (podDay !== null) {
      on(podDay, 'u_dinesh');
      const lead = db().leads.find(l => l.id === d.leadId)!;
      A().addPod(d.id, await file(paper({ from: [transporter, 'Lorry receipt / proof of delivery'], title: 'PROOF OF DELIVERY', ref: lr, date: D(podDay + 1),
        kv: [['Consignor', 'SunFrame, Chakan, Pune'], ['Consignee', lead.company], ['Delivered at', o.site.slice(0, 70)], ['Vehicle', vehicleNo], ['Against', d.ref],
          ['Received', `${d.qty} ${d.unit} in good condition`], ['Received by', `${o.contact} (site)`]] }), `POD-${d.ref}.pdf`));
    }
    return d.id;
  };
  const receipt = async (dispatchId: ID, daysAgo: number, amount: number | 'full', utr: string, by = 'u_admin') => {
    on(daysAgo, by);
    const r = db().receivables.find(x => x.dispatchId === dispatchId)!;
    const lead = db().leads.find(l => l.id === r.leadId)!;
    const amt = amount === 'full' ? receivableBalance(r).outstanding : amount;
    A().recordReceipt(r.id, { date: D(daysAgo), amount: amt, mode: 'Bank transfer (NEFT/RTGS)', reference: utr,
      proof: await file(payProof(lead.company, 'SunFrame', amt, utr, daysAgo), `Receipt-${utr}.pdf`) });
  };
  return { A, db, D, on, file, mat, sup, matName, quotation, poPdf, receive, payVendor, leadOf, drawing, quoteFor, sell, produce, dispatch, receipt };
}

/* ------------------------------------------------------------------ part 1: original scenario */

async function part1(st: Sandbox, today: ISODate) {
  const { A, db, D, on, mat, sup, quotation, poPdf, receive, payVendor, leadOf, quoteFor, sell, produce, dispatch, receipt } = makeKit(st, today);

  /* -------- master data */
  on(122);
  const M = {
    hr: mat('HR coil 2.5 mm · IS 2062 E250', 'Steel coil', 'kg', 42000),
    gi: mat('Pre-galvanised coil 2.0 mm · Z275', 'Steel coil', 'kg', 30000),
    bolt: mat('HDG hex bolt set M10 × 25', 'Fasteners', 'pcs', 40000),
    anchor: mat('HDG anchor bolt M12 × 150', 'Fasteners', 'pcs', 6000),
    zinc: mat('Zinc ingot SHG 99.995%', 'Zinc / galvanizing', 'kg', 3100),
    wire: mat('MIG wire ER70S-6 · 1.2 mm', 'Consumables', 'kg', 420),
    pack: mat('Packing strap & stretch wrap', 'Packaging', 'rolls', 80),
  };
  const S = {
    coil: sup('Bharat Coil & Steel Traders', '27AAFCB4412M1Z3', 'Rakesh Jadhav', '+91 00000 10137', 'sales@bharatcoilsteel.example', 'Steel coil'),
    satpura: sup('Satpura Steel Processors', '27AAKFS9031P1ZQ', 'Anil Kulkarni', '+91 00000 10274', 'orders@satpurasteel.example', 'Steel coil'),
    zinc: sup('Vidarbha Zinc & Alloys', '27AACCV5520R1Z8', 'Sunita Deshmukh', '+91 00000 10411', 'sunita@vidarbhazinc.example', 'Zinc / galvanizing'),
    fast: sup('Nashik Fastener Works', '27ABEPN7724H1Z1', 'Imran Shaikh', '+91 00000 10548', 'imran@nashikfasteners.example', 'Fasteners'),
    weld: sup('Western Weld Consumables', '24AAGFW3318K1ZB', 'Hardik Patel', '+91 00000 10685', 'hardik@westernweld.example', 'Consumables'),
  };

  /* -------- supplier quotations (library) */
  const qSatpura = await quotation(S.satpura.id, 'Steel coil', 'SSP/Q/26/118', 101, [[M.hr.id, 33000, 61.5], [M.gi.id, 12000, 72]]);

  /* -------- opening replenishment PO (no PR) from Satpura, later marked inactive */
  on(97);
  const poA = A().savePO({ supplierId: S.satpura.id, lines: [{ id: 'pl', materialId: M.hr.id, qty: 33000, rate: 61.5 }, { id: 'pl2', materialId: M.gi.id, qty: 12000, rate: 72 }].map((l, i) => ({ ...l, id: `${l.id}${i}` })),
    expectedDelivery: D(94), paymentTermsDays: 30, quotationIds: [qSatpura] });
  await poPdf(poA.id);
  await receive(poA.id, 95);

  /* -------- sales orders */
  const bomLines: BomFn = n => ([[M.hr, 85 * n], [M.gi, 22 * n], [M.bolt, 24 * n], [M.anchor, 4 * n], [M.zinc, 5 * n], [M.wire, Math.round(0.6 * n * 10) / 10], [M.pack, Math.ceil(0.1 * n)]] as const)
    .map(([m, q], i) => ({ id: `b${i}`, materialId: m.id, qty: q }));
  const TRANSPORT: Record<string, [string, string, string]> = {
    o1: ['RJ 19 GD 4127', 'Marudhar Roadways', 'Bhanwar Lal'], o3: ['MH 16 CD 7781', 'Shree Ganesh Roadlines', 'Santosh Pawar'],
    o5: ['MP 09 HG 2290', 'Indore Golden Transport', 'Raju Yadav'], o2: ['MH 08 AP 5514', 'Konkan Cargo Movers', 'Sachin Kadam'],
    o4: ['GJ 16 AV 6038', 'Shree Ganesh Roadlines', 'Imtiyaz Pathan'],
  };
  type Base = Omit<OrderSpec, 'bom' | 'transport'>;
  const raw: Record<string, Base> = {
    o1: { company: 'Aravali Greenfield Energy Pvt Ltd', contact: 'Rohan Mehta', email: 'rohan.mehta@aravaligreenfield.example', phone: '+91 00000 10822', project: '4.2 MWp ground mount, Phalodi', site: 'Survey no. 212, Bap road, Phalodi, Jodhpur, Rajasthan 342301', sets: 180, rate: 78500, disc: 2, freight: 85000, terms: '30 days from dispatch', cpoNo: 'AGE/PO/26-27/0418', mo: 85, drawing: true },
    o3: { company: 'Shivneri Solar Parks LLP', contact: 'Prakash Gaikwad', email: 'prakash@shivnerisolar.example', phone: '+91 00000 10959', project: '2.5 MWp ground mount, Supa MIDC', site: 'Plot E-7, Supa-Parner MIDC, Ahmednagar 414301', sets: 120, rate: 79800, disc: 0, freight: 60000, terms: '30 days from dispatch', cpoNo: 'SSP-PUR-2611', mo: 80 },
    o5: { company: 'Malwa Weaving Mills Pvt Ltd', contact: 'Neha Agrawal', email: 'neha.agrawal@malwaweaving.example', phone: '+91 00000 11096', project: '1.6 MWp captive plant, Pithampur', site: 'Sector 3, Industrial Area, Pithampur, Dhar, MP 454775', sets: 80, rate: 80400, disc: 0, freight: 48000, terms: '30 days from dispatch', cpoNo: 'MWM/ENGG/PO/0937', mo: 74, negotiated: true },
    o2: { company: 'Konkan Agro Processors Pvt Ltd', contact: 'Siddharth Sawant', email: 'siddharth@konkanagro.example', phone: '+91 00000 11233', project: '1.1 MWp rooftop & carport, Lote', site: 'B-41, Lote Parshuram MIDC, Khed, Ratnagiri 415722', sets: 60, rate: 81200, disc: 0, freight: 38000, terms: '45 days from dispatch', cpoNo: 'KAP/2026/PO-1182', mo: 66, drawing: true },
    o4: { company: 'Narmada Cold Chain Pvt Ltd', contact: 'Jignesh Bhatt', email: 'jignesh@narmadacoldchain.example', phone: '+91 00000 11370', project: '750 kWp rooftop, Bharuch', site: 'Survey 88/2, NH-48, Jhagadia road, Bharuch, Gujarat 392001', sets: 40, rate: 82000, disc: 0, freight: 32000, terms: '45 days from dispatch', cpoNo: 'NCC-PO-2604', mo: 40 },
    o6: { company: 'Godavari Pipes & Polymers Ltd', contact: 'Kiran Reddy', email: 'kiran.reddy@godavaripipes.example', phone: '+91 00000 11507', project: '1.8 MWp ground mount, Paithan', site: 'Gat no. 77, Paithan road, Chhatrapati Sambhajinagar 431107', sets: 90, rate: 79000, disc: 1.5, freight: 52000, terms: '60 days from dispatch', cpoNo: 'GPPL/PUR/26/552', mo: 34, negotiated: true, drawing: true },
    o7: { company: 'Sahyadri Care Hospitals Trust', contact: 'Dr. Aparna Joshi', email: 'projects@sahyadricare.example', phone: '+91 00000 11644', project: '600 kWp carport, Hadapsar', site: 'Sahyadri Care campus, Magarpatta road, Hadapsar, Pune 411028', sets: 32, rate: 84500, disc: 0, freight: 26000, terms: '30 days from dispatch', cpoNo: 'SCHT/2026/078', mo: 30 },
    o10: { company: 'Krishna Valley Dairy Pvt Ltd', contact: 'Vikram Patil', email: 'vikram.patil@krishnavalleydairy.example', phone: '+91 00000 11781', project: '1.2 MWp ground mount, Karad', site: 'Plot 19, Karad-Masur road, Karad, Satara 415110', sets: 60, rate: 80000, disc: 0, freight: 40000, terms: '30 days from dispatch', cpoNo: 'KVD/PO/0261', mo: 30 },
    o9: { company: 'Tapi Agro Foods Pvt Ltd', contact: 'Manish Chaudhari', email: 'manish@tapiagrofoods.example', phone: '+91 00000 11918', project: '900 kWp rooftop, Jalgaon', site: 'E-34, MIDC Area, Jalgaon 425003', sets: 45, rate: 81500, disc: 0, freight: 30000, terms: '45 days from dispatch', cpoNo: 'TAF/26/PO/311', mo: 26, drawing: true },
    o11: { company: 'Ujjain Auto Components Pvt Ltd', contact: 'Ritesh Malviya', email: 'ritesh@ujjainauto.example', phone: '+91 00000 12055', project: '500 kWp rooftop, Dewas', site: 'Plot 5, Industrial Area 2, Dewas, MP 455001', sets: 28, rate: 85000, disc: 0, freight: 22000, terms: '30 days from dispatch', cpoNo: 'UAC/PO/2026/045', mo: 25 },
    o12: { company: 'Saurashtra Marine Salts Pvt Ltd', contact: 'Hiren Joshi', email: 'hiren.joshi@saurashtrasalts.example', phone: '+91 00000 12192', project: '2.2 MWp ground mount, Jodiya', site: 'Survey 401, Jodiya, Jamnagar, Gujarat 361250', sets: 110, rate: 79200, disc: 1, freight: 55000, terms: '60 days from dispatch', cpoNo: 'SMS/PUR/0198', mo: 24, negotiated: true },
    o8: { company: 'Vindhyachal Building Materials Ltd', contact: 'Ankit Tiwari', email: 'ankit.tiwari@vindhyachalbm.example', phone: '+91 00000 12329', project: '3.0 MWp ground mount, Satna', site: 'Village Itma, Maihar road, Satna, MP 485001', sets: 140, rate: 78900, disc: 2, freight: 70000, terms: '45 days from dispatch', cpoNo: 'VBML/SOLAR/PO/07', mo: 22, drawing: true },
    o13: { company: 'Bhimashankar Sugar Industries Ltd', contact: 'Sandeep More', email: 'sandeep.more@bhimashankarsugar.example', phone: '+91 00000 12466', project: '2.8 MWp captive plant, Manchar', site: 'Factory site, Pargaon Shingave, Manchar, Pune 410503', sets: 130, rate: 79600, disc: 1, freight: 62000, terms: '45 days from dispatch', cpoNo: 'BSIL/PO/2026-27/233', mo: 7 },
    o14: { company: 'Western Ghats Resorts Pvt Ltd', contact: 'Farah Khan', email: 'farah@westernghatsresorts.example', phone: '+91 00000 12603', project: '400 kWp carport, Lonavala', site: 'Survey 31, Tungarli, Lonavala, Pune 410401', sets: 24, rate: 86000, disc: 0, freight: 18000, terms: '30 days from dispatch', cpoNo: 'WGR/ADMIN/PO/112', mo: 2 },
  };
  const ORDERS = Object.fromEntries(Object.entries(raw).map(([k, o]) => [k, { ...o, bom: bomLines, transport: TRANSPORT[k] } as OrderSpec]));

  // Orders that went all the way through, oldest first (MO creation order matters for stock).
  const o1 = await sell(ORDERS.o1); produce(o1.moId, 'Line 1', 83, 82, 7, 61);
  const o3 = await sell(ORDERS.o3); produce(o3.moId, 'Line 2', 78, 77, 7, 56);
  const o5 = await sell(ORDERS.o5); produce(o5.moId, 'Line 1', 59, 58, 7, 48);
  const d1 = await dispatch(ORDERS.o1, o1.moId, 58, 55);
  const o2 = await sell(ORDERS.o2); produce(o2.moId, 'Line 2', 55, 54, 7, 42);
  const d3 = await dispatch(ORDERS.o3, o3.moId, 52, null);

  // Production supervisor's consumables request → PO → GRN (payable left unpaid, now overdue).
  await quotation(S.weld.id, 'Consumables', 'WWC/QT/2026/0611', 58, [[M.wire.id, 270, 168], [M.pack.id, 40, 1450]]);
  on(56, 'u_dinesh');
  const prCons = A().addPR({ lines: [{ materialId: M.wire.id, qty: 270 }, { materialId: M.pack.id, qty: 40 }], requiredBy: D(48), notes: 'Monthly consumables for Line 1 and Line 2' });
  on(55); const poConsDraft = A().approvePR(prCons.id);
  const wq = db().supplierQuotations.find(q => q.supplierId === S.weld.id)!;
  const poCons = A().savePO({ id: poConsDraft.id, supplierId: S.weld.id, lines: poConsDraft.lines.map(l => ({ ...l, rate: l.materialId === M.wire.id ? 168 : 1450 })),
    expectedDelivery: D(50), paymentTermsDays: 30, quotationIds: [wq.id] });
  await poPdf(poCons.id);
  await receive(poCons.id, 50, false);

  // Purchase executive: rejected buffer-stock request.
  on(60, 'u_meera');
  const prRej = A().addPR({ lines: [{ materialId: M.gi.id, qty: 8000 }], requiredBy: D(45), notes: 'Buffer stock of GI coil for Q3 orders' });
  on(59); A().rejectPR(prRej.id);

  const d5 = await dispatch(ORDERS.o5, o5.moId, 45, 41);
  const d2 = await dispatch(ORDERS.o2, o2.moId, 40, 37);
  await payVendor(p => p.poId === poA.id, 66, 'full', 'HDFCR52026061891732');

  const o4 = await sell(ORDERS.o4); produce(o4.moId, 'Line 1', 38, 37, 7, 9);
  on(40); A().toggleSupplier(S.satpura.id);
  const o6 = await sell(ORDERS.o6); produce(o6.moId, 'Line 2', 32, 31, 7, 3);
  const o7 = await sell(ORDERS.o7); produce(o7.moId, 'Line 1', 29, 28, 7, 1);

  // Zinc shortage on Krishna Valley → PR (admin raises to a 2.6 MT lot) → PO → GRN → reserved for the MO.
  const o10 = await sell(ORDERS.o10);
  const qZinc = await quotation(S.zinc.id, 'Zinc / galvanizing', 'VZA/Q/0926', 31, [[M.zinc.id, 2600, 268]]);
  on(30);
  const pr10 = db().prs.find(p => p.moId === o10.moId)!;
  A().updatePRLines(pr10.id, pr10.lines.map(l => ({ ...l, qty: 2600 })));
  const po10d = A().approvePR(pr10.id);
  on(29);
  const po10 = A().savePO({ id: po10d.id, supplierId: S.zinc.id, lines: po10d.lines.map(l => ({ ...l, rate: 268 })), expectedDelivery: D(27), paymentTermsDays: 30, quotationIds: [qZinc] });
  await poPdf(po10.id);
  await receive(po10.id, 27);

  const o9 = await sell(ORDERS.o9);
  const o11 = await sell(ORDERS.o11);
  const o12 = await sell(ORDERS.o12);

  // HR coil shortage on Vindhyachal → PR (rounded up to coil weight) → PO (60 days) → GRN → reserved.
  const o8 = await sell(ORDERS.o8);
  const qCoil = await quotation(S.coil.id, 'Steel coil', 'BCST/Q/26-27/0342', 23, [[M.hr.id, 9000, 62.4], [M.hr.id, 11000, 62.1]]);
  on(21);
  const pr8 = db().prs.find(p => p.moId === o8.moId)!;
  A().updatePRLines(pr8.id, pr8.lines.map(l => ({ ...l, qty: Math.ceil(l.qty / 500) * 500 })));
  const po8d = A().approvePR(pr8.id);
  on(20);
  const po8 = A().savePO({ id: po8d.id, supplierId: S.coil.id, lines: po8d.lines.map(l => ({ ...l, rate: 62.4 })), expectedDelivery: D(13), paymentTermsDays: 60, quotationIds: [qCoil] });
  await poPdf(po8.id);
  await receive(po8.id, 12);

  produce(o10.moId, 'Line 2', 26, 19, 5, 2);   // → Galvanizing
  produce(o8.moId, 'Line 1', 12, 11, 4, 1);    // → Welding
  produce(o9.moId, 'Line 1', 12, 8, 1, 5);     // → Roll forming
  produce(o11.moId, 'Line 2', 2, null);        // assigned, awaiting material issue
  const d4 = await dispatch(ORDERS.o4, o4.moId, 6, null);

  // Bhimashankar: shortage PR approved, PO approved and awaiting delivery (GRN pending).
  const o13 = await sell(ORDERS.o13);
  on(6);
  const pr13 = db().prs.find(p => p.moId === o13.moId)!;
  const po13d = A().approvePR(pr13.id);
  on(5);
  const po13 = A().savePO({ id: po13d.id, supplierId: S.coil.id, lines: po13d.lines.map(l => ({ ...l, rate: 62.1 })), expectedDelivery: D(-4), paymentTermsDays: 30, quotationIds: [qCoil] });
  await poPdf(po13.id);

  // Purchase executive: approved PR whose PO still needs supplier details; plus a pending one.
  await quotation(S.fast.id, 'Fasteners', 'NFW/2026/Q-1187', 10, [[M.anchor.id, 3000, 21.5], [M.bolt.id, 15000, 9.8]]);
  on(9, 'u_meera');
  const prAnchor = A().addPR({ lines: [{ materialId: M.anchor.id, qty: 3000 }], requiredBy: D(-10), notes: 'Anchor bolts for Bhimashankar and Saurashtra foundations' });
  on(8); A().approvePR(prAnchor.id);
  on(4, 'u_meera');
  A().addPR({ lines: [{ materialId: M.bolt.id, qty: 15000 }], requiredBy: D(-14), notes: 'Hex bolt sets — reorder level reached' });
  on(3, 'u_dinesh');
  A().addPR({ lines: [{ materialId: M.pack.id, qty: 30 }], requiredBy: D(-7), notes: 'Packing material for Godavari and Sahyadri dispatches' });

  // Western Ghats: newest MO, short of HR coil → shortage PR pending admin approval.
  await sell(ORDERS.o14);

  // Won deal with Client PO recorded; SO not generated yet.
  await sell({ company: 'Pench Valley Foods Pvt Ltd', contact: 'Aditi Deshpande', email: 'aditi@penchvalleyfoods.example', phone: '+91 00000 12740', project: '650 kWp rooftop, Butibori', site: 'C-12, Butibori MIDC, Nagpur 441122', sets: 34, rate: 83500, disc: 0, freight: 24000, terms: '45 days from dispatch', cpoNo: 'PVF/PUR/2026/219', mo: -1, bom: bomLines }, 'cpo');

  // Money in/out.
  await receipt(d1, 27, 'full', 'ICIC926082711548');
  await receipt(d5, 12, 2000000, 'SBIN526092583014');
  await receipt(d2, 10, 2500000, 'HDFC626092840277');
  await payVendor(p => p.poId === po10.id, 5, 'full', 'HDFCR52026100219884');
  await payVendor(p => p.poId === po8.id, 3, 175000, 'HDFCR52026100437105');
  void d3; void d4; void o6; void o7; void o12;

  /* -------- open pipeline */
  const open = (company: string, contact: string, email: string, phone: string, project: string, sets: number, rate: number): QuoteSpec =>
    ({ company, contact, email, phone, project, sets, rate, disc: 0, freight: Math.round(sets * 700 / 1000) * 1000, terms: '45 days from dispatch', bom: bomLines });
  const l1 = open('Kutch Ceramic Tiles Pvt Ltd', 'Mehul Thakkar', 'mehul@kutchceramic.example', '+91 00000 12877', '1.5 MWp ground mount, Morbi', 70, 0);
  on(2); A().addLead({ company: l1.company, contact: l1.contact, email: l1.email, phone: l1.phone, project: l1.project, estValue: 6500000, owner: OWNER, nextFollowUp: D(-3), stage: 'New' });
  on(1); A().addLead({ company: 'Latur Agro Cold Storage', contact: 'Pooja Kale', email: 'pooja.kale@laturcold.example', phone: '+91 00000 13014', project: '350 kWp rooftop, Latur', estValue: 1800000, owner: OWNER, nextFollowUp: D(-5), stage: 'New' });
  on(14); A().addLead({ company: 'Satara Agro Exports LLP', contact: 'Ajinkya Bhosale', email: 'ajinkya@sataraagro.example', phone: '+91 00000 13151', project: '1.2 MWp ground mount, Koregaon', estValue: 5400000, owner: OWNER, nextFollowUp: D(-2), stage: 'Warm' });

  const hot = open('Vidisha Packaging Industries', 'Saurabh Jain', 'saurabh@vidishapack.example', '+91 00000 13288', '1.0 MWp rooftop, Mandideep', 48, 82500);
  const lh = leadOf(hot, 17, 'Hot', D(-1));
  await quoteFor(lh, hot, 6, 5, false);
  const qs1 = open('Konark Logistics Parks Pvt Ltd', 'Debashish Rout', 'debashish@konarklogistics.example', '+91 00000 13425', '2.0 MWp warehouse rooftops, Chakan', 95, 79900);
  const lq1 = leadOf(qs1, 24, 'Hot', D(-2));
  await quoteFor(lq1, qs1, 13, 9);
  on(9); A().updateLead(lq1.id, { nextFollowUp: D(-2) });
  const qs2 = open('Wardha Cotton Ginning Mills', 'Nitin Wankhede', 'nitin@wardhaginning.example', '+91 00000 13562', '800 kWp captive plant, Hinganghat', 38, 82800);
  const lq2 = leadOf(qs2, 18, 'Warm', D(-4));
  await quoteFor(lq2, qs2, 8, 4);
  const neg = open('Sindhudurg Beach Resorts Pvt Ltd', 'Elena D’Souza', 'elena@sindhudurgresorts.example', '+91 00000 13699', '450 kWp carport & rooftop, Tarkarli', 26, 86500);
  const ln = leadOf(neg, 32, 'Hot', D(-1));
  await quoteFor(ln, neg, 22, 18);
  on(10); A().setLeadStage(ln.id, 'Negotiation');
}

/* ------------------------------------------------------------------ part 2: additions for the restored views */

// Simulated users with fixed ids (matched by id on merge, so they are added once).
const PART2_USERS: User[] = [
  { id: 'u_anita', name: 'Anita Rao', role: 'user', title: 'Sales executive', email: 'anita@sunframe.example', department: 'Sales' },
  { id: 'u_imran', name: 'Imran Sheikh', role: 'user', title: 'Stores in-charge', email: 'imran@sunframe.example', department: 'Stores' },
  { id: 'u_kavita', name: 'Kavita Joshi', role: 'user', title: 'Accounts executive', email: 'kavita@sunframe.example', department: 'Accounts' },
];

async function part2(st: Sandbox, today: ISODate) {
  // Users first, so they can act in the scenario below.
  st.setState(s => ({ db: { ...s.db, users: [...s.db.users, ...PART2_USERS.filter(u => !s.db.users.some(x => x.id === u.id)).map(u => ({ ...u }))] } }));
  const { A, db, D, on, file, mat, sup, quotation, poPdf, receive, payVendor, leadOf, quoteFor, sell, produce, dispatch, receipt, drawing } = makeKit(st, today);
  const original = db().currentUserId;

  /* -------- ZM-coated product line: its own materials, so existing stock and reservations are untouched */
  on(130);
  const M = {
    zm: mat('ZM coil 2.0 mm · ZM310 (Zn-Al-Mg)', 'Steel coil', 'kg', 9500),
    ss: mat('SS304 hex bolt set M10 × 30', 'Fasteners', 'pcs', 6800),
    clamp: mat('Module clamp kit · Al 6063 (mid/end)', 'Other', 'pcs', 2600),
  };
  const zmBom: BomFn = n => [{ id: 'z0', materialId: M.zm.id, qty: 82 * n }, { id: 'z1', materialId: M.ss.id, qty: 26 * n }, { id: 'z2', materialId: M.clamp.id, qty: 8 * n }];
  // Existing suppliers are used by name when present and active; otherwise a new supplier record is added.
  const findSup = (name: string) => db().suppliers.find(s => s.active && s.name === name);
  const coil = findSup('Bharat Coil & Steel Traders')
    ?? sup('Bharat Coil & Steel Traders', '27AAFCB4412M1Z3', 'Rakesh Jadhav', '+91 00000 10137', 'sales@bharatcoilsteel.example', 'Steel coil');
  const alu = sup('Deccan Aluminium Extrusions', '27AADCD6610L1Z5', 'Shreyas Kulkarni', '+91 00000 13836', 'sales@deccanalu.example', 'Other');

  // Opening ZM coil purchase (no PR): quotation → approved PO → GRN → payable paid by accounts.
  const qZm = await quotation(coil.id, 'Steel coil', 'BCST/Q/26-27/0215', 79, [[M.zm.id, 6000, 74.5]]);
  on(76);
  const poZm = A().savePO({ supplierId: coil.id, lines: [{ id: 'zl0', materialId: M.zm.id, qty: 6000, rate: 74.5 }], expectedDelivery: D(72), paymentTermsDays: 30, quotationIds: [qZm] });
  await poPdf(poZm.id);
  await receive(poZm.id, 72, true, 'u_imran', 'Imran Sheikh');
  await payVendor(p => p.poId === poZm.id, 48, 'full', 'HDFCR52026082011473', 'u_kavita');

  /* -------- repeat business: second projects for existing accounts */
  const zm = (o: Omit<OrderSpec, 'bom' | 'product'>): OrderSpec => ({ ...o, bom: zmBom, product: `ZM fixed-tilt MMS — ${o.project.split(',')[0]}` });
  const malwa = zm({ company: 'Malwa Weaving Mills Pvt Ltd', contact: 'Neha Agrawal', email: 'neha.agrawal@malwaweaving.example', phone: '+91 00000 11096', project: '520 kWp warehouse rooftop, Pithampur', site: 'Sector 3, Industrial Area, Pithampur, Dhar, MP 454775', sets: 26, rate: 88600, disc: 0, freight: 21000, terms: '45 days from dispatch', cpoNo: 'MWM/ENGG/PO/1012', mo: 60, transport: ['MP 09 HG 7314', 'Indore Golden Transport', 'Raju Yadav'], owner: 'Anita Rao' });
  const tapi = zm({ company: 'Tapi Agro Foods Pvt Ltd', contact: 'Manish Chaudhari', email: 'manish@tapiagrofoods.example', phone: '+91 00000 11918', project: '400 kWp cold-store rooftop, Jalgaon', site: 'E-34, MIDC Area, Jalgaon 425003', sets: 20, rate: 89200, disc: 0, freight: 16000, terms: '30 days from dispatch', cpoNo: 'TAF/26/PO/402', mo: 40, owner: 'Anita Rao' });
  const aravali = zm({ company: 'Aravali Greenfield Energy Pvt Ltd', contact: 'Rohan Mehta', email: 'rohan.mehta@aravaligreenfield.example', phone: '+91 00000 10822', project: '2.6 MWp ground mount phase 2, Phalodi', site: 'Survey no. 214, Bap road, Phalodi, Jodhpur, Rajasthan 342301', sets: 110, rate: 86400, disc: 1.5, freight: 64000, terms: '45 days from dispatch', cpoNo: 'AGE/PO/26-27/0587', mo: 30, negotiated: true, drawing: true });
  const narmada = zm({ company: 'Narmada Cold Chain Pvt Ltd', contact: 'Jignesh Bhatt', email: 'jignesh@narmadacoldchain.example', phone: '+91 00000 11370', project: '600 kWp warehouse rooftop, Dahej', site: 'Plot D-2/18, GIDC Dahej, Bharuch, Gujarat 392130', sets: 30, rate: 88900, disc: 0, freight: 22000, terms: '45 days from dispatch', cpoNo: 'NCC-PO-2671', mo: 16 });
  const shivneri = zm({ company: 'Shivneri Solar Parks LLP', contact: 'Prakash Gaikwad', email: 'prakash@shivnerisolar.example', phone: '+91 00000 10959', project: '1.4 MWp extension, Supa MIDC', site: 'Plot E-8, Supa-Parner MIDC, Ahmednagar 414301', sets: 65, rate: 87100, disc: 1, freight: 41000, terms: '60 days from dispatch', cpoNo: 'SSP-PUR-2694', mo: 14 });
  const krishna = zm({ company: 'Krishna Valley Dairy Pvt Ltd', contact: 'Vikram Patil', email: 'vikram.patil@krishnavalleydairy.example', phone: '+91 00000 11781', project: '360 kWp chilling-centre rooftop, Karad', site: 'Plot 21, Karad-Masur road, Karad, Satara 415110', sets: 18, rate: 89900, disc: 0, freight: 15000, terms: '30 days from dispatch', cpoNo: 'KVD/PO/0318', mo: 3, owner: 'Anita Rao' });

  // Malwa: produced on Line 2 (issued by stores) → FG → dispatched with POD → part-paid receivable.
  const m1 = await sell(malwa); produce(m1.moId, 'Line 2', 58, 57, 7, 47, 'u_imran');
  const dm = await dispatch(malwa, m1.moId, 44, 41);
  await receipt(dm, 8, 1200000, 'AXIS626092966125', 'u_kavita');
  // Tapi: produced on Line 1 → finished goods ready, waiting in the dispatch queue.
  const t1 = await sell(tapi); produce(t1.moId, 'Line 1', 38, 36, 7, 4, 'u_imran');
  // Aravali phase 2: issued on Line 2 and in production.
  const a1 = await sell(aravali); produce(a1.moId, 'Line 2', 28, 26, 2, 9, 'u_imran');
  // Narmada (Dahej): fully reserved, waiting in the unassigned queue.
  await sell(narmada);

  // Shivneri extension: ZM coil short → shortage PR → admin rounds to coil lots → PO (60 days) → GRN → reserved → issued on Line 1.
  const s1 = await sell(shivneri);
  on(13);
  const prS = db().prs.find(p => p.moId === s1.moId)!;
  A().updatePRLines(prS.id, prS.lines.map(l => ({ ...l, qty: Math.ceil(l.qty / 500) * 500 })));
  const poSd = A().approvePR(prS.id);
  const qZm2 = await quotation(coil.id, 'Steel coil', 'BCST/Q/26-27/0391', 13, [[M.zm.id, 5500, 74.2]]);
  on(12);
  const poS = A().savePO({ id: poSd.id, supplierId: coil.id, lines: poSd.lines.map(l => ({ ...l, rate: 74.2 })), expectedDelivery: D(7), paymentTermsDays: 60, quotationIds: [qZm2] });
  await poPdf(poS.id);
  await receive(poS.id, 6, true, 'u_imran', 'Imran Sheikh');
  produce(s1.moId, 'Line 1', 5, 4, 1, 2, 'u_imran');

  // Krishna Valley chilling centre: competes for the remaining ZM coil and SS bolts → partly reserved, shortage PR pending.
  await sell(krishna);

  // Clamp kits: stores raises a PR → approved → PO to the aluminium supplier, awaiting delivery.
  const qAlu = await quotation(alu.id, 'Other', 'DAE/QTN/26/0873', 11, [[M.clamp.id, 1200, 64]]);
  on(10, 'u_imran');
  const prClamp = A().addPR({ lines: [{ materialId: M.clamp.id, qty: 1200 }], requiredBy: D(-6), notes: 'Clamp kits for Narmada (Dahej) and Krishna Valley dispatches' });
  on(9); const poCd = A().approvePR(prClamp.id);
  const poC = A().savePO({ id: poCd.id, supplierId: alu.id, lines: poCd.lines.map(l => ({ ...l, rate: 64 })), expectedDelivery: D(-3), paymentTermsDays: 30, quotationIds: [qAlu] });
  await poPdf(poC.id);
  // Sales executive's own request (visible to her and to the admin only).
  on(2, 'u_anita');
  A().addPR({ lines: [{ materialId: M.ss.id, qty: 200 }], requiredBy: D(-9), notes: 'SS bolt sets for the sample table at the Godavari Waluj site visit' });

  /* -------- open pipeline on existing accounts */
  const openZm = (o: Omit<QuoteSpec, 'bom' | 'product' | 'disc' | 'freight'>): QuoteSpec => ({ ...o, disc: 0, freight: Math.round(o.sets * 700 / 1000) * 1000, bom: zmBom, product: `ZM fixed-tilt MMS — ${o.project.split(',')[0]}` });
  const godavari = openZm({ company: 'Godavari Pipes & Polymers Ltd', contact: 'Kiran Reddy', email: 'kiran.reddy@godavaripipes.example', phone: '+91 00000 11507', project: '700 kWp Unit 2 rooftop, Waluj', sets: 34, rate: 88200, terms: '60 days from dispatch', owner: 'Anita Rao' });
  const lg = leadOf(godavari, 21, 'Hot', D(-2));
  await drawing(lg, 15);
  await quoteFor(lg, godavari, 13, 11);
  on(5); A().setLeadStage(lg.id, 'Negotiation');
  const sahyadri = openZm({ company: 'Sahyadri Care Hospitals Trust', contact: 'Dr. Aparna Joshi', email: 'projects@sahyadricare.example', phone: '+91 00000 11644', project: '300 kWp carport, Aundh', sets: 16, rate: 91500, terms: '30 days from dispatch', owner: 'Anita Rao' });
  const ls = leadOf(sahyadri, 9, 'Hot', D(-1));
  await quoteFor(ls, sahyadri, 3, 2, false);
  on(4, 'u_anita'); A().addLead({ company: 'Konkan Agro Processors Pvt Ltd', contact: 'Siddharth Sawant', email: 'siddharth@konkanagro.example', phone: '+91 00000 11233', project: '450 kWp cold-store rooftop, Lote', estValue: 2400000, owner: 'Anita Rao', nextFollowUp: D(-4), stage: 'New' });
  on(12); A().addLead({ company: 'Bhimashankar Sugar Industries Ltd', contact: 'Sandeep More', email: 'sandeep.more@bhimashankarsugar.example', phone: '+91 00000 12466', project: '1.0 MWp distillery rooftop, Manchar', estValue: 5200000, owner: OWNER, nextFollowUp: D(-6), stage: 'Warm' });

  /* -------- licences and statutory certificates */
  const licence = async (name: string, number: string, issuer: string, uploadedDaysAgo: number, expiry: ISODate | '') => {
    on(uploadedDaysAgo);
    const blob = paper({ from: [issuer, 'Government / certifying authority'], title: name.toUpperCase(), ref: number, date: D(uploadedDaysAgo + 3),
      kv: [['Issued to', 'SunFrame (solar mounting structures)'], ['Premises', 'Plot 14, MIDC Chakan Phase II, Pune 410501'], ['Valid until', expiry ? fmtDate(expiry) : 'No expiry (lifetime registration)']],
      note: 'Fictional sample document for the SunFrame ERP prototype.' });
    A().addDocument({ name, file: await file(blob, `${number.replace(/[/\s]/g, '-')}.pdf`), partyType: 'none', partyName: '', category: 'Licence', linkedRef: number, expiry });
  };
  await licence('Factory licence', 'MH/PN/FL/2024/18632', 'Directorate of Industrial Safety & Health, Maharashtra', 290, D(-255));
  await licence('Consent to operate (air & water)', 'MPCB-CTO-GR-2023-0911', 'Maharashtra Pollution Control Board', 340, D(-38));
  await licence('Fire NOC', 'PMRDA/FIRE/NOC/2025/0417', 'PMRDA Fire Services', 370, D(12));
  await licence('Udyam registration (MSME)', 'UDYAM-MH-26-0148392', 'Ministry of MSME', 400, '');
  await licence('ISO 9001:2015 certificate', 'QMS/IN/26/41872', 'Certification body (accredited)', 150, D(-520));

  /* -------- HRMS: employees, leave, payroll (totals only) */
  on(110);
  const emp = (name: string, department: string, designation: string, lineShift: string, phone: string, joinedOn: ISODate, monthlySalary: number) =>
    A().saveEmployee({ name, department, designation, lineShift, phone, joinedOn, monthlySalary, status: 'Active' });
  const E = {
    dinesh: emp('Dinesh Patil', 'Production', 'Production supervisor', 'Line 1 · General', '+91 00000 13973', '2019-06-03', 52000),
    meera: emp('Meera Iyer', 'Purchase', 'Purchase executive', '—', '+91 00000 14110', '2021-01-11', 46000),
    imran: emp('Imran Sheikh', 'Stores', 'Stores in-charge', 'General', '+91 00000 14247', '2020-08-17', 34000),
    kavita: emp('Kavita Joshi', 'Accounts', 'Accounts executive', '—', '+91 00000 14384', '2022-04-04', 42000),
    anita: emp('Anita Rao', 'Sales', 'Sales executive', '—', '+91 00000 14521', '2023-02-01', 48000),
    rakesh: emp('Rakesh Yadav', 'Production', 'Roll-forming operator', 'Line 2 · Shift B', '+91 00000 14658', '2021-09-20', 24000),
    sunil: emp('Sunil Gawade', 'Production', 'Welder', 'Line 1 · Shift A', '+91 00000 14795', '2022-11-07', 26500),
    pradeep: emp('Pradeep Kamble', 'Production', 'Machine operator', 'Line 2 · Shift A', '+91 00000 14932', '2023-07-24', 25000),
  };
  const run = (daysAgo: number, month: string, deductions: number, complete: boolean, notes = '') => {
    on(daysAgo); const r = A().createPayrollRun({ month, deductions, notes });
    if (complete) { on(daysAgo - 2); A().completePayrollRun(r.id); }
  };
  run(98, '2026-06', 29800, true, 'Salaries credited on 3 Jul');
  run(67, '2026-07', 30150, true, 'Salaries credited on 2 Aug');
  on(58);
  const swati = emp('Swati Kulkarni', 'Quality', 'Quality inspector', 'General', '+91 00000 15069', D(58), 30000);
  const ganesh = emp('Ganesh Pawar', 'Production', 'Helper (contract)', 'Line 2 · Shift A', '+91 00000 15206', D(58), 16500);
  run(36, '2026-08', 34400, true, 'Includes two joiners from 10 Aug');
  on(20); A().saveEmployee({ ...E.rakesh, status: 'On notice' });
  run(5, '2026-09', 34950, false, 'Draft — overtime for Line 2 to be confirmed');
  void swati;

  const leave = (daysAgo: number, by: string, e: { id: ID }, type: 'Casual' | 'Sick' | 'Earned', from: number, to: number, reason: string, decide?: { daysAgo: number; status: 'Approved' | 'Rejected' }) => {
    on(daysAgo, by);
    const l = A().addLeave({ employeeId: e.id, type, from: D(from), to: D(to), reason });
    if (decide) { on(decide.daysAgo); A().decideLeave(l.id, decide.status); }
  };
  leave(40, 'u_dinesh', E.sunil, 'Casual', 33, 32, 'Family function in Satara', { daysAgo: 39, status: 'Approved' });
  leave(19, 'u_dinesh', E.pradeep, 'Sick', 19, 19, 'Fever — medical certificate submitted', { daysAgo: 18, status: 'Approved' });
  leave(15, 'u_dinesh', E.rakesh, 'Earned', 9, 7, 'Personal work during notice period', { daysAgo: 14, status: 'Rejected' });
  leave(3, 'u_imran', E.imran, 'Casual', -6, -6, 'Bank and property paperwork');
  leave(2, 'u_kavita', E.kavita, 'Earned', -11, -14, 'Diwali travel to Nagpur');
  void ganesh; void E.meera; void E.anita; void E.dinesh;

  // Leave the selected user as it was.
  if (db().currentUserId !== original) A().setUser(original);
  void tapi; void t1; void a1;
}

/* ------------------------------------------------------------------ part 3: lost deals */

/** New fictional leads that end in Lost. Two went as far as a sent quote (using the part-2 ZM materials when present). */
async function part3(st: Sandbox, today: ISODate) {
  const { A, db, D, on, leadOf, quoteFor } = makeKit(st, today);
  const original = db().currentUserId;
  const find = (prefix: string) => db().materials.find(m => m.name.startsWith(prefix));
  const zm = find('ZM coil 2.0 mm'), ss = find('SS304 hex bolt set'), clamp = find('Module clamp kit');
  const bom: BomFn | null = zm && ss && clamp
    ? n => [{ id: 'z0', materialId: zm.id, qty: 82 * n }, { id: 'z1', materialId: ss.id, qty: 26 * n }, { id: 'z2', materialId: clamp.id, qty: 8 * n }]
    : null;
  const spec = (o: Omit<QuoteSpec, 'bom' | 'disc' | 'freight' | 'product'>): QuoteSpec =>
    ({ ...o, disc: 0, freight: Math.round(o.sets * 700 / 1000) * 1000, bom: bom ?? (() => []), product: `ZM fixed-tilt MMS — ${o.project.split(',')[0]}` });
  const lose = (id: ID, daysAgo: number) => { on(daysAgo); A().setLeadStage(id, 'Lost'); };

  // Quoted, negotiated, lost on price.
  const vid = spec({ company: 'Vidarbha Spinning Mills Pvt Ltd', contact: 'Ashish Deshmukh', email: 'ashish.d@vidarbhaspinning.example', phone: '+91 00000 15343', project: '800 kWp mill rooftop, Butibori', sets: 40, rate: 87800, terms: '45 days from dispatch', owner: OWNER });
  const lv = leadOf(vid, 64, 'Warm');
  on(58); A().setLeadStage(lv.id, 'Hot');
  if (bom) { await quoteFor(lv, vid, 55, 52); on(44); A().setLeadStage(lv.id, 'Negotiation'); }
  lose(lv.id, 37);

  // Quoted, client went with an in-house fabricator.
  const san = spec({ company: 'Sangli Grape Processors Co-op Ltd', contact: 'Rahul Shinde', email: 'projects@sangligrape.example', phone: '+91 00000 15480', project: '500 kWp ground mount, Tasgaon', sets: 25, rate: 86900, terms: '30 days from dispatch', owner: 'Anita Rao' });
  const lsg = leadOf(san, 49, 'Hot');
  if (bom) await quoteFor(lsg, san, 46, 44);
  lose(lsg.id, 26);

  // Never reached a quote.
  on(41); const c = A().addLead({ company: 'Ratnagiri Coastal Ice & Cold Storage', contact: 'Faiz Mulla', email: 'faiz@ratnagiricoastalice.example', phone: '+91 00000 15617', project: '250 kWp cold-store rooftop, Mirjole', estValue: 1300000, owner: 'Anita Rao', nextFollowUp: '', stage: 'New' });
  on(35); A().setLeadStage(c.id, 'Warm');
  lose(c.id, 19);
  on(33); const n = A().addLead({ company: 'Nashik Auto Pressings Pvt Ltd', contact: 'Vaibhav Kulkarni', email: 'vaibhav.k@nashikautopressings.example', phone: '+91 00000 15754', project: '1.2 MWp plant rooftop, Ambad MIDC', estValue: 6100000, owner: OWNER, nextFollowUp: '', stage: 'Warm' });
  on(27); A().setLeadStage(n.id, 'Hot');
  lose(n.id, 12);
  on(15); const k = A().addLead({ company: 'Kolhapur Precision Foundry Works', contact: 'Suresh Chougule', email: 'suresh@kolhapurfoundry.example', phone: '+91 00000 15891', project: '650 kWp foundry shed rooftop, Shiroli', estValue: 3400000, owner: OWNER, nextFollowUp: '', stage: 'New' });
  lose(k.id, 6);

  void D;
  if (db().currentUserId !== original) A().setUser(original);
}
