import { create, createStore, type StateCreator } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DB, ID, Lead, LeadStage, Material, Bom, BomLine, Quote, ClientPO, SalesOrder, ManufacturingOrder,
  PurchaseRequest, PRLine, Supplier, SupplierPO, POLine, FileMeta, DocCategory, DocumentRec, StageDef,
  Payment, PriceLine, Dispatch, Settings, DocRefType, User, Employee, LeaveRequest, PayrollRun,
} from './lib/types';
import { OPEN_STAGES, LEAD_STAGES } from './lib/types';
import { uid, nowDate, todayISO, addDays, parseTermsDays, quoteTotals, linesSubtotal, round3, qty as fq } from './lib/format';

/* ------------------------------------------------------------------ defaults */

export const FIXED_FIRST_STAGE = 'st_issue';
export const FIXED_LAST_STAGE = 'st_fg';

const defaultStages = (): StageDef[] => [
  { id: FIXED_FIRST_STAGE, name: 'Material issue', group: 'Material issue' },
  { id: 'st_slit', name: 'Slitting', group: 'Production' },
  { id: 'st_roll', name: 'Roll forming', group: 'Production' },
  { id: 'st_cut', name: 'Cutting', group: 'Production' },
  { id: 'st_punch', name: 'Punching', group: 'Production' },
  { id: 'st_weld', name: 'Welding', group: 'Production' },
  { id: 'st_galv', name: 'Galvanizing', group: 'Production' },
  { id: 'st_pack', name: 'Packaging', group: 'Packaging' },
  { id: FIXED_LAST_STAGE, name: 'Finished goods ready', group: 'Finished goods' },
];

export const emptySettings = (): Settings => ({
  legalName: '', address: '', gstin: '', contact: '',
  quoteTerms: '', quotePaymentTerms: '', quoteDeliveryTerms: '', poNotes: '',
});

const DEFAULT_USERS: User[] = [
  { id: 'u_admin', name: 'Abhineet Suryawanshi', role: 'admin', title: 'Admin · Founder', email: 'abhineet@sunframe.example', department: 'Management' },
  { id: 'u_meera', name: 'Meera Iyer', role: 'user', title: 'Purchase executive', email: 'meera@sunframe.example', department: 'Purchase' },
  { id: 'u_dinesh', name: 'Dinesh Patil', role: 'user', title: 'Production supervisor', email: 'dinesh@sunframe.example', department: 'Production' },
];

export const emptyDB = (): DB => ({
  version: 4,
  counters: {},
  users: [
    ...DEFAULT_USERS.map(u => ({ ...u })),
  ],
  currentUserId: 'u_admin',
  stages: defaultStages(),
  leads: [], materials: [], boms: [], quotes: [], clientPOs: [], salesOrders: [], mos: [],
  reservations: [], prs: [], suppliers: [], supplierQuotations: [], supplierPOs: [], grns: [],
  fgItems: [], dispatches: [], receivables: [], payables: [], documents: [], activities: [],
  materialIssues: [], employees: [], leaves: [], payrollRuns: [],
  settings: emptySettings(),
});

/** Lead reached through a supplier PO → PR → MO chain (if the PO was raised for an MO shortfall). */
export function leadIdForPO(db: DB, poId?: ID) {
  const po = db.supplierPOs.find(p => p.id === poId);
  const pr = po?.prId ? db.prs.find(x => x.id === po.prId) : undefined;
  return pr?.moId ? db.mos.find(m => m.id === pr.moId)?.leadId : undefined;
}

/** Upgrade data saved by older versions in place: settings + explicit stable-id links on documents. Idempotent. */
export function migrateDB(db: DB): DB {
  db.settings = { ...emptySettings(), ...(db.settings ?? {}) };
  // v3: material-issue register and HRMS lists start empty (issue events are never inferred from old MOs).
  db.materialIssues ??= []; db.employees ??= []; db.leaves ??= []; db.payrollRuns ??= [];
  // Fill missing email/department on the built-in users only; names and roles the user changed are kept.
  for (const d of DEFAULT_USERS) { const u = db.users.find(x => x.id === d.id); if (u) { u.email ??= d.email; u.department ??= d.department; } }
  const link = (docId: ID | undefined, l: Partial<DocumentRec>) => {
    const d = docId ? db.documents.find(x => x.id === docId) : undefined;
    if (d && !d.refType) Object.assign(d, l);
  };
  for (const c of db.clientPOs) link(c.documentId, { leadId: c.leadId, refType: 'cpo', refId: c.id });
  for (const so of db.salesOrders) link(so.documentId, { leadId: so.leadId, refType: 'so', refId: so.id });
  for (const q of db.quotes) for (const d of db.documents)
    if (!d.refType && d.category === 'Quote' && d.source === 'Generated' && d.linkedRef === q.ref) Object.assign(d, { leadId: q.leadId, refType: 'quote', refId: q.id });
  for (const q of db.supplierQuotations) link(q.documentId, { supplierId: q.supplierId, refType: 'quotation', refId: q.id });
  for (const po of db.supplierPOs) link(po.documentId, { supplierId: po.supplierId ?? undefined, leadId: leadIdForPO(db, po.id), refType: 'po', refId: po.id });
  for (const g of db.grns) { const po = db.supplierPOs.find(p => p.id === g.poId); link(g.documentId, { supplierId: po?.supplierId ?? undefined, leadId: leadIdForPO(db, g.poId), refType: 'grn', refId: g.id }); }
  for (const d of db.dispatches) link(d.podDocumentId, { leadId: d.leadId, refType: 'dispatch', refId: d.id });
  for (const r of db.receivables) for (const p of r.payments) link(p.documentId, { leadId: r.leadId, refType: 'receivable', refId: r.id });
  for (const r of db.payables) for (const p of r.payments) link(p.documentId, { supplierId: r.supplierId, leadId: leadIdForPO(db, r.poId), refType: 'payable', refId: r.id });
  // v4: CRM stage "Lost" added. Normalise stage labels saved by older builds or imports; unknown values fall back to New.
  const known = new Set<string>(LEAD_STAGES);
  const alias: Record<string, LeadStage> = { won: 'Closed', 'closed (won)': 'Closed', closed: 'Closed', lost: 'Lost', 'closed (lost)': 'Lost' };
  for (const l of db.leads ?? []) if (!known.has(l.stage)) l.stage = alias[String(l.stage ?? '').trim().toLowerCase()] ?? 'New';
  db.version = 4;
  return db;
}

/* ------------------------------------------------------------------ selectors */

export const currentUser = (db: DB) => db.users.find(u => u.id === db.currentUserId) ?? db.users[0];
export const isAdmin = (db: DB) => currentUser(db).role === 'admin';
export const materialById = (db: DB, id: ID) => db.materials.find(m => m.id === id);
export const reservedQty = (db: DB, materialId: ID) =>
  round3(db.reservations.filter(r => r.materialId === materialId && r.status === 'Reserved').reduce((a, r) => a + r.qty, 0));
export const availableQty = (db: DB, materialId: ID) => {
  const m = materialById(db, materialId);
  return m ? round3(Math.max(0, m.onHand - reservedQty(db, materialId))) : 0;
};
export const bomForLead = (db: DB, leadId: ID) => db.boms.find(b => b.leadId === leadId);
export const quoteForLead = (db: DB, leadId: ID) => db.quotes.find(q => q.leadId === leadId);
export const clientPoForLead = (db: DB, leadId: ID) => db.clientPOs.find(p => p.leadId === leadId);
export const soForLead = (db: DB, leadId: ID) => db.salesOrders.find(s => s.leadId === leadId);
export const moForLead = (db: DB, leadId: ID) => db.mos.find(m => m.leadId === leadId);
export const leadById = (db: DB, id?: ID) => db.leads.find(l => l.id === id);
export const supplierById = (db: DB, id?: ID | null) => db.suppliers.find(s => s.id === id);
export const stageIndex = (db: DB, stageId: ID) => db.stages.findIndex(s => s.id === stageId);

/** Deal value used for the pipeline: latest quote total if one exists, otherwise the estimate. */
export function leadValue(db: DB, lead: Lead): number {
  const q = quoteForLead(db, lead.id);
  if (q) { const t = quoteTotals(q).total; if (t > 0) return t; }
  return lead.estValue ?? 0;
}

/** For an MO: per-material required / reserved / issued, and whether it can be issued. */
export function moMaterialStatus(db: DB, mo: ManufacturingOrder) {
  const rows = mo.requirements.map(r => {
    const m = materialById(db, r.materialId);
    const res = db.reservations.find(x => x.moId === mo.id && x.materialId === r.materialId);
    const reserved = res && res.status === 'Reserved' ? res.qty : 0;
    const issued = res && res.status === 'Issued' ? res.qty : 0;
    const shortfall = mo.materialsIssued ? 0 : round3(Math.max(0, r.required - reserved));
    return { material: m, materialId: r.materialId, required: r.required, reserved, issued, shortfall,
      onHand: m?.onHand ?? 0, available: availableQty(db, r.materialId) };
  });
  const ready = mo.materialsIssued || rows.every(r => r.shortfall === 0);
  return { rows, ready, shortCount: rows.filter(r => r.shortfall > 0).length };
}

/** PRs raised for an MO's shortfall. */
export const prsForMO = (db: DB, moId: ID) => db.prs.filter(p => p.moId === moId);

/**
 * Per material: shortfall not yet covered by anything in the procurement pipeline
 * (pending PRs, or approved PRs whose PO hasn't been received). Rejected PRs and
 * quantities cut at approval are therefore visible here.
 */
export function moOpenShortfall(db: DB, mo: ManufacturingOrder) {
  const st = moMaterialStatus(db, mo);
  const pipe = new Map<ID, number>();
  for (const pr of prsForMO(db, mo.id)) {
    if (pr.status === 'Rejected') continue;
    const po = pr.poId ? db.supplierPOs.find(x => x.id === pr.poId) : undefined;
    if (po?.receiptStatus === 'Received') continue;
    for (const l of pr.lines) pipe.set(l.materialId, round3((pipe.get(l.materialId) ?? 0) + l.qty));
  }
  return st.rows.filter(r => r.shortfall > 0).map(r => ({ ...r, inPipeline: pipe.get(r.materialId) ?? 0, uncovered: round3(Math.max(0, r.shortfall - (pipe.get(r.materialId) ?? 0))) }))
    .filter(r => r.uncovered > 0);
}

/** Whether the SO carries a line matching the BOM output (same unit and quantity). */
export function soBomMatch(so: SalesOrder, bom: Bom) {
  const same = so.lines.find(l => l.unit === bom.outputUnit && Math.abs(l.qty - bom.outputQty) < 0.0005);
  const sameUnit = so.lines.filter(l => l.unit === bom.outputUnit);
  return { matched: !!same, suggestedQty: same?.qty ?? (sameUnit.length === 1 ? sameUnit[0].qty : bom.outputQty) };
}

export function receivableBalance(r: { amount: number; payments: Payment[] }) {
  const paid = round2(r.payments.reduce((a, p) => a + p.amount, 0));
  const outstanding = round2(Math.max(0, r.amount - paid));
  const status = paid <= 0 ? 'Pending' : outstanding <= 0.004 ? 'Paid' : 'Partially paid';
  return { paid, outstanding, status: status as 'Pending' | 'Partially paid' | 'Paid' };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export function poTotal(po: SupplierPO) { return round2(po.lines.reduce((a, l) => a + (+l.qty || 0) * (+l.rate || 0), 0)); }

export type StepKey = 'bom' | 'quote' | 'cpo' | 'so' | 'mo';
export function salesSteps(db: DB, lead: Lead) {
  const bom = bomForLead(db, lead.id), quote = quoteForLead(db, lead.id), cpo = clientPoForLead(db, lead.id);
  const so = soForLead(db, lead.id), mo = moForLead(db, lead.id);
  const steps: { key: StepKey; label: string; done: boolean; ref?: string; blocked?: string }[] = [
    { key: 'bom', label: 'BOM', done: !!bom, ref: bom?.ref },
    { key: 'quote', label: 'Quote', done: quote?.status === 'Quote sent', ref: quote ? `${quote.ref}${quote.version > 1 ? ' v' + quote.version : ''}` : undefined,
      blocked: bom ? undefined : 'Save a BOM first — the quote is generated from it.' },
    { key: 'cpo', label: 'Client PO', done: !!cpo, ref: cpo?.poNumber,
      blocked: lead.stage === 'Lost' ? 'This deal is marked lost. Reopen it in CRM to continue.' : lead.stage !== 'Closed' ? 'Close the deal as won before entering the Client PO.' : undefined },
    { key: 'so', label: 'SO', done: !!so, ref: so?.ref, blocked: cpo ? undefined : 'Enter the Client PO first — the SO is pre-filled from it.' },
    { key: 'mo', label: 'MO', done: !!mo, ref: mo?.ref,
      blocked: !so ? 'Generate the sales order first.' : !bom ? 'A saved BOM is needed for material requirements.' : undefined },
  ];
  return steps;
}

/** Overall operational status of a sales record — one short label. */
export function salesStatus(db: DB, lead: Lead): string {
  const mo = moForLead(db, lead.id);
  const disp = mo ? db.dispatches.find(d => d.moId === mo.id) : undefined;
  if (disp?.receivableId) {
    const rec = db.receivables.find(r => r.id === disp.receivableId);
    if (rec) { const b = receivableBalance(rec); return b.status === 'Paid' ? 'Paid' : 'Dispatched'; }
  }
  if (disp) return 'Ready to dispatch';
  if (mo) {
    if (!mo.line) return 'MO in queue';
    return db.stages.find(s => s.id === mo.stageId)?.name ?? 'In production';
  }
  if (soForLead(db, lead.id)) return 'SO confirmed';
  if (clientPoForLead(db, lead.id)) return 'Client PO received';
  if (lead.stage === 'Closed') return 'Won — awaiting Client PO';
  if (lead.stage === 'Lost') return 'Lost';
  const q = quoteForLead(db, lead.id);
  if (q) return q.status === 'Quote sent' ? 'Quote sent' : 'Quote draft';
  if (bomForLead(db, lead.id)) return 'BOM saved';
  return 'Not started';
}

/* ------------------------------------------------------------------ store */

type Mut = (db: DB) => void;
interface Store {
  db: DB;
  // generic
  setUser: (id: ID) => void;
  reset: () => void;
  saveSettings: (s: Settings) => void;
  // CRM
  addLead: (i: Omit<Lead, 'id' | 'ref' | 'stage' | 'createdAt'> & { stage?: LeadStage }) => Lead;
  updateLead: (id: ID, p: Partial<Lead>) => void;
  setLeadStage: (id: ID, stage: LeadStage) => void;
  // materials / inventory
  addMaterial: (i: Omit<Material, 'id' | 'code' | 'onHand'> & { code?: string; onHand?: number }) => Material;
  adjustStock: (materialId: ID, newOnHand: number, note: string) => void;
  // sales
  saveBom: (leadId: ID, b: { productName: string; outputQty: number; outputUnit: string; lines: BomLine[]; notes: string }) => Bom;
  saveQuote: (leadId: ID, q: Omit<Quote, 'id' | 'ref' | 'leadId' | 'bomId' | 'version' | 'status' | 'sentAt'>) => Quote;
  markQuoteSent: (quoteId: ID, pdf?: FileMeta) => void;
  reviseQuote: (quoteId: ID) => void;
  saveClientPO: (leadId: ID, p: Omit<ClientPO, 'id' | 'leadId' | 'createdAt' | 'documentId'>) => ClientPO;
  createSO: (leadId: ID, s: Omit<SalesOrder, 'id' | 'ref' | 'leadId' | 'clientPoId' | 'subtotal' | 'total' | 'documentId'>, pdf?: (ref: string) => Promise<FileMeta>) => Promise<SalesOrder>;
  createMO: (leadId: ID, plannedDate: string, reconcile?: { qty: number; note: string }) => ManufacturingOrder;
  raiseShortfallPR: (moId: ID) => PurchaseRequest;
  allocateMO: (moId: ID) => number;
  // procurement
  addPR: (p: { lines: { materialId: ID; qty: number }[]; requiredBy: string; notes: string }) => PurchaseRequest;
  updatePRLines: (prId: ID, lines: PRLine[]) => void;
  approvePR: (prId: ID) => SupplierPO;
  rejectPR: (prId: ID) => void;
  saveSupplier: (s: Omit<Supplier, 'id' | 'createdAt'> & { id?: ID }) => Supplier;
  toggleSupplier: (id: ID) => void;
  addSupplierQuotation: (q: { supplierId: ID; category: string; reference: string; date: string; file: FileMeta }) => ID;
  savePO: (p: { id?: ID; supplierId: ID; prId?: ID; lines: POLine[]; expectedDelivery: string; paymentTermsDays: 30 | 60 | 90; quotationIds: ID[] }) => SupplierPO;
  attachPODocument: (poId: ID, pdf: FileMeta) => void;
  receiveGoods: (poId: ID, g: { number: string; date: string; lines: { materialId: ID; qty: number }[]; file?: FileMeta }) => void;
  // manufacturing
  assignLine: (moId: ID, line: 'Line 1' | 'Line 2' | null) => void;
  issueMaterials: (moId: ID) => void;
  advanceStage: (moId: ID) => void;
  saveStages: (stages: StageDef[]) => void;
  // dispatch & finance
  confirmDispatch: (dispatchId: ID, d: { dispatchDate: string; vehicleNo: string; transporter: string; driver: string; lrNumber: string; pod?: FileMeta; dueDate?: string }) => void;
  addPod: (dispatchId: ID, pod: FileMeta) => void;
  recordReceipt: (recId: ID, p: Omit<Payment, 'id' | 'documentId'>) => void;
  recordPayablePayment: (payId: ID, p: Omit<Payment, 'id' | 'documentId'>) => void;
  // documents
  addDocument: (d: DocInput & { expiry: string }) => ID;
  // settings · users (simulated; no authentication)
  addUser: (u: Omit<User, 'id'>) => User;
  // HRMS
  saveEmployee: (e: Omit<Employee, 'id' | 'code'> & { id?: ID }) => Employee;
  addLeave: (l: { employeeId: ID; type: LeaveRequest['type']; from: string; to: string; reason: string }) => LeaveRequest;
  decideLeave: (id: ID, status: 'Approved' | 'Rejected') => void;
  createPayrollRun: (p: { month: string; deductions: number; notes: string }) => PayrollRun;
  updatePayrollRun: (id: ID, p: { deductions: number; notes: string }) => void;
  completePayrollRun: (id: ID) => void;
}

const fail = (msg: string): never => { throw new Error(msg); };
const now = () => nowDate().toISOString();
const year = () => nowDate().getFullYear();

function nextRef(db: DB, prefix: string, pad = 4) {
  const n = (db.counters[prefix] ?? 0) + 1;
  db.counters[prefix] = n;
  return `${prefix}-${year()}-${String(n).padStart(pad, '0')}`;
}
function log(db: DB, text: string, leadId?: ID) {
  db.activities.unshift({ id: uid(), at: now(), userName: currentUser(db).name, text, leadId });
}
export interface DocInput {
  name: string; file: FileMeta; partyType: DocumentRec['partyType']; partyName: string; category: DocCategory; linkedRef: string;
  expiry?: string; source?: DocumentRec['source'];
  leadId?: ID; supplierId?: ID; refType?: DocRefType; refId?: ID;
}
function addDoc(db: DB, d: DocInput) {
  const id = uid();
  db.documents.unshift({ id, name: d.name, file: d.file, partyType: d.partyType, partyName: d.partyName, category: d.category,
    linkedRef: d.linkedRef, expiry: (d.expiry ?? '') as DocumentRec['expiry'], uploadedAt: now(), source: d.source ?? 'Upload',
    ...(d.leadId ? { leadId: d.leadId } : {}), ...(d.supplierId ? { supplierId: d.supplierId } : {}),
    ...(d.refType && d.refId ? { refType: d.refType, refId: d.refId } : {}) });
  return id;
}

/** Create a shortfall PR for whatever an MO still lacks after the existing PR pipeline. */
function shortfallPR(db: DB, mo: ManufacturingOrder, by: { id: ID; name: string }, note: string) {
  const open = moOpenShortfall(db, mo);
  if (!open.length) return undefined;
  const lead = leadById(db, mo.leadId);
  const pr: PurchaseRequest = {
    id: uid(), ref: nextRef(db, 'PR'), source: 'Material shortfall', moId: mo.id, raisedById: by.id, raisedByName: by.name,
    lines: open.map(r => ({ id: uid(), materialId: r.materialId, qty: r.uncovered, requestedQty: r.uncovered })),
    requiredBy: mo.plannedDate as PurchaseRequest['requiredBy'], notes: `${note} for ${mo.ref} · ${lead?.company ?? ''}`, status: 'Pending', createdAt: now(),
  };
  db.prs.unshift(pr);
  return pr;
}

/** Reserve as much of each outstanding requirement as current availability allows. Returns qty newly reserved. */
function allocate(db: DB, mo: ManufacturingOrder, onlyMaterials?: ID[]) {
  if (mo.materialsIssued) return 0;
  let added = 0;
  for (const r of mo.requirements) {
    if (onlyMaterials && !onlyMaterials.includes(r.materialId)) continue;
    let res = db.reservations.find(x => x.moId === mo.id && x.materialId === r.materialId);
    const have = res?.qty ?? 0;
    const need = round3(r.required - have);
    if (need <= 0) continue;
    const take = round3(Math.min(need, availableQty(db, r.materialId)));
    if (take <= 0) continue;
    if (!res) { res = { id: uid(), moId: mo.id, materialId: r.materialId, qty: 0, status: 'Reserved' }; db.reservations.push(res); }
    res.qty = round3(res.qty + take);
    added += take;
  }
  return added;
}

function createPayable(db: DB, po: SupplierPO) {
  if (db.payables.some(p => p.poId === po.id)) return;
  const days = po.paymentTermsDays ?? 30;
  db.payables.unshift({ id: uid(), ref: nextRef(db, 'PAY'), poId: po.id, supplierId: po.supplierId!, amount: poTotal(po),
    termsDays: days, poDate: po.date, dueDate: addDays(po.date, days), payments: [], createdAt: now() });
}

const storeCreator: StateCreator<Store> = (set, get) => {
      /** Apply a mutation to a cloned DB; throws propagate to the caller (UI shows them). */
      const mut = <T,>(fn: (db: DB) => T): T => {
        const db = structuredClone(get().db);
        const out = fn(db);
        set({ db });
        return out;
      };
      const admin = (db: DB) => { if (!isAdmin(db)) fail('Only an admin can do this. Switch to the admin user in the top bar.'); };

      return {
        db: emptyDB(),

        setUser: id => mut(db => { db.currentUserId = id; }),
        // An intentional reset also opts out of the sample records, so they are not re-added on the next load.
        reset: () => set({ db: { ...emptyDB(), meta: { seedOptOut: true } } }),
        saveSettings: st => mut(db => {
          admin(db);
          db.settings = Object.fromEntries(Object.entries({ ...emptySettings(), ...st }).map(([k, v]) => [k, String(v).trim()])) as unknown as Settings;
          log(db, 'Company settings updated');
        }),

        /* ---------------- CRM */
        addLead: i => mut(db => {
          if (!i.company.trim()) fail('Company name is required.');
          if (!i.contact.trim()) fail('Contact name is required.');
          const lead: Lead = { ...i, id: uid(), ref: nextRef(db, 'LD'), stage: i.stage ?? 'New', createdAt: now(),
            company: i.company.trim(), contact: i.contact.trim() };
          db.leads.unshift(lead);
          log(db, `Lead created for ${lead.company}`, lead.id);
          return lead;
        }),
        updateLead: (id, p) => mut(db => {
          const l = db.leads.find(x => x.id === id) ?? fail('Lead not found');
          if (p.company !== undefined && !p.company.trim()) fail('Company name is required.');
          if (p.contact !== undefined && !p.contact.trim()) fail('Contact name is required.');
          Object.assign(l, p);
          log(db, 'Lead details updated', id);
        }),
        setLeadStage: (id, stage) => mut(db => {
          const l = db.leads.find(x => x.id === id) ?? fail('Lead not found');
          if (l.stage === stage) return;
          if (l.stage === 'Closed' && clientPoForLead(db, id)) fail('This deal already has a Client PO, so it stays Closed.');
          const from = l.stage;
          l.stage = stage;
          if (stage === 'Closed') l.closedAt = now();
          else if (stage === 'Lost') l.closedAt = now();
          else l.closedAt = undefined;
          log(db, stage === 'Closed' ? 'Deal closed as won' : stage === 'Lost' ? `Deal marked as lost (was ${from})` : `Stage changed: ${from} → ${stage}`, id);
        }),

        /* ---------------- Materials */
        addMaterial: i => mut(db => {
          const name = i.name.trim();
          if (!name) fail('Material name is required.');
          if (!i.unit) fail('Unit is required.');
          if (db.materials.some(m => m.name.toLowerCase() === name.toLowerCase()))
            fail(`"${name}" already exists. Use the existing material so units stay consistent.`);
          const code = (i.code?.trim() || `RM-${String(db.materials.length + 1).padStart(3, '0')}`).toUpperCase();
          if (db.materials.some(m => m.code === code)) fail(`Material code ${code} is already used.`);
          const onHand = Math.max(0, +(i.onHand ?? 0) || 0);
          const m: Material = { id: uid(), code, name, category: i.category || 'Other', unit: i.unit, onHand };
          db.materials.push(m);
          log(db, `Material ${code} · ${name} added${onHand ? ` with ${fq(onHand, m.unit)} opening stock` : ''}`);
          return m;
        }),
        adjustStock: (materialId, newOnHand, note) => mut(db => {
          const m = materialById(db, materialId) ?? fail('Material not found');
          if (!(newOnHand >= 0)) fail('Enter a valid quantity.');
          const res = reservedQty(db, materialId);
          if (newOnHand < res) fail(`On-hand cannot go below the ${fq(res, m.unit)} already reserved for MOs.`);
          const old = m.onHand; m.onHand = round3(newOnHand);
          log(db, `Stock adjusted for ${m.name}: ${fq(old, m.unit)} → ${fq(m.onHand, m.unit)}${note ? ` (${note})` : ''}`);
        }),

        /* ---------------- BOM */
        saveBom: (leadId, b) => mut(db => {
          const lead = leadById(db, leadId) ?? fail('Lead not found');
          if (moForLead(db, leadId)) fail('An MO already uses this BOM, so it is locked.');
          if (!b.productName.trim()) fail('Enter the finished product / structure description.');
          if (!(b.outputQty > 0)) fail('Enter the output quantity.');
          if (!b.lines.length) fail('Add at least one material row.');
          const seen = new Set<string>();
          for (const l of b.lines) {
            if (!l.materialId) fail('Choose a material on every row.');
            if (!(l.qty > 0)) fail('Every row needs a quantity greater than zero.');
            if (seen.has(l.materialId)) fail(`${materialById(db, l.materialId)?.name} appears twice. Combine it into one row.`);
            seen.add(l.materialId);
          }
          let bom = bomForLead(db, leadId);
          if (bom) {
            Object.assign(bom, { ...b, updatedAt: now() });
            log(db, `${bom.ref} updated (${b.lines.length} materials)`, leadId);
          } else {
            bom = { id: uid(), ref: nextRef(db, 'BOM'), leadId, ...b, updatedAt: now() };
            db.boms.push(bom);
            log(db, `${bom.ref} saved for ${lead.project || lead.company} (${b.lines.length} materials)`, leadId);
          }
          return bom;
        }),

        /* ---------------- Quote */
        saveQuote: (leadId, q) => mut(db => {
          const bom = bomForLead(db, leadId) ?? fail('Save a BOM first.');
          if (!q.lines.length) fail('Add at least one quote line.');
          if (q.lines.some(l => !l.description.trim())) fail('Every quote line needs a description.');
          if (q.lines.some(l => !(l.qty > 0))) fail('Every quote line needs a quantity.');
          if (q.lines.some(l => !(l.rate > 0))) fail('Enter a rate for every quote line.');
          let quote = quoteForLead(db, leadId);
          if (quote) {
            if (quote.status !== 'Draft') fail('This quote has been sent. Create a revision to edit it.');
            Object.assign(quote, q, { bomId: bom.id });
            log(db, `${quote.ref} draft updated`, leadId);
          } else {
            quote = { id: uid(), ref: nextRef(db, 'QT'), leadId, bomId: bom.id, version: 1, status: 'Draft', ...q };
            db.quotes.push(quote);
            log(db, `${quote.ref} drafted from ${bom.ref}`, leadId);
          }
          return quote;
        }),
        markQuoteSent: (quoteId, pdf) => mut(db => {
          const q = db.quotes.find(x => x.id === quoteId) ?? fail('Quote not found');
          if (q.status === 'Quote sent') return;
          const lead = leadById(db, q.leadId)!;
          q.status = 'Quote sent'; q.sentAt = now();
          if (pdf) addDoc(db, { name: `${q.ref}${q.version > 1 ? '-v' + q.version : ''}.pdf`, file: pdf, partyType: 'client', partyName: lead.company,
            category: 'Quote', linkedRef: q.ref, source: 'Generated', leadId: lead.id, refType: 'quote', refId: q.id });
          log(db, `${q.ref} marked as sent`, lead.id);
          if (lead.stage !== 'Closed' && lead.stage !== 'Lost' && lead.stage !== 'Quote sent') {
            log(db, `Stage changed: ${lead.stage} → Quote sent (automatic)`, lead.id);
            lead.stage = 'Quote sent';
          }
        }),
        reviseQuote: quoteId => mut(db => {
          const q = db.quotes.find(x => x.id === quoteId) ?? fail('Quote not found');
          if (q.status === 'Draft') return;
          const lead = leadById(db, q.leadId)!;
          if (lead.stage === 'Closed') fail('The deal is closed; the won quote is kept as-is.');
          q.status = 'Draft'; q.version += 1; q.sentAt = undefined;
          log(db, `${q.ref} revision v${q.version} started`, lead.id);
        }),

        /* ---------------- Client PO */
        saveClientPO: (leadId, p) => mut(db => {
          const lead = leadById(db, leadId) ?? fail('Lead not found');
          if (lead.stage !== 'Closed') fail('Close the deal as won before entering the Client PO.');
          if (soForLead(db, leadId)) fail('A sales order already exists for this Client PO, so it is locked.');
          if (!p.poNumber.trim()) fail('Client PO number is required.');
          if (!p.poDate) fail('Client PO date is required.');
          if (!p.lines.length || p.lines.some(l => !l.description.trim() || !(l.qty > 0))) fail('Each item needs a description and quantity.');
          if (!(p.amount > 0)) fail('Enter the PO amount.');
          if (!p.paymentTerms.trim()) fail('Payment terms are required.');
          if (!p.deliveryAddress.trim()) fail('Delivery address is required.');
          let cpo = clientPoForLead(db, leadId);
          const fileChanged = p.file && p.file.fileId !== cpo?.file?.fileId;
          if (cpo) { Object.assign(cpo, p); log(db, `Client PO ${p.poNumber} updated`, leadId); }
          else {
            cpo = { id: uid(), leadId, createdAt: now(), ...p };
            db.clientPOs.push(cpo);
            log(db, `Client PO ${p.poNumber} recorded`, leadId);
          }
          if (fileChanged && p.file) {
            cpo.documentId = addDoc(db, { name: p.file.name, file: p.file, partyType: 'client', partyName: lead.company, category: 'Client PO', linkedRef: p.poNumber, leadId, refType: 'cpo', refId: cpo.id });
          }
          return cpo;
        }),

        /* ---------------- SO */
        createSO: async (leadId, s, pdf) => {
          const db0 = get().db;
          if (soForLead(db0, leadId)) fail('A sales order already exists for this deal.');
          const cpo0 = clientPoForLead(db0, leadId) ?? fail('Enter the Client PO first.');
          if (!s.lines.length || s.lines.some(l => !l.description.trim() || !(l.qty > 0))) fail('Each SO item needs a description and quantity.');
          if (!cpo0.paymentTerms.trim()) fail('The Client PO has no payment terms. Edit the Client PO first.');
          // Reserve the ref first so the PDF carries it.
          const previewRef = `SO-${year()}-${String((db0.counters['SO'] ?? 0) + 1).padStart(4, '0')}`;
          const file = pdf ? await pdf(previewRef) : undefined;
          return mut(db => {
            if (soForLead(db, leadId)) fail('A sales order already exists for this deal.');
            const lead = leadById(db, leadId)!;
            const subtotal = linesSubtotal(s.lines);
            const total = round2(quoteTotals(s).total);
            // Commercial terms always come from the Client PO so the SO can never diverge from what the client signed.
            const so: SalesOrder = { id: uid(), ref: nextRef(db, 'SO'), leadId, clientPoId: cpo0.id, ...s,
              paymentTerms: cpo0.paymentTerms, deliveryTerms: cpo0.deliveryTerms, deliveryAddress: cpo0.deliveryAddress, terms: cpo0.terms, subtotal, total };
            if (file) so.documentId = addDoc(db, { name: `${so.ref}.pdf`, file, partyType: 'client', partyName: lead.company, category: 'Sales order', linkedRef: so.ref, source: 'Generated', leadId, refType: 'so', refId: so.id });
            db.salesOrders.push(so);
            log(db, `${so.ref} generated from Client PO ${cpo0.poNumber}`, leadId);
            return so;
          });
        },

        /* ---------------- MO */
        createMO: (leadId, plannedDate, reconcile) => mut(db => {
          const existing = moForLead(db, leadId);
          if (existing) fail(`${existing.ref} already exists for this order.`);
          const so = soForLead(db, leadId) ?? fail('Generate the sales order first.');
          const bom = bomForLead(db, leadId) ?? fail('A saved BOM is required.');
          const match = soBomMatch(so, bom);
          let qty = bom.outputQty;
          let reconciliation: ManufacturingOrder['reconciliation'];
          if (!match.matched) {
            if (!reconcile) fail(`The SO quantity doesn't match the BOM output (${fq(bom.outputQty, bom.outputUnit)}). Reconcile the quantity before creating the MO.`);
            if (!(reconcile!.qty > 0)) fail('Enter the quantity to manufacture.');
            if (!reconcile!.note.trim()) fail('Add a short reconciliation note (why the quantities differ / what was agreed).');
            qty = round3(reconcile!.qty);
            reconciliation = { soQty: match.suggestedQty, bomOutput: bom.outputQty, note: reconcile!.note.trim(), by: currentUser(db).name, at: now() };
          }
          const factor = qty / bom.outputQty;
          const mo: ManufacturingOrder = {
            id: uid(), ref: nextRef(db, 'MO'), leadId, soId: so.id, bomId: bom.id,
            productName: bom.productName, qty, unit: bom.outputUnit, plannedDate: plannedDate as ManufacturingOrder['plannedDate'],
            createdAt: now(), requirements: bom.lines.map(l => ({ materialId: l.materialId, required: round3(l.qty * factor) })),
            line: null, stageId: FIXED_FIRST_STAGE, materialsIssued: false, fgPosted: false,
            log: [{ at: now(), text: 'MO created and placed in the unassigned queue' }],
            ...(reconciliation ? { reconciliation } : {}),
          };
          if (reconciliation) mo.log.unshift({ at: now(), text: `Quantity reconciled: BOM ${fq(bom.outputQty, bom.outputUnit)} → MO ${fq(qty, bom.outputUnit)} (${reconciliation.note}); requirements scaled ×${round3(factor)}` });
          db.mos.push(mo);
          allocate(db, mo);
          const pr = shortfallPR(db, mo, { id: 'system', name: 'System (MO shortfall)' }, 'Shortfall');
          if (pr) {
            mo.log.unshift({ at: now(), text: `${pr.ref} raised for ${pr.lines.length} short material(s)` });
            log(db, `${mo.ref} created · ${pr.lines.length} shortfall(s) → ${pr.ref}`, leadId);
          } else log(db, `${mo.ref} created · all materials reserved`, leadId);
          return mo;
        }),
        raiseShortfallPR: moId => mut(db => {
          const mo = db.mos.find(m => m.id === moId) ?? fail('MO not found');
          if (mo.materialsIssued) fail('Materials are already issued for this MO.');
          allocate(db, mo);
          if (db.prs.some(p => p.moId === mo.id && p.status === 'Pending')) fail('A PR for this MO is still pending approval. Decide on it first.');
          const u = currentUser(db);
          const pr = shortfallPR(db, mo, { id: u.id, name: u.name }, 'Balance shortfall') ?? fail('Nothing left to request — the remaining shortfall is already covered by open PRs/POs or stock.');
          mo.log.unshift({ at: now(), text: `${pr.ref} raised for the uncovered balance` });
          log(db, `${pr.ref} raised for the uncovered balance of ${mo.ref}`, mo.leadId);
          return pr;
        }),
        allocateMO: moId => mut(db => {
          const mo = db.mos.find(m => m.id === moId) ?? fail('MO not found');
          const n = allocate(db, mo);
          if (n > 0) mo.log.unshift({ at: now(), text: 'Additional available stock reserved' });
          return n;
        }),

        /* ---------------- PR */
        addPR: p => mut(db => {
          const lines = p.lines.filter(l => l.materialId);
          if (!lines.length) fail('Add at least one material.');
          if (lines.some(l => !(l.qty > 0))) fail('Each line needs a quantity greater than zero.');
          const u = currentUser(db);
          const pr: PurchaseRequest = { id: uid(), ref: nextRef(db, 'PR'), source: 'Manual', raisedById: u.id, raisedByName: u.name,
            lines: lines.map(l => ({ id: uid(), materialId: l.materialId, qty: l.qty, requestedQty: l.qty })),
            requiredBy: p.requiredBy as PurchaseRequest['requiredBy'], notes: p.notes, status: 'Pending', createdAt: now() };
          db.prs.unshift(pr);
          log(db, `${pr.ref} raised (manual)`);
          return pr;
        }),
        updatePRLines: (prId, lines) => mut(db => {
          admin(db);
          const pr = db.prs.find(p => p.id === prId) ?? fail('PR not found');
          if (pr.status !== 'Pending') fail('Only pending PRs can be edited.');
          if (lines.some(l => !(l.qty > 0))) fail('Quantities must be greater than zero.');
          pr.lines = lines;
          log(db, `${pr.ref} quantities edited`);
        }),
        approvePR: prId => mut(db => {
          admin(db);
          const pr = db.prs.find(p => p.id === prId) ?? fail('PR not found');
          if (pr.status !== 'Pending') fail(`${pr.ref} is already ${pr.status.toLowerCase()}.`);
          if (pr.poId || db.supplierPOs.some(p => p.prId === pr.id)) fail('A supplier PO already exists for this PR.');
          pr.status = 'Approved'; pr.decidedAt = now(); pr.decidedBy = currentUser(db).name;
          const po: SupplierPO = { id: uid(), ref: nextRef(db, 'PO'), supplierId: null, prId: pr.id, date: todayISO(),
            lines: pr.lines.map(l => ({ id: uid(), materialId: l.materialId, qty: l.qty, rate: 0 })), expectedDelivery: '',
            paymentTermsDays: null, status: 'Details required', receiptStatus: 'Not received', quotationIds: [], createdAt: now() };
          db.supplierPOs.unshift(po);
          pr.poId = po.id;
          const mo = pr.moId ? db.mos.find(m => m.id === pr.moId) : undefined;
          log(db, `${pr.ref} approved → ${po.ref} created (details required)`, mo?.leadId);
          return po;
        }),
        rejectPR: prId => mut(db => {
          admin(db);
          const pr = db.prs.find(p => p.id === prId) ?? fail('PR not found');
          if (pr.status !== 'Pending') fail(`${pr.ref} is already ${pr.status.toLowerCase()}.`);
          pr.status = 'Rejected'; pr.decidedAt = now(); pr.decidedBy = currentUser(db).name;
          log(db, `${pr.ref} rejected`);
        }),

        /* ---------------- Suppliers */
        saveSupplier: s => mut(db => {
          if (!s.name.trim()) fail('Supplier name is required.');
          if (s.gst && !/^[0-9A-Z]{15}$/i.test(s.gst.trim())) fail('GST number should be 15 characters (e.g. 36AAACT2727Q1ZV).');
          if (db.suppliers.some(x => x.id !== s.id && x.name.toLowerCase() === s.name.trim().toLowerCase())) fail('A supplier with this name already exists.');
          if (s.id) {
            const ex = db.suppliers.find(x => x.id === s.id) ?? fail('Supplier not found');
            Object.assign(ex, { ...s, name: s.name.trim(), gst: s.gst.trim().toUpperCase() });
            return ex;
          }
          const sup: Supplier = { ...s, id: uid(), name: s.name.trim(), gst: s.gst.trim().toUpperCase(), createdAt: now() };
          db.suppliers.push(sup);
          log(db, `Supplier ${sup.name} added`);
          return sup;
        }),
        toggleSupplier: id => mut(db => {
          const s = db.suppliers.find(x => x.id === id) ?? fail('Supplier not found');
          s.active = !s.active;
          log(db, `Supplier ${s.name} marked ${s.active ? 'active' : 'inactive'}`);
        }),
        addSupplierQuotation: q => mut(db => {
          const sup = supplierById(db, q.supplierId) ?? fail('Choose a supplier.');
          if (!q.reference.trim()) fail('Quotation reference / name is required.');
          const id = uid();
          const documentId = addDoc(db, { name: q.file.name, file: q.file, partyType: 'supplier', partyName: sup.name, category: 'Supplier quotation', linkedRef: q.reference.trim(),
            supplierId: sup.id, refType: 'quotation', refId: id });
          db.supplierQuotations.unshift({ id, supplierId: sup.id, category: q.category, reference: q.reference.trim(), date: q.date as never, file: q.file, documentId });
          log(db, `Supplier quotation ${q.reference} from ${sup.name} uploaded`);
          return id;
        }),

        /* ---------------- Supplier PO */
        savePO: p => mut(db => {
          const sup = supplierById(db, p.supplierId) ?? fail('Choose a supplier.');
          if (!sup.active) fail(`${sup.name} is inactive and cannot be used on a new PO.`);
          if (!p.lines.length) fail('Add at least one item.');
          if (p.lines.some(l => !l.materialId)) fail('Choose a material on every row.');
          if (p.lines.some(l => !(l.qty > 0))) fail('Every item needs a quantity.');
          if (p.lines.some(l => !(l.rate > 0))) fail('Enter a rate for every item.');
          if (![30, 60, 90].includes(p.paymentTermsDays)) fail('Choose payment terms (30, 60 or 90 days).');
          let po: SupplierPO;
          if (p.id) {
            po = db.supplierPOs.find(x => x.id === p.id) ?? fail('PO not found');
            if (po.status === 'Approved') fail('This PO is already approved.');
            Object.assign(po, { supplierId: sup.id, lines: p.lines, expectedDelivery: p.expectedDelivery, paymentTermsDays: p.paymentTermsDays,
              quotationIds: p.quotationIds, status: 'Approved', date: todayISO() });
          } else {
            let pr: PurchaseRequest | undefined;
            if (p.prId) {
              pr = db.prs.find(x => x.id === p.prId) ?? fail('PR not found');
              if (pr.poId || db.supplierPOs.some(x => x.prId === pr!.id)) fail(`${pr.ref} already has a supplier PO.`);
              if (pr.status === 'Rejected') fail(`${pr.ref} was rejected.`);
              if (pr.status === 'Pending') {
                admin(db);
                pr.status = 'Approved'; pr.decidedAt = now(); pr.decidedBy = currentUser(db).name;
              }
            }
            po = { id: uid(), ref: nextRef(db, 'PO'), supplierId: sup.id, prId: p.prId, date: todayISO(), lines: p.lines,
              expectedDelivery: p.expectedDelivery as SupplierPO['expectedDelivery'], paymentTermsDays: p.paymentTermsDays,
              status: 'Approved', receiptStatus: 'Not received', quotationIds: p.quotationIds, createdAt: now() };
            db.supplierPOs.unshift(po);
            if (pr) pr.poId = po.id;
          }
          createPayable(db, po);
          const mo = po.prId ? db.mos.find(m => m.id === db.prs.find(x => x.id === po.prId)?.moId) : undefined;
          log(db, `${po.ref} approved for ${sup.name} · payable created`, mo?.leadId);
          return po;
        }),
        attachPODocument: (poId, pdf) => mut(db => {
          const po = db.supplierPOs.find(x => x.id === poId);
          if (!po || po.documentId) return;
          po.documentId = addDoc(db, { name: `${po.ref}.pdf`, file: pdf, partyType: 'supplier', partyName: supplierById(db, po.supplierId)?.name ?? '',
            category: 'Supplier PO', linkedRef: po.ref, source: 'Generated', supplierId: po.supplierId ?? undefined, leadId: leadIdForPO(db, po.id), refType: 'po', refId: po.id });
        }),
        receiveGoods: (poId, g) => mut(db => {
          const po = db.supplierPOs.find(x => x.id === poId) ?? fail('PO not found');
          if (po.status !== 'Approved') fail('Complete the PO details before receiving goods.');
          if (po.receiptStatus === 'Received' || db.grns.some(x => x.poId === poId)) fail(`Goods for ${po.ref} were already received.`);
          if (!g.number.trim()) fail('GRN number is required.');
          if (db.grns.some(x => x.number.toLowerCase() === g.number.trim().toLowerCase())) fail('This GRN number is already used.');
          if (!g.date) fail('Receipt date is required.');
          for (const l of g.lines) {
            const pl = po.lines.find(x => x.materialId === l.materialId);
            if (!pl || Math.abs(pl.qty - l.qty) > 0.0005) fail('Record the full delivery — received quantities must match the PO (part receipts are not supported).');
          }
          const sup = supplierById(db, po.supplierId);
          const grn = { id: uid(), number: g.number.trim(), poId, date: g.date as never, lines: g.lines, file: g.file, documentId: undefined as ID | undefined };
          if (g.file) grn.documentId = addDoc(db, { name: g.file.name, file: g.file, partyType: 'supplier', partyName: sup?.name ?? '', category: 'GRN', linkedRef: `${grn.number} · ${po.ref}`,
            supplierId: sup?.id, leadId: leadIdForPO(db, po.id), refType: 'grn', refId: grn.id });
          db.grns.push(grn);
          for (const l of g.lines) { const m = materialById(db, l.materialId); if (m) m.onHand = round3(m.onHand + l.qty); }
          po.receiptStatus = 'Received'; po.grnId = grn.id;
          // Allocate the arrival to the MO that caused the shortage.
          const pr = po.prId ? db.prs.find(x => x.id === po.prId) : undefined;
          const mo = pr?.moId ? db.mos.find(m => m.id === pr.moId) : undefined;
          let note = '';
          if (mo) {
            const n = allocate(db, mo, g.lines.map(l => l.materialId));
            if (n > 0) { mo.log.unshift({ at: now(), text: `Stock from ${grn.number} reserved` }); note = ` · allocated to ${mo.ref}`; }
          }
          log(db, `${grn.number} received against ${po.ref}${note}`, mo?.leadId);
        }),

        /* ---------------- Manufacturing */
        assignLine: (moId, line) => mut(db => {
          admin(db);
          const mo = db.mos.find(m => m.id === moId) ?? fail('MO not found');
          if (mo.fgPosted) fail('This MO is complete.');
          if (!line && mo.materialsIssued) fail('Materials are already issued; the MO cannot go back to the queue.');
          mo.line = line;
          mo.log.unshift({ at: now(), text: line ? `Assigned to ${line}` : 'Returned to unassigned queue' });
          log(db, line ? `${mo.ref} assigned to ${line}` : `${mo.ref} returned to queue`, mo.leadId);
        }),
        issueMaterials: moId => mut(db => {
          const mo = db.mos.find(m => m.id === moId) ?? fail('MO not found');
          if (!mo.line) fail('Assign the MO to a line first.');
          if (mo.materialsIssued) fail('Materials are already issued for this MO.');
          allocate(db, mo);
          const st = moMaterialStatus(db, mo);
          if (!st.ready) fail(`Cannot issue: ${st.shortCount} material(s) are not fully reserved yet. Receive the pending PO or adjust stock.`);
          const by = currentUser(db), at = now();
          for (const r of mo.requirements) {
            const res = db.reservations.find(x => x.moId === mo.id && x.materialId === r.materialId)!;
            const m = materialById(db, r.materialId)!;
            m.onHand = round3(m.onHand - res.qty);
            res.status = 'Issued';
            // Issue register entry (id derived from the reservation, so record ids elsewhere are unaffected).
            db.materialIssues.unshift({ id: `iss-${res.id}`, moId: mo.id, line: mo.line!, materialId: m.id, qty: res.qty, unit: m.unit, at, issuedById: by.id, issuedByName: by.name });
          }
          mo.materialsIssued = true;
          const next = db.stages[1];
          mo.stageId = next.id;
          mo.log.unshift({ at: now(), text: `Materials issued · moved to ${next.name}` });
          log(db, `${mo.ref} materials issued`, mo.leadId);
        }),
        advanceStage: moId => mut(db => {
          const mo = db.mos.find(m => m.id === moId) ?? fail('MO not found');
          if (!mo.line) fail('Assign the MO to a line first.');
          if (!mo.materialsIssued) fail('Issue materials before advancing production.');
          if (mo.fgPosted || mo.stageId === FIXED_LAST_STAGE) fail('This MO is already at Finished goods ready.');
          const i = stageIndex(db, mo.stageId);
          const next = db.stages[i + 1] ?? fail('No next stage');
          mo.stageId = next.id;
          mo.log.unshift({ at: now(), text: `Moved to ${next.name}` });
          if (next.id === FIXED_LAST_STAGE && !mo.fgPosted) {
            mo.fgPosted = true;
            if (!db.fgItems.some(f => f.moId === mo.id))
              db.fgItems.unshift({ id: uid(), moId: mo.id, soId: mo.soId, leadId: mo.leadId, productName: mo.productName, unit: mo.unit,
                producedQty: mo.qty, dispatchedQty: 0, postedAt: now() });
            if (!db.dispatches.some(d => d.moId === mo.id))
              db.dispatches.unshift({ id: uid(), ref: nextRef(db, 'DSP'), moId: mo.id, soId: mo.soId, leadId: mo.leadId, qty: mo.qty, unit: mo.unit, status: 'Ready', readyAt: now() });
            log(db, `${mo.ref} finished goods ready · added to inventory and dispatch queue`, mo.leadId);
          } else log(db, `${mo.ref} moved to ${next.name}`, mo.leadId);
        }),
        saveStages: stages => mut(db => {
          admin(db);
          if (stages[0]?.id !== FIXED_FIRST_STAGE || stages[stages.length - 1]?.id !== FIXED_LAST_STAGE) fail('Material issue and Finished goods ready must stay first and last.');
          if (stages.some(s => !s.name.trim())) fail('Every stage needs a name.');
          if (stages.length < 3) fail('Keep at least one production stage.');
          const ids = new Set(stages.map(s => s.id));
          const stuck = db.mos.find(m => !ids.has(m.stageId));
          if (stuck) fail(`${stuck.ref} is currently at "${db.stages.find(s => s.id === stuck.stageId)?.name}". Move it on before removing that stage.`);
          db.stages = stages.map(s => ({ ...s, name: s.name.trim() }));
          log(db, 'Production stages updated');
        }),

        /* ---------------- Dispatch */
        confirmDispatch: (dispatchId, d) => mut(db => {
          const dsp = db.dispatches.find(x => x.id === dispatchId) ?? fail('Dispatch not found');
          if (dsp.status === 'Dispatched' || dsp.receivableId) fail(`${dsp.ref} is already dispatched.`);
          if (!d.dispatchDate) fail('Dispatch date is required.');
          if (!d.vehicleNo.trim()) fail('Vehicle number is required.');
          const so = db.salesOrders.find(s => s.id === dsp.soId) ?? fail('Linked SO not found');
          const days = parseTermsDays(so.paymentTerms);
          let due = days !== null ? addDays(d.dispatchDate, days) : d.dueDate;
          if (!due) fail(`Payment terms "${so.paymentTerms}" can't be interpreted. Enter an explicit due date.`);
          if (due! < d.dispatchDate) fail('Due date cannot be before the dispatch date.');
          const fg = db.fgItems.find(f => f.moId === dsp.moId) ?? fail('Finished goods not found in inventory.');
          const left = round3(fg.producedQty - fg.dispatchedQty);
          if (left < dsp.qty) fail(`Only ${fq(left, fg.unit)} in finished goods.`);
          const lead = leadById(db, dsp.leadId)!;
          Object.assign(dsp, { status: 'Dispatched', dispatchDate: d.dispatchDate, vehicleNo: d.vehicleNo.trim(), transporter: d.transporter, driver: d.driver, lrNumber: d.lrNumber });
          fg.dispatchedQty = round3(fg.dispatchedQty + dsp.qty);
          if (d.pod) { dsp.pod = d.pod; dsp.podDocumentId = addDoc(db, { name: d.pod.name, file: d.pod, partyType: 'client', partyName: lead.company, category: 'POD', linkedRef: dsp.ref, leadId: dsp.leadId, refType: 'dispatch', refId: dsp.id }); }
          const rec = { id: uid(), ref: nextRef(db, 'RCV'), leadId: dsp.leadId, soId: so.id, dispatchId: dsp.id, amount: so.total,
            paymentTerms: so.paymentTerms, dueDate: due!, payments: [], createdAt: now() };
          db.receivables.unshift(rec);
          dsp.receivableId = rec.id;
          log(db, `${dsp.ref} dispatched (${d.vehicleNo}) · receivable ${rec.ref} created`, dsp.leadId);
        }),
        addPod: (dispatchId, pod) => mut(db => {
          const dsp = db.dispatches.find(x => x.id === dispatchId) ?? fail('Dispatch not found');
          if (dsp.status !== 'Dispatched') fail('Confirm the dispatch first.');
          if (dsp.pod) fail('A POD is already attached.');
          const lead = leadById(db, dsp.leadId)!;
          dsp.pod = pod;
          dsp.podDocumentId = addDoc(db, { name: pod.name, file: pod, partyType: 'client', partyName: lead.company, category: 'POD', linkedRef: dsp.ref, leadId: dsp.leadId, refType: 'dispatch', refId: dsp.id });
          log(db, `POD uploaded for ${dsp.ref}`, dsp.leadId);
        }),

        /* ---------------- Finance */
        recordReceipt: (recId, p) => mut(db => {
          const r = db.receivables.find(x => x.id === recId) ?? fail('Receivable not found');
          const { outstanding } = receivableBalance(r);
          if (!(p.amount > 0)) fail('Enter an amount greater than zero.');
          if (p.amount > outstanding + 0.004) fail(`Amount exceeds the outstanding balance of ₹${outstanding.toLocaleString('en-IN')}.`);
          if (!p.date) fail('Payment date is required.');
          const lead = leadById(db, r.leadId)!;
          const pay: Payment = { ...p, id: uid() };
          if (p.proof) pay.documentId = addDoc(db, { name: p.proof.name, file: p.proof, partyType: 'client', partyName: lead.company, category: 'Payment proof', linkedRef: r.ref, leadId: r.leadId, refType: 'receivable', refId: r.id });
          r.payments.push(pay);
          log(db, `Payment of ₹${p.amount.toLocaleString('en-IN')} received against ${r.ref}`, r.leadId);
        }),
        recordPayablePayment: (payId, p) => mut(db => {
          const r = db.payables.find(x => x.id === payId) ?? fail('Payable not found');
          const { outstanding } = receivableBalance(r);
          if (!(p.amount > 0)) fail('Enter an amount greater than zero.');
          if (p.amount > outstanding + 0.004) fail(`Amount exceeds the outstanding balance of ₹${outstanding.toLocaleString('en-IN')}.`);
          if (!p.date) fail('Payment date is required.');
          const sup = supplierById(db, r.supplierId);
          const po = db.supplierPOs.find(x => x.id === r.poId);
          const pay: Payment = { ...p, id: uid() };
          if (p.proof) pay.documentId = addDoc(db, { name: p.proof.name, file: p.proof, partyType: 'supplier', partyName: sup?.name ?? '', category: 'Payment proof', linkedRef: `${r.ref} · ${po?.ref ?? ''}`,
            supplierId: r.supplierId, leadId: leadIdForPO(db, r.poId), refType: 'payable', refId: r.id });
          r.payments.push(pay);
          log(db, `Paid ₹${p.amount.toLocaleString('en-IN')} to ${sup?.name} against ${po?.ref}`);
        }),

        addDocument: d => mut(db => {
          if (!d.name.trim()) fail('Document name is required.');
          if (!d.category) fail('Choose a category.');
          if (d.leadId && !leadById(db, d.leadId)) fail('Linked lead not found.');
          if (d.supplierId && !supplierById(db, d.supplierId)) fail('Linked supplier not found.');
          const id = addDoc(db, { ...d, name: d.name.trim() });
          log(db, `Document "${d.name}" uploaded`, d.leadId);
          return id;
        }),

        /* ---------------- Users (simulated) */
        addUser: u => mut(db => {
          admin(db);
          if (!u.name.trim()) fail('Name is required.');
          if (u.email && !/^\S+@\S+\.\S+$/.test(u.email)) fail('Enter a valid email.');
          if (u.email && db.users.some(x => x.email?.toLowerCase() === u.email!.toLowerCase())) fail('A user with this email already exists.');
          const user: User = { ...u, id: uid(), name: u.name.trim() };
          db.users.push(user);
          log(db, `User ${user.name} added (${user.role === 'admin' ? 'Admin' : 'User'})`);
          return user;
        }),

        /* ---------------- HRMS */
        saveEmployee: e => mut(db => {
          admin(db);
          if (!e.name.trim()) fail('Name is required.');
          if (!e.department) fail('Choose a department.');
          if (!(e.monthlySalary >= 0)) fail('Monthly salary cannot be negative.');
          if (e.id) {
            const ex = db.employees.find(x => x.id === e.id) ?? fail('Employee not found');
            Object.assign(ex, { ...e, name: e.name.trim() });
            log(db, `Employee ${ex.code} updated`);
            return ex;
          }
          const n = (db.counters.EMP ?? 0) + 1; db.counters.EMP = n;
          const emp: Employee = { ...e, id: uid(), code: `EMP-${String(n).padStart(3, '0')}`, name: e.name.trim() };
          db.employees.push(emp);
          log(db, `Employee ${emp.code} · ${emp.name} added`);
          return emp;
        }),
        addLeave: l => mut(db => {
          const emp = db.employees.find(x => x.id === l.employeeId) ?? fail('Choose an employee.');
          if (!l.from || !l.to) fail('From and to dates are required.');
          if (l.to < l.from) fail('The leave cannot end before it starts.');
          const days = Math.round((Date.parse(l.to) - Date.parse(l.from)) / 86400000) + 1;
          if (db.leaves.some(x => x.employeeId === emp.id && x.status !== 'Rejected' && x.from <= l.to && l.from <= x.to)) fail(`${emp.name} already has leave on these dates.`);
          const rec: LeaveRequest = { id: uid(), employeeId: emp.id, type: l.type, from: l.from, to: l.to, days, reason: l.reason.trim(), status: 'Pending', createdAt: now() };
          db.leaves.unshift(rec);
          log(db, `${l.type} leave requested for ${emp.name} (${days} day${days === 1 ? '' : 's'})`);
          return rec;
        }),
        decideLeave: (id, status) => mut(db => {
          admin(db);
          const l = db.leaves.find(x => x.id === id) ?? fail('Leave request not found');
          if (l.status !== 'Pending') fail('This leave request is already decided.');
          Object.assign(l, { status, decidedBy: currentUser(db).name, decidedAt: now() });
          log(db, `Leave for ${db.employees.find(e => e.id === l.employeeId)?.name ?? 'employee'} ${status.toLowerCase()}`);
        }),
        createPayrollRun: p => mut(db => {
          admin(db);
          if (!/^\d{4}-\d{2}$/.test(p.month)) fail('Choose a month.');
          if (db.payrollRuns.some(r => r.month === p.month)) fail('A payroll run for this month already exists.');
          const staff = db.employees.filter(e => e.status !== 'Inactive');
          if (!staff.length) fail('Add employees before creating a payroll run.');
          const gross = round2(staff.reduce((a, e) => a + e.monthlySalary, 0));
          if (p.deductions < 0 || p.deductions > gross) fail('Deductions must be between zero and the gross amount.');
          const run: PayrollRun = { id: uid(), month: p.month, employees: staff.length, gross, deductions: round2(p.deductions), net: round2(gross - p.deductions),
            status: 'Draft', notes: p.notes.trim(), createdAt: now() };
          db.payrollRuns.unshift(run);
          log(db, `Payroll draft created for ${p.month}`);
          return run;
        }),
        updatePayrollRun: (id, p) => mut(db => {
          admin(db);
          const r = db.payrollRuns.find(x => x.id === id) ?? fail('Payroll run not found');
          if (r.status === 'Completed') fail('A completed payroll run cannot be edited.');
          if (p.deductions < 0 || p.deductions > r.gross) fail('Deductions must be between zero and the gross amount.');
          Object.assign(r, { deductions: round2(p.deductions), net: round2(r.gross - p.deductions), notes: p.notes.trim() });
        }),
        completePayrollRun: id => mut(db => {
          admin(db);
          const r = db.payrollRuns.find(x => x.id === id) ?? fail('Payroll run not found');
          if (r.status === 'Completed') fail('Already completed.');
          Object.assign(r, { status: 'Completed', completedAt: now(), completedBy: currentUser(db).name });
          log(db, `Payroll for ${r.month} marked completed`);
        }),
      };
};

export const useStore = create<Store>()(
  persist(
    storeCreator as StateCreator<Store, [['zustand/persist', unknown]]>,
    {
      name: 'sunframe-erp-v1', partialize: s => ({ db: s.db }) as unknown as Store, version: 4,
      migrate: (persisted, from) => {
        const st = persisted as { db?: DB };
        if (st?.db && from < 4) migrateDB(st.db);
        return st as unknown as Store;
      },
    },
  ),
);

export const getDB = () => useStore.getState().db;
/** An in-memory store running the same business actions on a copy of the data (used to build the sample set). */
export function createSandbox(db: DB) {
  const s = createStore<Store>()(storeCreator);
  s.setState({ db: structuredClone(db) });
  return s;
}
export type { PriceLine, Dispatch };
export const isOpenStage = (s: LeadStage) => OPEN_STAGES.includes(s);
