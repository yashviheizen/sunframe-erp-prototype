import { useMemo, useState } from 'react';
import { Briefcase, ArrowLeft, Check, Lock, Save, Eye, Download, Send, RotateCcw, Trophy, FileText, Factory, Plus, Trash2, RefreshCw, ArrowRight, Pencil, LayoutGrid, History, Upload, ExternalLink } from 'lucide-react';
import {
  useStore, salesSteps, salesStatus, bomForLead, quoteForLead, clientPoForLead, soForLead, moForLead, materialById, availableQty,
  moMaterialStatus, leadValue, prsForMO, moOpenShortfall, soBomMatch, receivableBalance, clientPoLabel, type StepKey,
} from '../store';
import type { Lead, PriceLine, BomLine, Quote, DB } from '../lib/types';
import { UNITS } from '../lib/types';
import { inr, fmtDate, fmtShort, fmtDateTime, todayISO, addDays, uid, quoteTotals, qty as fq, round3 } from '../lib/format';
import { quoteSpec, soSpec, specToStoredPdf } from '../lib/docs';
import { buildPdf } from '../lib/pdf';
import { downloadBlob, storeFile, openFile, downloadFile } from '../lib/files';
import { PageHead, Button, Badge, SearchBox, Empty, Modal, Tabs, Field, Input, NumInput, Select, Textarea, Alert, FilePick, FileLink, KV, InfoTip, Cols, useList, attempt, toast, toastError, tryToast } from '../ui/kit';
import { DocPreview, PriceLinesEditor, MaterialSelect } from '../ui/shared';
import { LeadDrawer } from './CRM';
import { nav, routeQuery } from '../ui/router';
import { UploadModal } from './Documents';
import { sampleBom, sampleClientPoNumber, sampleClientPoFile } from '../lib/samples';

/* =================================================================== list */

const SALES_TABS = ['workspace', 'orders', 'quotes', 'boms'] as const;
export type SalesTab = (typeof SALES_TABS)[number];
export const isSalesTab = (s?: string): s is SalesTab => !!s && (SALES_TABS as readonly string[]).includes(s);

function SalesTabs({ tab }: { tab: SalesTab }) {
  const db = useStore(s => s.db);
  const unsentQuotes = db.quotes.filter(q => q.status === 'Draft').length;
  const soPending = db.clientPOs.filter(c => !soForLead(db, c.leadId)).length;
  return <>
    <PageHead title="Sales" sub="One record per lead: BOM → Quote → Client PO (uploaded document) → Sales order → Manufacturing order. The lists below show the same records — open a row to edit it in the workspace." />
    <Tabs value={tab} onChange={k => nav(k === 'workspace' ? 'sales' : `sales/${k}`)} tabs={[
      { key: 'workspace', label: 'Workspace', count: db.leads.length },
      { key: 'orders', label: 'Sales orders', count: db.salesOrders.length, attention: soPending, attentionLabel: 'Client PO awaiting SO' },
      { key: 'quotes', label: 'Quotes', count: db.quotes.length, attention: unsentQuotes, attentionLabel: 'draft' },
      { key: 'boms', label: 'BOMs', count: db.boms.length },
    ]} />
  </>;
}

/** Open a lead's workspace at a given step. */
const openStep = (leadId: string, step: StepKey) => nav(`sales/${leadId}?step=${step}`);

function OrdersList() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const ql = q.toLowerCase();
  const rows = db.salesOrders.map(so => ({ so, lead: db.leads.find(l => l.id === so.leadId)!, cpo: db.clientPOs.find(c => c.id === so.clientPoId), mo: moForLead(db, so.leadId) }))
    .filter(r => r.lead && (!ql || [r.so.ref, r.lead.company, r.lead.project, r.cpo && clientPoLabel(r.cpo), r.mo?.ref].some(x => x?.toLowerCase().includes(ql))))
    .sort((a, z) => z.so.date.localeCompare(a.so.date));
  const list = useList(rows, { resetKey: [q], sort: { so: r => r.so.ref, client: r => r.lead.company, cpo: r => r.cpo && clientPoLabel(r.cpo), date: r => r.so.date, delivery: r => r.so.expectedDelivery, total: r => r.so.total, mo: r => r.mo?.ref } });
  const awaiting = db.clientPOs.filter(c => !soForLead(db, c.leadId));
  return <>
    {awaiting.length > 0 && <div className="mb12"><Alert kind="warning">{awaiting.map((c, i) => { const l = db.leads.find(x => x.id === c.leadId);
      return <span key={c.id}>{i ? ' · ' : ''}Client PO <b>{clientPoLabel(c)}</b> ({l?.company}) has no sales order yet — <button className="link" onClick={() => openStep(c.leadId, 'so')}>generate SO</button></span>; })}</Alert></div>}
    <div className="card list">
      <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search SO, client, Client PO, MO…" /></div>
      {rows.length ? <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[120, undefined, 130, 92, 100, 140, 130]} />
        <thead><tr>{list.th('so', 'SO')}{list.th('client', 'Client / project')}{list.th('cpo', 'Client PO')}{list.th('date', 'Date')}{list.th('delivery', 'Delivery')}{list.th('total', 'Total (incl. GST)', 'num')}{list.th('mo', 'MO')}</tr></thead>
        <tbody>{list.rows.map(({ so, lead, cpo, mo }) => <tr key={so.id} className="clickable" tabIndex={0} onClick={() => openStep(lead.id, 'so')} onKeyDown={e => e.key === 'Enter' && openStep(lead.id, 'so')}>
          <td className="mono strong small">{so.ref}</td>
          <td><div className="primary-cell">{lead.company}</div>{lead.project && <div className="sub">{lead.project}</div>}</td>
          <td className="small" title={cpo ? clientPoLabel(cpo) : undefined}>{cpo ? clientPoLabel(cpo) : '—'}</td>
          <td className="small" title={fmtDate(so.date)}>{fmtShort(so.date)}</td>
          <td className="small muted" title={fmtDate(so.expectedDelivery)}>{fmtShort(so.expectedDelivery)}</td>
          <td className="num">{inr(so.total)}</td>
          <td className="small">{mo ? <><span className="mono">{mo.ref}</span>{mo.fgPosted ? <> <Badge plain tone="success">FG</Badge></> : null}</> : <span className="faint">Not created</span>}</td>
        </tr>)}</tbody></table></div>{list.pager}</>
        : <Empty icon={<FileText size={20} />} title={db.salesOrders.length ? 'No matching sales orders' : 'No sales orders yet'} body="Sales orders are generated in the workspace once the Client PO is uploaded." />}
    </div>
  </>;
}

function QuotesList() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const [f, setF] = useState('');
  const ql = q.toLowerCase();
  const status = (qt: Quote) => { const st = db.leads.find(l => l.id === qt.leadId)?.stage; return st === 'Closed' ? 'Won' : st === 'Lost' ? 'Lost' : qt.status; };
  const rows = db.quotes.map(qt => ({ qt, lead: db.leads.find(l => l.id === qt.leadId)! }))
    .filter(r => r.lead && (!f || status(r.qt) === f) && (!ql || [r.qt.ref, r.lead.company, r.lead.project].some(x => x?.toLowerCase().includes(ql))))
    .sort((a, z) => z.qt.date.localeCompare(a.qt.date));
  const list = useList(rows, { resetKey: [q, f], sort: { quote: r => r.qt.ref, client: r => r.lead.company, date: r => r.qt.date, valid: r => addDays(r.qt.date, r.qt.validDays), stage: r => r.lead.stage, status: r => status(r.qt), total: r => quoteTotals(r.qt).total } });
  return <div className="card list">
    <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search quote, client, project…" />
      <Select aria-label="Filter by status" value={f} onChange={e => setF(e.target.value)} style={{ width: 150 }}>
        <option value="">All statuses</option><option>Draft</option><option>Quote sent</option><option>Won</option></Select></div>
    {rows.length ? <><div className="table-scroll"><table className="tbl fixed">
      <Cols w={[130, undefined, 92, 100, 130, 120, 140]} />
      <thead><tr>{list.th('quote', 'Quote')}{list.th('client', 'Client / project')}{list.th('date', 'Date')}{list.th('valid', 'Valid until')}{list.th('stage', 'Lead stage')}{list.th('status', 'Status')}{list.th('total', 'Total (incl. GST)', 'num')}</tr></thead>
      <tbody>{list.rows.map(({ qt, lead }) => { const valid = addDays(qt.date, qt.validDays);
        return <tr key={qt.id} className="clickable" tabIndex={0} onClick={() => openStep(lead.id, 'quote')} onKeyDown={e => e.key === 'Enter' && openStep(lead.id, 'quote')}>
          <td className="mono strong small">{qt.ref}{qt.version > 1 ? <span className="faint"> · R{qt.version}</span> : null}</td>
          <td><div className="primary-cell">{lead.company}</div>{lead.project && <div className="sub">{lead.project}</div>}</td>
          <td className="small" title={fmtDate(qt.date)}>{fmtShort(qt.date)}</td>
          <td className="small muted" title={fmtDate(valid)}>{fmtShort(valid)}</td>
          <td><Badge plain>{lead.stage === 'Closed' ? 'Won' : lead.stage}</Badge></td>
          <td><Badge>{status(qt)}</Badge></td>
          <td className="num">{inr(quoteTotals(qt).total)}</td>
        </tr>; })}</tbody></table></div>{list.pager}</>
      : <Empty icon={<FileText size={20} />} title={db.quotes.length ? 'No matching quotes' : 'No quotes yet'} body="Quotes are prepared from the BOM in the workspace." />}
  </div>;
}

function BomsList() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const ql = q.toLowerCase();
  const rows = db.boms.map(b => ({ b, lead: db.leads.find(l => l.id === b.leadId)! }))
    .filter(r => r.lead && (!ql || [r.b.ref, r.b.productName, r.lead.company, ...r.b.lines.map(l => materialById(db, l.materialId)?.name)].some(x => x?.toLowerCase().includes(ql))))
    .sort((a, z) => z.b.updatedAt.localeCompare(a.b.updatedAt));
  const list = useList(rows, { resetKey: [q], sort: { bom: r => r.b.ref, product: r => r.b.productName, client: r => r.lead.company, output: r => r.b.outputQty, lines: r => r.b.lines.length, updated: r => r.b.updatedAt } });
  return <div className="card list">
    <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search BOM, product, client, material…" /></div>
    {rows.length ? <><div className="table-scroll"><table className="tbl fixed">
      <Cols w={[120, undefined, 190, 110, 96, 92, 180]} />
      <thead><tr>{list.th('bom', 'BOM')}{list.th('product', 'Product')}{list.th('client', 'Client')}{list.th('output', 'Output', 'num')}{list.th('lines', 'Materials')}{list.th('updated', 'Updated')}<th>Used by</th></tr></thead>
      <tbody>{list.rows.map(({ b, lead }) => { const qt = quoteForLead(db, lead.id), mo = moForLead(db, lead.id);
        return <tr key={b.id} className="clickable" tabIndex={0} onClick={() => openStep(lead.id, 'bom')} onKeyDown={e => e.key === 'Enter' && openStep(lead.id, 'bom')}>
          <td className="mono strong small">{b.ref}</td>
          <td><div className="primary-cell">{b.productName}</div></td>
          <td className="small">{lead.company}</td>
          <td className="num small">{fq(b.outputQty, b.outputUnit)}</td>
          <td className="small muted" title={b.lines.map(l => `${materialById(db, l.materialId)?.name ?? '?'} — ${fq(l.qty, materialById(db, l.materialId)?.unit)}`).join('\n')}>{b.lines.length} line{b.lines.length === 1 ? "" : "s"}</td>
          <td className="small muted" title={fmtDate(b.updatedAt)}>{fmtShort(b.updatedAt)}</td>
          <td className="small mono">{[qt?.ref, mo?.ref].filter(Boolean).join(' · ') || <span className="faint">—</span>}</td>
        </tr>; })}</tbody></table></div>{list.pager}</>
      : <Empty icon={<FileText size={20} />} title={db.boms.length ? 'No matching BOMs' : 'No BOMs yet'} body="BOMs are created per lead in the workspace." />}
  </div>;
}

function SalesList() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState('');
  const [f, setF] = useState('');
  const ql = q.toLowerCase();
  const rows = db.leads.filter(l => (!ql || [l.company, l.project, l.ref, l.contact].some(x => x?.toLowerCase().includes(ql))) &&
    (!f || (f === 'won' ? l.stage === 'Closed' : f === 'lost' ? l.stage === 'Lost' : l.stage !== 'Closed' && l.stage !== 'Lost')))
    .map(l => { const steps = salesSteps(db, l); return { l, steps, done: steps.filter(s => s.done).length, latest: [...steps].reverse().find(s => s.ref), status: salesStatus(db, l), value: leadValue(db, l) }; });
  const list = useList(rows, { resetKey: [q, f], sort: { company: r => r.l.company, stage: r => r.l.stage, progress: r => r.done, status: r => r.status, value: r => r.value, latest: r => r.latest?.ref } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search company, project, ref…" />
      <Select aria-label="Filter deals" value={f} onChange={e => setF(e.target.value)} style={{ width: 160 }}>
        <option value="">All deals</option><option value="open">Open deals</option><option value="won">Won (Closed)</option><option value="lost">Lost</option>
      </Select>
    </div>
    {!db.leads.length ? <Empty icon={<Briefcase size={20} />} title="No sales records yet" body="Every lead in CRM gets a sales record here. Add a lead to begin."
      action={<Button variant="primary" onClick={() => nav('crm')}>Go to CRM</Button>} />
      : !rows.length ? <Empty icon={<Briefcase size={20} />} title="No matching records" />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 130, 140, 240, 130, 130]} />
        <thead><tr>{list.th('company', 'Company / project')}{list.th('stage', 'Lead stage')}{list.th('progress', 'Progress')}{list.th('status', 'Current status')}{list.th('value', 'Value', 'num')}{list.th('latest', 'Latest document')}</tr></thead>
        <tbody>{list.rows.map(({ l, steps, done, latest, status, value }) =>
          <tr key={l.id} className="clickable" tabIndex={0} onClick={() => nav(`sales/${l.id}`)} onKeyDown={e => e.key === 'Enter' && nav(`sales/${l.id}`)}>
            <td><div className="primary-cell">{l.company}</div><div className="sub">{l.project || l.ref}</div></td>
            <td><Badge>{l.stage === 'Closed' ? 'Won' : l.stage}</Badge></td>
            <td title={steps.filter(s => s.done).map(s => s.label).join(' · ') || 'Not started'}>
              <div className="row" style={{ gap: 8 }}><div className="progress-mini" aria-label={`${done} of ${steps.length} steps done`}>{steps.map(s => <span key={s.key} className={s.done ? 'done' : ''} />)}</div>
                <span className="small muted">{done}/{steps.length}</span></div></td>
            <td className="small">{status}</td>
            <td className="num">{inr(value)}</td>
            <td className="mono small">{latest?.ref ?? '—'}</td>
          </tr>)}</tbody></table></div>{list.pager}</>}
  </div>;
}

/* =================================================================== record */

export default function Sales({ leadId }: { leadId?: string }) {
  if (!leadId || isSalesTab(leadId)) {
    const tab: SalesTab = isSalesTab(leadId) ? leadId : 'workspace';
    return <><SalesTabs tab={tab} />
      {tab === 'workspace' ? <SalesList /> : tab === 'orders' ? <OrdersList /> : tab === 'quotes' ? <QuotesList /> : <BomsList />}</>;
  }
  return <SalesRecord key={leadId + routeQuery('step')} leadId={leadId} />;
}

type View = StepKey | 'overview' | 'docs' | 'activity';

/** Where a record opens: overview once an MO exists; the quote while it awaits the client; otherwise the first open, unlocked step. */
function initialView(db: DB, lead: Lead): View {
  const step = routeQuery('step') as View;
  if (['bom', 'quote', 'cpo', 'so', 'mo', 'overview', 'docs', 'activity'].includes(step)) return step;
  if (moForLead(db, lead.id)) return 'overview';
  const steps = salesSteps(db, lead);
  if (quoteForLead(db, lead.id)?.status === 'Quote sent' && lead.stage !== 'Closed') return 'quote';
  return steps.find(s => !s.done && !s.blocked)?.key ?? [...steps].reverse().find(s => s.done)?.key ?? 'bom';
}

type Chip = { label: string; to: string; tone?: 'warn' | 'bad' | 'ok' };
/** Links from a sales record to its downstream records (PR/PO, MO, dispatch, receivable). */
function downstreamLinks(db: DB, lead: Lead): Chip[] {
  const mo = moForLead(db, lead.id);
  if (!mo) return [];
  const out: Chip[] = [{ label: mo.ref, to: `manufacturing?focus=${mo.id}`, tone: mo.fgPosted ? 'ok' : undefined }];
  for (const pr of prsForMO(db, mo.id)) {
    out.push({ label: `${pr.ref} · ${pr.status}`, to: `procurement/prs?q=${pr.ref}`, tone: pr.status === 'Rejected' ? 'bad' : pr.status === 'Pending' ? 'warn' : 'ok' });
    const po = pr.poId ? db.supplierPOs.find(x => x.id === pr.poId) : undefined;
    if (po) out.push({ label: `${po.ref} · ${po.status === 'Details required' ? po.status : po.receiptStatus}`, to: `procurement/pos?q=${po.ref}`, tone: po.receiptStatus === 'Received' ? 'ok' : 'warn' });
  }
  for (const d of db.dispatches.filter(x => x.moId === mo.id)) {
    out.push({ label: `${d.ref} · ${d.status}`, to: `dispatch?q=${d.ref}`, tone: d.status === 'Dispatched' ? 'ok' : 'warn' });
    const r = d.receivableId ? db.receivables.find(x => x.id === d.receivableId) : undefined;
    if (r) { const b = receivableBalance(r); out.push({ label: `${r.ref} · ${b.status}`, to: `finance/receivables?q=${r.ref}`, tone: b.status === 'Paid' ? 'ok' : 'warn' }); }
  }
  return out;
}

function nextAction(db: DB, lead: Lead): { title: string; body: string; step?: StepKey; cta?: string } {
  const bom = bomForLead(db, lead.id), quote = quoteForLead(db, lead.id), cpo = clientPoForLead(db, lead.id), so = soForLead(db, lead.id), mo = moForLead(db, lead.id);
  if (lead.stage === 'Lost' && !cpo) return { title: 'Deal lost', body: 'No further sales steps. Change the stage in CRM to reopen the deal.' };
  if (!bom) return { title: 'Build the bill of materials', body: 'No stock is reserved at BOM stage.', step: 'bom', cta: 'Open BOM' };
  if (!quote) return { title: 'Create the quote', body: 'Starts with the BOM product and quantity; enter rates and terms.', step: 'quote', cta: 'Create quote' };
  if (quote.status === 'Draft' && lead.stage !== 'Closed') return { title: 'Finish and send the quote', body: 'Marking it sent moves the lead to "Quote sent".', step: 'quote', cta: 'Open quote' };
  if (lead.stage !== 'Closed') return { title: 'Waiting for the client', body: 'Close the lead as won when the client confirms.', step: 'quote' };
  if (!cpo) return { title: 'Upload the Client PO', body: 'Upload the client\'s purchase order document.', step: 'cpo', cta: 'Upload Client PO' };
  if (!so) return { title: 'Generate the sales order', body: 'Items come from the won quote; enter or review the payment and delivery terms.', step: 'so', cta: 'Open sales order' };
  if (!mo) return soBomMatch(so, bom).matched
    ? { title: 'Create the manufacturing order', body: 'Reserves available stock and raises a PR for any shortfall.', step: 'mo', cta: 'Plan the MO' }
    : { title: 'Reconcile SO and BOM quantities', body: 'The SO quantity differs from the BOM output; confirm what to manufacture.', step: 'mo', cta: 'Reconcile' };
  const disp = db.dispatches.find(d => d.moId === mo.id);
  const rec = disp?.receivableId ? db.receivables.find(r => r.id === disp.receivableId) : undefined;
  if (rec) { const b = receivableBalance(rec); return b.status === 'Paid' ? { title: 'Complete — paid in full', body: '' } : { title: `Collect payment · ${inr(b.outstanding)} outstanding`, body: `Due ${fmtDate(rec.dueDate)}.` }; }
  if (disp) return { title: 'Ready to dispatch', body: 'Confirm dispatch in the Dispatch module.' };
  const st = moMaterialStatus(db, mo);
  if (!st.ready) {
    const open = moOpenShortfall(db, mo);
    if (open.length) return { title: 'Shortfall not covered', body: `${open.length} material(s) have no open PR/PO (rejected or partly approved). Request the balance.`, step: 'mo', cta: 'Open MO' };
    if (prsForMO(db, mo.id).some(p => p.status === 'Pending')) return { title: 'Waiting for PR approval', body: 'An admin approves the shortfall PR in Procurement.' };
    return { title: 'Waiting for material', body: 'Reserved automatically when the supplier PO is received (GRN).' };
  }
  if (!mo.line) return { title: `${mo.ref} is in the unassigned queue`, body: 'An admin assigns it to a line in Manufacturing.' };
  return { title: `In production on ${mo.line}`, body: `Current stage: ${db.stages.find(s => s.id === mo.stageId)?.name}.` };
}

function SalesRecord({ leadId }: { leadId: string }) {
  const db = useStore(s => s.db);
  const lead = db.leads.find(l => l.id === leadId);
  const [view, setView] = useState<View>(() => (lead ? initialView(db, lead) : 'bom'));
  const [leadOpen, setLeadOpen] = useState(false);
  if (!lead) return <Empty icon={<Briefcase size={20} />} title="Record not found" body="This sales record may have been removed after a data reset." action={<Button onClick={() => nav('sales')}>Back to list</Button>} />;
  const steps = salesSteps(db, lead);
  const na = nextAction(db, lead);
  const links = downstreamLinks(db, lead);
  const cur = steps.find(s => s.key === view);
  const docs = db.documents.filter(d => d.leadId === leadId);
  const acts = db.activities.filter(a => a.leadId === leadId);

  return <>
    <div className="page-head">
      <Button variant="ghost" iconOnly aria-label="Back to sales list" onClick={() => nav('sales')} icon={<ArrowLeft size={18} />} />
      <div style={{ minWidth: 0 }}>
        <h1>{lead.company}</h1>
        <div className="row small muted" style={{ gap: 6 }}><span>{lead.project || 'No project name'}</span><span className="faint">·</span><span className="mono">{lead.ref}</span>
          <Badge tone={lead.stage === 'Closed' ? 'success' : undefined}>{lead.stage === 'Closed' ? 'Won' : lead.stage}</Badge><span className="faint">·</span><span>{inr(leadValue(db, lead))}</span></div>
      </div>
      <div className="page-actions"><Button size="sm" onClick={() => setLeadOpen(true)}>Lead details & stage</Button></div>
    </div>

    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <nav className="tracker" aria-label="Sales steps">
        <button className="trk" aria-current={view === 'overview' ? 'step' : undefined} onClick={() => setView('overview')}><LayoutGrid size={13} />Overview</button>
        <span className="trk-sep" />
        {steps.map((s, i) => <span key={s.key} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="trk-sep" />}
          <button className={'trk' + (s.done ? ' done' : '') + (s.blocked && !s.done ? ' blocked' : '')} aria-current={view === s.key ? 'step' : undefined}
            title={s.blocked && !s.done ? s.blocked : s.ref} onClick={() => setView(s.key)}>
            <span className="d">{s.done ? <Check size={10} /> : s.blocked ? <Lock size={9} /> : i + 1}</span>{s.label}{s.ref && <span className="r">{s.ref}</span>}
          </button></span>)}
      </nav>
      <div className="spacer" />
      <div className="seg" role="group" aria-label="Record panels">
        <button aria-pressed={view === 'docs'} onClick={() => setView('docs')}><FileText size={13} />Documents ({docs.length})</button>
        <button aria-pressed={view === 'activity'} onClick={() => setView('activity')}><History size={13} />Activity</button>
      </div>
    </div>

    <div className="next-strip mt12">
      <span className="title">Next: {na.title}</span>{na.body && <InfoTip text={na.body} />}
      {na.title === 'Waiting for the client' && <Button size="sm" variant="success" icon={<Trophy size={14} />} onClick={() => tryToast(() => useStore.getState().setLeadStage(leadId, 'Closed'), 'Deal closed as won')}>Close as won</Button>}
      {na.cta && na.step && na.step !== view && <Button size="sm" variant="primary" onClick={() => setView(na.step!)}>{na.cta}</Button>}
      {links.length > 0 && <div className="links">{links.map(l => <a key={l.label} className={'chip-link' + (l.tone ? ' ' + l.tone : '')} href={`#/${l.to}`}>{l.label}<ArrowRight size={11} /></a>)}</div>}
    </div>

    <div className="card mt12">
      {view === 'overview' ? <Overview lead={lead} go={setView} />
        : view === 'docs' ? <DocsPanel lead={lead} />
        : view === 'activity' ? <><PanelHead title="Activity" /><div className="card-pad">{acts.length
          ? <ul className="timeline">{acts.map(a => <li key={a.id}><div className="small"><div>{a.text}</div><div className="faint tiny">{fmtDateTime(a.at)} · {a.userName}</div></div></li>)}</ul>
          : <div className="muted small">No activity yet.</div>}</div></>
        : cur?.blocked && !cur.done ? <Empty icon={<Lock size={20} />} title={`${cur.label} is locked`} body={cur.blocked} />
        : view === 'bom' ? <BomPanel lead={lead} />
        : view === 'quote' ? <QuotePanel lead={lead} />
        : view === 'cpo' ? <ClientPOPanel lead={lead} />
        : view === 'so' ? <SOPanel lead={lead} />
        : <MOPanel lead={lead} />}
    </div>
    {leadOpen && <LeadDrawer id={leadId} onClose={() => setLeadOpen(false)} />}
  </>;
}

function Overview({ lead, go }: { lead: Lead; go: (v: View) => void }) {
  const db = useStore(s => s.db);
  const bom = bomForLead(db, lead.id), quote = quoteForLead(db, lead.id), cpo = clientPoForLead(db, lead.id), so = soForLead(db, lead.id), mo = moForLead(db, lead.id);
  const st = mo ? moMaterialStatus(db, mo) : undefined;
  const prs = mo ? prsForMO(db, mo.id) : [];
  const disp = mo ? db.dispatches.find(d => d.moId === mo.id) : undefined;
  const rec = disp?.receivableId ? db.receivables.find(r => r.id === disp.receivableId) : undefined;
  const bal = rec ? receivableBalance(rec) : undefined;
  const Box = ({ title, onOpen, children }: { title: string; onOpen?: () => void; children: React.ReactNode }) =>
    <div className="card card-pad"><div className="row mb8"><h3>{title}</h3><div className="spacer" />{onOpen && <Button size="sm" variant="ghost" onClick={onOpen}>Open</Button>}</div>{children}</div>;
  return <>
    <PanelHead title="Overview" />
    <div className="card-pad"><div className="overview-grid">
      <Box title="Sales" onOpen={() => go(so ? 'so' : 'quote')}>
        <dl className="sum-grid"><div><dt>BOM</dt><dd>{bom ? `${bom.ref} · ${fq(bom.outputQty, bom.outputUnit)}` : '—'}</dd></div>
          <div><dt>Quote</dt><dd>{quote ? `${quote.ref} · ${quote.status === 'Quote sent' && lead.stage === 'Closed' ? 'Quote sent · won' : quote.status}` : '—'}</dd></div>
          <div><dt>Client PO</dt><dd>{cpo ? clientPoLabel(cpo) : '—'}</dd></div>
          <div><dt>Sales order</dt><dd>{so ? `${so.ref} · ${inr(so.total)}` : '—'}</dd></div>
          {so && <div><dt>Payment terms</dt><dd>{so.paymentTerms}</dd></div>}</dl>
      </Box>
      <Box title="Production" onOpen={mo ? () => go('mo') : undefined}>
        {mo ? <dl className="sum-grid"><div><dt>MO</dt><dd>{mo.ref} · {fq(mo.qty, mo.unit)}</dd></div>
          <div><dt>Line</dt><dd>{mo.line ?? 'Unassigned'}</dd></div>
          <div><dt>Stage</dt><dd>{db.stages.find(s => s.id === mo.stageId)?.name}</dd></div>
          <div><dt>Materials</dt><dd style={{ color: st!.ready ? 'var(--success)' : 'var(--danger)' }}>{mo.materialsIssued ? 'Issued' : st!.ready ? 'Fully reserved' : `${st!.shortCount} short`}</dd></div>
          {mo.reconciliation && <div><dt>Qty reconciled</dt><dd>BOM {fq(mo.reconciliation.bomOutput)} → {fq(mo.qty)}</dd></div>}</dl>
          : <div className="muted small">No manufacturing order yet.</div>}
      </Box>
      <Box title="Procurement">
        {prs.length ? <div className="col" style={{ gap: 4 }}>{prs.map(pr => { const po = pr.poId ? db.supplierPOs.find(x => x.id === pr.poId) : undefined;
          return <div key={pr.id} className="small row" style={{ gap: 6, flexWrap: 'wrap' }}><span className="mono" style={{ whiteSpace: 'nowrap' }}>{pr.ref}</span><Badge>{pr.status}</Badge>{po && <span className="muted" style={{ whiteSpace: 'nowrap' }}>→ {po.ref} · {po.status === 'Details required' ? po.status : po.receiptStatus}</span>}</div>; })}</div>
          : <div className="muted small">{mo ? 'No purchase requests — stock covered the MO.' : '—'}</div>}
      </Box>
      <Box title="Dispatch & payment">
        {disp ? <dl className="sum-grid"><div><dt>Dispatch</dt><dd>{disp.ref} · {disp.status}</dd></div>
          {disp.dispatchDate && <div><dt>Dispatched</dt><dd>{fmtDate(disp.dispatchDate)}</dd></div>}
          {rec && <><div><dt>Receivable</dt><dd>{rec.ref} · {bal!.status}</dd></div><div><dt>Outstanding</dt><dd>{inr(bal!.outstanding)}</dd></div><div><dt>Due</dt><dd>{fmtDate(rec.dueDate)}</dd></div></>}</dl>
          : <div className="muted small">Not ready for dispatch yet.</div>}
      </Box>
    </div></div>
  </>;
}

function DocsPanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const [up, setUp] = useState(false);
  const docs = db.documents.filter(d => d.leadId === lead.id);
  const act = (fn: () => Promise<void>) => fn().catch(e => toastError((e as Error).message));
  return <>
    <PanelHead title="Documents" sub="Generated PDFs and manual uploads linked to this lead (drawings, POD, payment proofs…)."
      actions={<Button size="sm" variant="primary" icon={<Upload size={14} />} onClick={() => setUp(true)}>Upload</Button>} />
    {!docs.length ? <Empty icon={<FileText size={20} />} title="No documents linked yet" body="Upload an engineering drawing or other file for this lead." />
      : <div className="table-wrap"><table className="tbl tbl-compact">
        <thead><tr><th>Document</th><th>Category</th><th>Record</th><th>Added</th><th /></tr></thead>
        <tbody>{docs.map(d => <tr key={d.id}>
          <td><div className="primary-cell">{d.name}</div><div className="faint tiny">{d.file.name}</div></td>
          <td><span className="row" style={{ gap: 4 }}><Badge plain>{d.category}</Badge>{d.source === 'Generated' && <Badge tone="info">Generated</Badge>}</span></td>
          <td className="mono small">{d.linkedRef || '—'}</td>
          <td className="muted small">{fmtDateTime(d.uploadedAt)}</td>
          <td className="right" style={{ whiteSpace: 'nowrap' }}>
            <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => act(() => openFile(d.file))}>Open</Button>
            <Button size="sm" variant="ghost" iconOnly aria-label={`Download ${d.name}`} icon={<Download size={14} />} onClick={() => act(() => downloadFile(d.file))} />
          </td></tr>)}</tbody></table></div>}
    {up && <UploadModal leadId={lead.id} category="Engineering drawing" onClose={() => setUp(false)} />}
  </>;
}

function PanelHead({ title, sub, badge, actions }: { title: string; sub?: string; badge?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className="card-head"><div className="row" style={{ gap: 6 }}><h2>{title}</h2>{sub && <InfoTip text={sub} />}{badge}</div><div className="actions">{actions}</div></div>;
}

/* =================================================================== BOM */

function BomPanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const bom = bomForLead(db, lead.id);
  const locked = !!moForLead(db, lead.id);
  const [editing, setEditing] = useState(!bom);
  // A saved BOM always opens with exactly its saved lines. A new BOM starts with ONE material row (sample product, output and
  // first material scaled from the latest BOM); nothing is ever re-added to a saved BOM.
  const [init] = useState(() => { if (bom) return bom; const s = sampleBom(useStore.getState().db, lead); return { ...s, lines: s.lines.slice(0, 1) }; });
  const [productName, setPN] = useState(init.productName);
  const [outputQty, setOQ] = useState(init.outputQty);
  const [outputUnit, setOU] = useState(init.outputUnit);
  const [lines, setLines] = useState<BomLine[]>(init.lines);
  const [notes, setNotes] = useState(init.notes);
  const [err, setErr] = useState('');
  const save = () => {
    const r = attempt(() => useStore.getState().saveBom(lead.id, { productName, outputQty, outputUnit, lines, notes }), bom ? 'BOM updated' : 'BOM saved');
    setErr(r.ok ? '' : r.error);
    if (r.ok) setEditing(false);
  };
  const cancel = () => { if (!bom) return; setPN(bom.productName); setOQ(bom.outputQty); setOU(bom.outputUnit); setLines(bom.lines); setNotes(bom.notes); setErr(''); setEditing(false); };
  const upd = (id: string, p: Partial<BomLine>) => setLines(ls => ls.map(l => (l.id === id ? { ...l, ...p } : l)));
  const snap = (b: { productName: string; outputQty: number; outputUnit: string; lines: BomLine[]; notes: string }) =>
    JSON.stringify([b.productName, b.outputQty, b.outputUnit, b.notes, b.lines.map(l => [l.materialId, l.qty])]);
  const dirty = !bom || snap(bom) !== snap({ productName, outputQty, outputUnit, lines, notes });
  const quoteSent = quoteForLead(db, lead.id)?.status === 'Quote sent';
  const edit = editing && !locked;
  return <>
    <PanelHead title="Bill of materials" sub="Raw materials needed for this order. Nothing is reserved until an MO is created." badge={<>{bom && <span className="mono small muted">{bom.ref}</span>}
      {/* The saved tick reflects the stored BOM only — never unsaved edits or a failed save. */}
      {edit && dirty ? <Badge tone="warning">{bom ? 'Unsaved changes' : 'Not saved'}</Badge> : bom && <Badge tone="success"><Check size={11} /> Saved</Badge>}</>}
      actions={edit ? <>{bom && <Button size="sm" onClick={cancel}>Cancel</Button>}<Button size="sm" variant="primary" icon={<Save size={14} />} onClick={save}>{bom ? 'Save changes' : 'Save BOM'}</Button></>
        : !locked && <Button size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Button>} />
    <div className="card-pad">
      {locked && <div className="mb12"><Alert kind="info">{moForLead(db, lead.id)!.ref} uses this BOM, so it is read-only now.</Alert></div>}
      {edit && quoteSent && <div className="mb12"><Alert kind="warning">The quote has already been sent. BOM edits do not change the sent quote.</Alert></div>}
      {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
      {edit ? <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)' }}>
        <Field label="Finished product / structure" required htmlFor="b-pn"><Input id="b-pn" value={productName} onChange={e => setPN(e.target.value)} /></Field>
        <Field label="Output quantity" required htmlFor="b-oq"><NumInput id="b-oq" value={outputQty} onChange={setOQ} /></Field>
        <Field label="Output unit" htmlFor="b-ou"><Select id="b-ou" value={outputUnit} onChange={e => setOU(e.target.value)}>{UNITS.map(u => <option key={u}>{u}</option>)}</Select></Field>
      </div> : <dl className="sum-grid"><div><dt>Finished product</dt><dd>{productName}</dd></div><div><dt>Output</dt><dd>{fq(outputQty, outputUnit)}</dd></div>
        <div><dt>Materials</dt><dd>{lines.length}</dd></div>{notes && <div><dt>Notes</dt><dd>{notes}</dd></div>}</dl>}
      <div className="table-wrap mt12" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
        <table className="tbl tbl-compact">
          <thead><tr><th style={{ width: 32 }}>#</th><th style={{ minWidth: 300 }}>Material</th><th style={{ width: 130 }}>Category</th><th className="num" style={{ width: 110 }}>Qty</th><th style={{ width: 56 }}>Unit</th><th className="num" style={{ width: 120 }}>Available now</th>{edit && <th style={{ width: 40 }} />}</tr></thead>
          <tbody>{!lines.length && <tr><td colSpan={edit ? 7 : 6} className="muted small center">No materials. Add a material row before saving.</td></tr>}
            {lines.map((l, i) => {
            const m = materialById(db, l.materialId);
            return <tr key={l.id}>
              <td className="faint">{i + 1}</td>
              <td>{!edit ? <span>{m?.code} · {m?.name}</span> : <MaterialSelect label={`Row ${i + 1} material`} value={l.materialId} exclude={lines.map(x => x.materialId)} onChange={id => upd(l.id, { materialId: id })} />}</td>
              <td className="muted small">{m?.category ?? '—'}</td>
              <td>{!edit ? <div className="right">{fq(l.qty)}</div> : <NumInput aria-label={`Row ${i + 1} quantity`} className="right" blankZero placeholder="0" value={l.qty} onChange={n => upd(l.id, { qty: n })} />}</td>
              <td className="muted">{m?.unit ?? '—'}</td>
              <td className="num muted">{m ? fq(availableQty(db, m.id), m.unit) : '—'}</td>
              {edit && <td><Button size="sm" variant="ghost" iconOnly aria-label={`Remove row ${i + 1}`} onClick={() => setLines(ls => ls.filter(x => x.id !== l.id))} icon={<Trash2 size={14} />} /></td>}
            </tr>;
          })}</tbody>
        </table>
        {edit && <div style={{ padding: 8 }}><Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setLines(ls => [...ls, { id: uid(), materialId: '', qty: 0 }])}>Add material row</Button></div>}
      </div>
      {edit && <Field label="Notes" htmlFor="b-notes"><Textarea id="b-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Drawing references, coating spec, etc." style={{ marginTop: 4 }} /></Field>}
    </div>
  </>;
}

/* =================================================================== Quote */

function linesFromBom(db: DB, leadId: string): PriceLine[] {
  const bom = bomForLead(db, leadId);
  if (!bom) return [];
  return bom.lines.map(l => { const m = materialById(db, l.materialId); return { id: uid(), description: m?.name ?? '', qty: l.qty, unit: m?.unit ?? '', rate: 0 }; });
}

/** One line for the BOM's finished product and output quantity; the rate is blank for the user to enter. */
function newQuoteLines(db: DB, leadId: string): PriceLine[] {
  const bom = bomForLead(db, leadId);
  return [{ id: uid(), description: bom?.productName ?? '', qty: bom?.outputQty ?? 0, unit: bom?.outputUnit ?? 'sets', rate: 0 }];
}

function QuotePanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const quote = quoteForLead(db, lead.id);
  const draft = !quote || quote.status === 'Draft';
  // A saved quote (any revision) opens with its own data. A new quote carries only real context: the saved BOM's product and
  // output quantity as one line (rate left for the user) and the company's own default terms from Settings — no sample
  // descriptions, prices or terms.
  const [f, setF] = useState(() => quote ? { ...quote } : {
    date: todayISO(), validDays: 15, lines: newQuoteLines(db, lead.id), discountPct: 0, freight: 0, gstPct: 18,
    paymentTerms: db.settings?.quotePaymentTerms?.trim() ?? '', deliveryTerms: db.settings?.quoteDeliveryTerms?.trim() ?? '', terms: db.settings?.quoteTerms?.trim() ?? '',
  });
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }));
  const t = quoteTotals(f);
  const payload = () => ({ date: f.date, validDays: f.validDays, lines: f.lines, discountPct: f.discountPct, freight: f.freight, gstPct: f.gstPct, paymentTerms: f.paymentTerms, deliveryTerms: f.deliveryTerms, terms: f.terms });
  const saveDraft = (msg?: string) => {
    if (!draft) return quote!;
    const r = attempt(() => useStore.getState().saveQuote(lead.id, payload()), msg);
    if (!r.ok) { setErr(r.error); return null; }
    setErr(''); setF(p => ({ ...p, ...r.value })); return r.value;
  };
  const specOf = (q: Quote) => quoteSpec(q, lead);
  const liveQuote: Quote = { ...(quote ?? { id: '', ref: 'QT-DRAFT', leadId: lead.id, bomId: '', version: 1, status: 'Draft' as const }), ...payload() } as Quote;
  const download = () => {
    const q = draft ? saveDraft() : quote!;
    if (!q) return;
    downloadBlob(buildPdf(specOf(q)), `${q.ref}${q.version > 1 ? '-v' + q.version : ''}.pdf`);
  };
  const markSent = async () => {
    const q = saveDraft();
    if (!q) return;
    setBusy(true);
    try {
      const meta = await specToStoredPdf(specOf({ ...q, status: 'Quote sent' }), `${q.ref}${q.version > 1 ? '-v' + q.version : ''}.pdf`);
      useStore.getState().markQuoteSent(q.id, meta);
      toast(lead.stage === 'Closed' || lead.stage === 'Lost' ? `${q.ref} marked as sent` : `${q.ref} marked as sent · lead moved to Quote sent`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const won = lead.stage === 'Closed';
  const status = quote?.status ?? 'Draft';

  return <>
    <PanelHead title="Quote" sub={quote ? `${quote.ref}${quote.version > 1 ? ` · revision ${quote.version}` : ''}` : 'Starts with the BOM product and quantity — enter the rate, charges and terms.'}
      badge={won && quote ? <Badge tone="success">Won</Badge> : <Badge>{quote ? status : 'Not saved'}</Badge>}
      actions={<>
        <Button icon={<Eye size={15} />} onClick={() => setPreview(true)}>Preview</Button>
        <Button icon={<Download size={15} />} onClick={download}>PDF</Button>
        {draft && <Button icon={<Save size={15} />} onClick={() => saveDraft(quote ? 'Draft saved' : 'Quote draft created')}>Save draft</Button>}
        {draft && <Button variant="primary" icon={<Send size={15} />} disabled={busy} onClick={markSent}>Mark as sent</Button>}
        {!draft && !won && <Button icon={<RotateCcw size={15} />} onClick={() => { const r = attempt(() => useStore.getState().reviseQuote(quote!.id), 'Revision started'); if (r.ok) setF(p => ({ ...p, status: 'Draft', version: (quote!.version + 1) })); else setErr(r.error); }}>Revise</Button>}
      </>} />
    <div className="card-pad">
      {won && quote && <div className="won-banner mb16"><Trophy size={16} />This quote won the deal{quote.sentAt ? ` · sent ${fmtDate(quote.sentAt)}` : ''}.</div>}
      {!draft && !won && <div className="mb12"><Alert kind="info">Sent on {fmtDateTime(quote!.sentAt)}. To change it, start a revision. Close the lead as won once the client confirms.</Alert></div>}
      {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
      {draft ? <div className="grid g4">
          <Field label="Quote date" htmlFor="q-d"><Input id="q-d" type="date" disabled={!draft} value={f.date} onChange={e => set('date', e.target.value)} /></Field>
          <Field label="Valid for (days)" htmlFor="q-v"><NumInput id="q-v" disabled={!draft} value={f.validDays} onChange={n => set('validDays', n)} /></Field>
          <Field label="Discount %" htmlFor="q-disc"><NumInput id="q-disc" disabled={!draft} value={f.discountPct} onChange={n => set('discountPct', Math.min(100, n))} /></Field>
          <Field label="GST %" htmlFor="q-gst"><NumInput id="q-gst" disabled={!draft} value={f.gstPct} onChange={n => set('gstPct', n)} /></Field>
        </div> : <dl className="sum-grid">
        <div><dt>Quote date</dt><dd>{fmtDate(f.date)}</dd></div><div><dt>Valid for</dt><dd>{f.validDays} days</dd></div>
        <div><dt>Discount</dt><dd>{f.discountPct}%</dd></div><div><dt>GST</dt><dd>{f.gstPct}%</dd></div>
        <div><dt>Payment terms</dt><dd>{f.paymentTerms || '—'}</dd></div><div><dt>Delivery terms</dt><dd>{f.deliveryTerms || '—'}</dd></div></dl>}
      <div className="row mt16" style={{ marginBottom: 8 }}><div className="section-title" style={{ margin: 0 }}>Pricing</div><div className="spacer" />
        {draft && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => set('lines', linesFromBom(db, lead.id))}>Reload lines from BOM</Button>}</div>
      <PriceLinesEditor lines={f.lines} readOnly={!draft} onChange={l => set('lines', l)} />
      <div className="row mt16" style={{ alignItems: 'flex-start', gap: 24 }}>
        <div style={{ flex: 1, minWidth: 0 }} className="col">{draft ? <>
          <Field label="Payment terms" htmlFor="q-pt" hint={!db.settings?.quotePaymentTerms ? 'Set a default in Settings → Company' : undefined}><Input id="q-pt" disabled={!draft} placeholder="e.g. 30 days from dispatch" value={f.paymentTerms} onChange={e => set('paymentTerms', e.target.value)} /></Field>
          <div className="mt8" />
          <Field label="Delivery terms" htmlFor="q-dt"><Input id="q-dt" disabled={!draft} placeholder="e.g. Door delivery to site" value={f.deliveryTerms} onChange={e => set('deliveryTerms', e.target.value)} /></Field>
          <div className="mt8" />
          <Field label="Terms and conditions" htmlFor="q-tc"><Textarea id="q-tc" disabled={!draft} rows={3} placeholder="Your standard quote terms (default from Settings → Company)" value={f.terms} onChange={e => set('terms', e.target.value)} /></Field>
          </> : <><div className="section-title" style={{ marginTop: 0 }}>Terms and conditions</div><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{f.terms || <span className="faint">None</span>}</div></>}
        </div>
        <div style={{ width: 300 }} className="card card-pad">
          <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
            <dt>Subtotal</dt><dd className="right">{inr(t.subtotal, { decimals: true })}</dd>
            <dt>Discount</dt><dd className="right">− {inr(t.discount, { decimals: true })}</dd>
            <dt><label htmlFor="q-fr">Freight</label></dt><dd>{draft ? <NumInput id="q-fr" className="right" value={f.freight} onChange={n => set('freight', n)} style={{ height: 30 }} /> : <div className="right">{inr(+f.freight, { decimals: true })}</div>}</dd>
            <dt>GST ({f.gstPct}%)</dt><dd className="right">{inr(t.gst, { decimals: true })}</dd>
            <dt className="strong" style={{ color: 'var(--text)' }}>Grand total</dt><dd className="right strong" style={{ fontSize: 16 }}>{inr(t.total, { decimals: true })}</dd>
          </dl>
        </div>
      </div>
    </div>
    {preview && <Modal size="lg" title={`Preview · ${liveQuote.ref}`} subtitle="This is exactly what the PDF contains." onClose={() => setPreview(false)}
      footer={<><Button onClick={() => setPreview(false)}>Close</Button><Button variant="primary" icon={<Download size={15} />} onClick={download}>Download PDF</Button></>}>
      <DocPreview spec={specOf(liveQuote)} />
    </Modal>}
  </>;
}

/* =================================================================== Client PO */

function ClientPOPanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const cpo = clientPoForLead(db, lead.id);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // "Use sample file" offers a generated, clearly labelled fictional PO; nothing is attached until the user picks it.
  const sample = () => {
    const d = useStore.getState().db, q = quoteForLead(d, lead.id);
    return sampleClientPoFile(d, lead, { poNumber: sampleClientPoNumber(d, lead), lines: q?.lines ?? [], amount: q ? Math.round(quoteTotals(q).total * 100) / 100 : 0, paymentTerms: q?.paymentTerms ?? '' });
  };
  const act = (fn: () => Promise<void>) => fn().catch(e => toastError((e as Error).message));
  const save = async () => {
    if (!file) return setErr('Choose the Client PO file to upload.');
    setBusy(true);
    try {
      const meta = await storeFile(file);
      const r = attempt(() => useStore.getState().saveClientPO(lead.id, { file: meta }), 'Client PO uploaded');
      if (r.ok) { setErr(''); setFile(null); } else setErr(r.error);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (cpo) return <>
    <PanelHead title="Client purchase order" sub="The client's PO document, linked to this deal and listed in Documents. Read-only once uploaded." badge={<Badge tone="success">Received</Badge>}
      actions={cpo.file && <><Button size="sm" icon={<Eye size={14} />} onClick={() => act(() => openFile(cpo.file!))}>View</Button>
        <Button size="sm" icon={<Download size={14} />} onClick={() => act(() => downloadFile(cpo.file!))}>Download</Button></>} />
    <div className="card-pad">
      <dl className="sum-grid">
        <div><dt>Document</dt><dd>{cpo.file ? <FileLink meta={cpo.file} compact /> : <span className="faint">No file</span>}</dd></div>
        {cpo.poNumber && <div><dt>Client PO number</dt><dd className="mono">{cpo.poNumber}</dd></div>}
        <div><dt>Uploaded</dt><dd>{fmtDateTime(cpo.createdAt)}</dd></div>
        {cpo.file && <div><dt>Documents</dt><dd><button className="link" onClick={() => nav(`documents?q=${encodeURIComponent(cpo.file!.name)}`)}>Open in Documents</button></dd></div>}
      </dl>
    </div>
  </>;
  return <>
    <PanelHead title="Client purchase order" sub="Upload the client's PO document after the deal is won. Payment and delivery terms are entered on the sales order." />
    <div className="card-pad">
      {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
      <Field label="Client PO document" required><FilePick file={file} onChange={f => { setFile(f); setErr(''); }} sample={sample} label="Choose file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xlsx" /></Field>
      <div className="row mt12"><span className="muted small">Saved files can be viewed and downloaded here and in Documents. The upload can't be edited afterwards.</span><div className="spacer" />
        <Button variant="primary" icon={<Upload size={14} />} disabled={busy || !file} onClick={save}>{busy ? 'Uploading…' : 'Save Client PO'}</Button></div>
    </div>
  </>;
}

/* =================================================================== SO */

function SOPanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const so = soForLead(db, lead.id);
  const cpo = clientPoForLead(db, lead.id)!;
  const [gen, setGen] = useState(false);
  const [preview, setPreview] = useState(false);
  if (!so) return <>
    <PanelHead title="Sales order" sub={`For Client PO ${clientPoLabel(cpo)}. Items come from the won quote; enter or review the terms.`} actions={<Button variant="primary" icon={<FileText size={15} />} onClick={() => setGen(true)}>Generate SO</Button>} />
    <Empty icon={<FileText size={20} />} title="No sales order yet" body="Generate the SO, enter or review items and terms, preview it, then confirm. MO planning starts after confirmation."
      action={<Button variant="primary" onClick={() => setGen(true)}>Generate SO</Button>} />
    {gen && <GenerateSOModal lead={lead} onClose={() => setGen(false)} />}
  </>;
  const spec = soSpec(so, lead, clientPoLabel(cpo), cpo.poDate);
  const doc = db.documents.find(d => d.id === so.documentId);
  return <>
    <PanelHead title="Sales order" sub={so.ref} badge={<Badge tone="success">Confirmed</Badge>}
      actions={<><Button icon={<Eye size={15} />} onClick={() => setPreview(true)}>Preview</Button>
        <Button icon={<Download size={15} />} onClick={() => downloadBlob(buildPdf(spec), `${so.ref}.pdf`)}>PDF</Button></>} />
    <div className="card-pad">
      <KV items={[['SO number', <span className="mono">{so.ref}</span>], ['SO date', fmtDate(so.date)], ['Client PO', cpo.file ? <FileLink meta={cpo.file} compact /> : clientPoLabel(cpo)],
        ['Expected delivery', fmtDate(so.expectedDelivery)], ['Payment terms', so.paymentTerms], ['Delivery terms', so.deliveryTerms], ['Delivery address', so.deliveryAddress],
        ['Order total', <b>{inr(so.total, { decimals: true })}</b>], ['Document', doc ? <FileLink meta={doc.file} /> : '']]} />
      <div className="section-title mt24">Items</div>
      <PriceLinesEditor lines={so.lines} readOnly />
    </div>
    {preview && <Modal size="lg" title={`Preview · ${so.ref}`} onClose={() => setPreview(false)} footer={<Button onClick={() => setPreview(false)}>Close</Button>}><DocPreview spec={spec} /></Modal>}
  </>;
}

function GenerateSOModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const db = useStore(s => s.db);
  const cpo = clientPoForLead(db, lead.id)!;
  const quote = quoteForLead(db, lead.id);
  // Items and charges come from the won quote; terms start from the quote (or an older structured Client PO) and are
  // entered/reviewed here — they are never read from the uploaded PO document.
  const [f, setF] = useState({
    date: todayISO(), expectedDelivery: addDays(todayISO(), 28), lines: (cpo.lines.length ? cpo.lines : quote?.lines ?? []).map(l => ({ ...l, id: uid() })),
    discountPct: quote?.discountPct ?? 0, freight: quote?.freight ?? 0, gstPct: quote?.gstPct ?? 18,
    paymentTerms: cpo.paymentTerms || quote?.paymentTerms || '', deliveryTerms: cpo.deliveryTerms || quote?.deliveryTerms || '',
    deliveryAddress: cpo.deliveryAddress || '', terms: cpo.terms || quote?.terms || '',
  });
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }));
  const nextRef = `SO-${new Date().getFullYear()}-${String((db.counters['SO'] ?? 0) + 1).padStart(4, '0')}`;
  const spec = soSpec({ ...f, ref: nextRef }, lead, clientPoLabel(cpo), cpo.poDate);
  const total = quoteTotals(f).total;
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const so = await useStore.getState().createSO(lead.id, f, ref => specToStoredPdf(soSpec({ ...f, ref }, lead, clientPoLabel(cpo), cpo.poDate), `${ref}.pdf`));
      toast(`${so.ref} generated`); onClose();
    } catch (e) { setErr((e as Error).message); setView('edit'); } finally { setBusy(false); }
  };
  const diff = cpo.amount > 0 && Math.abs(total - cpo.amount) > 1;
  return <Modal size="lg" title="Generate sales order" subtitle={`For Client PO ${clientPoLabel(cpo)}. Items come from the won quote. Enter or review the terms agreed with the client.`} onClose={onClose}
    footer={<><span className="muted small" style={{ marginRight: 'auto' }}>Order total {inr(total, { decimals: true })}</span><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={<Check size={15} />} disabled={busy} onClick={confirm}>{busy ? 'Generating…' : `Confirm ${nextRef}`}</Button></>}>
    <div className="row mb16">
      <div className="seg" role="group" aria-label="Mode"><button aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Eye size={14} />Preview</button><button aria-pressed={view === 'edit'} onClick={() => setView('edit')}>Edit details</button></div>
      {diff && <span className="small" style={{ color: 'var(--warning)' }}>Note: SO total differs from the Client PO amount ({inr(cpo.amount)}).</span>}
    </div>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    {view === 'preview' ? <DocPreview spec={spec} /> : <>
      <div className="grid g3">
        <Field label="SO date" htmlFor="s-d"><Input id="s-d" type="date" value={f.date} onChange={e => set('date', e.target.value)} /></Field>
        <Field label="Expected delivery" htmlFor="s-ed"><Input id="s-ed" type="date" value={f.expectedDelivery} onChange={e => set('expectedDelivery', e.target.value)} /></Field>
        <Field label="GST %" htmlFor="s-g"><NumInput id="s-g" value={f.gstPct} onChange={n => set('gstPct', n)} /></Field>
        <Field label="Discount %" htmlFor="s-dc"><NumInput id="s-dc" value={f.discountPct} onChange={n => set('discountPct', Math.min(100, n))} /></Field>
        <Field label="Freight (₹)" htmlFor="s-fr"><NumInput id="s-fr" value={f.freight} onChange={n => set('freight', n)} /></Field>
      </div>
      <div className="section-title mt16">Items</div>
      <PriceLinesEditor lines={f.lines} onChange={l => set('lines', l)} />
      <div className="section-title mt16 row" style={{ gap: 6 }}>Terms<InfoTip text="Enter or review the terms agreed with the client. They are not read from the uploaded Client PO." /></div>
      <div className="form-grid">
        <Field label="Payment terms" required htmlFor="s-pt" hint='e.g. "45 days from dispatch" — used for the receivable due date'><Input id="s-pt" value={f.paymentTerms} onChange={e => set('paymentTerms', e.target.value)} /></Field>
        <Field label="Delivery terms" htmlFor="s-dt"><Input id="s-dt" value={f.deliveryTerms} onChange={e => set('deliveryTerms', e.target.value)} /></Field>
        <Field label="Delivery address" required full htmlFor="s-ad"><Textarea id="s-ad" rows={2} value={f.deliveryAddress} onChange={e => set('deliveryAddress', e.target.value)} /></Field>
        <Field label="Terms and conditions" full htmlFor="s-tc"><Textarea id="s-tc" rows={3} value={f.terms} onChange={e => set('terms', e.target.value)} /></Field>
      </div>
    </>}
  </Modal>;
}

/* =================================================================== MO */

function MOPanel({ lead }: { lead: Lead }) {
  const db = useStore(s => s.db);
  const mo = moForLead(db, lead.id);
  const bom = bomForLead(db, lead.id)!;
  const so = soForLead(db, lead.id)!;
  const match = soBomMatch(so, bom);
  const [planned, setPlanned] = useState(() => { const d = so.expectedDelivery ? addDays(so.expectedDelivery, -7) : addDays(todayISO(), 21); const min = addDays(todayISO(), 1); return d < min ? min : d; });
  const [recQty, setRecQty] = useState(match.suggestedQty);
  // Only a mismatch needs a note; the user still confirms with "Reconcile & save MO".
  const [recNote, setRecNote] = useState(() => match.matched ? '' : `SO ${so.ref} quantity differs from the BOM (${bom.outputQty} ${bom.outputUnit}); BOM scaled to the SO quantity.`);
  const [err, setErr] = useState('');
  const qty = match.matched ? bom.outputQty : recQty;
  const factor = bom.outputQty > 0 && qty > 0 ? qty / bom.outputQty : 1;
  const plan = useMemo(() => bom.lines.map(l => {
    const m = materialById(db, l.materialId);
    const need = round3(l.qty * factor);
    const avail = availableQty(db, l.materialId);
    return { m, required: need, onHand: m?.onHand ?? 0, avail, reserve: round3(Math.min(avail, need)), short: round3(Math.max(0, need - avail)) };
  }), [db, bom, factor]);

  if (!mo) {
    const shorts = plan.filter(p => p.short > 0).length;
    const soLines = so.lines.map(l => fq(l.qty, l.unit)).join(', ');
    return <>
      <PanelHead title="Manufacturing order" sub={`Built from ${so.ref} and ${bom.ref}. Saving reserves available stock (never more than is free) and raises one PR for any shortfall.`} />
      <div className="card-pad">
        {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
        {!match.matched && <div className="card card-pad mb12" style={{ borderColor: 'var(--warning)' }}>
          <div className="row mb8" style={{ gap: 6 }}><b>Reconcile quantities before creating the MO</b>
            <InfoTip text="The SO has no line in the BOM's output unit with the same quantity. Confirm what to manufacture; material requirements are scaled from the BOM." /></div>
          <div className="small muted mb12">BOM output: <b>{fq(bom.outputQty, bom.outputUnit)}</b> · SO lines: <b>{soLines}</b></div>
          <div className="grid" style={{ gridTemplateColumns: '180px minmax(0,1fr)' }}>
            <Field label={`Manufacture (${bom.outputUnit})`} required htmlFor="mo-rq"><NumInput id="mo-rq" value={recQty} onChange={setRecQty} /></Field>
            <Field label="Reconciliation note" required htmlFor="mo-rn"><Input id="mo-rn" value={recNote} onChange={e => setRecNote(e.target.value)} placeholder="e.g. SO is for 12 sets; BOM was drawn for 10 — scale up" /></Field>
          </div>
        </div>}
        <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
          <table className="tbl tbl-compact"><thead><tr><th style={{ minWidth: 260 }}>Material</th><th className="num">Required</th><th className="num">On hand</th><th className="num">Available</th><th className="num">Will reserve</th><th className="num">Shortfall</th></tr></thead>
            <tbody>{plan.map(p => <tr key={p.m?.id}><td>{p.m?.code} · {p.m?.name}</td><td className="num">{fq(p.required, p.m?.unit)}</td><td className="num muted">{fq(p.onHand)}</td>
              <td className="num muted">{fq(p.avail)}</td><td className="num">{fq(p.reserve)}</td>
              <td className="num" style={{ color: p.short ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{p.short ? fq(p.short, p.m?.unit) : 'None'}</td></tr>)}</tbody></table>
        </div>
        <div className="row mt12" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div style={{ width: 200 }}><Field label="Planned completion date" htmlFor="mo-pd"><Input id="mo-pd" type="date" value={planned} onChange={e => setPlanned(e.target.value)} /></Field></div>
          <span className="small" style={{ color: shorts ? 'var(--warning)' : 'var(--success)' }}>{shorts ? `${shorts} material(s) short → one purchase request will be raised` : 'All materials available'}</span>
          <div className="spacer" />
          <Button variant="primary" icon={<Factory size={15} />} disabled={!match.matched && (!(recQty > 0) || !recNote.trim())} onClick={() => {
            const r = attempt(() => useStore.getState().createMO(lead.id, planned, match.matched ? undefined : { qty: recQty, note: recNote }));
            if (!r.ok) return setErr(r.error);
            toast(shorts ? `${r.value.ref} created · stock reserved · purchase request raised` : `${r.value.ref} created · all materials reserved`);
          }}>{match.matched ? 'Save MO & reserve stock' : 'Reconcile & save MO'}</Button>
        </div>
      </div>
    </>;
  }
  const st = moMaterialStatus(db, mo);
  const prs = prsForMO(db, mo.id);
  const open = moOpenShortfall(db, mo);
  const pending = prs.some(p => p.status === 'Pending');
  const stage = db.stages.find(s => s.id === mo.stageId);
  const requestBalance = () => { const r = attempt(() => useStore.getState().raiseShortfallPR(mo.id)); if (r.ok) toast(`${r.value.ref} raised for the remaining shortfall`); else toastError(r.error); };
  const rejected = prs.some(p => p.status === 'Rejected');
  return <>
    <PanelHead title="Manufacturing order" sub={`${mo.ref} · ${fq(mo.qty, mo.unit)} of ${mo.productName}`}
      badge={<Badge tone={mo.fgPosted ? 'success' : st.ready ? 'info' : 'danger'}>{mo.fgPosted ? 'Finished goods ready' : mo.materialsIssued ? 'Materials issued' : st.ready ? 'Fully reserved' : 'Short'}</Badge>}
      actions={<>{!mo.materialsIssued && !st.ready && <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => { const r = attempt(() => useStore.getState().allocateMO(mo.id)); if (r.ok) toast(r.value > 0 ? 'More stock reserved' : 'No additional stock available yet'); else toastError(r.error); }}>Re-check stock</Button>}
        <Button size="sm" variant="primary" icon={<ArrowRight size={14} />} onClick={() => nav(`manufacturing?focus=${encodeURIComponent(mo.id)}`)}>Open in Manufacturing</Button></>} />
    <div className="card-pad">
      {open.length > 0 && !mo.materialsIssued && <div className="mb12"><Alert kind={rejected ? 'error' : 'warning'}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span><b>{mo.ref} is blocked:</b> {open.map(o => `${o.material?.name} ${fq(o.uncovered, o.material?.unit)}`).join(', ')} not covered by any open PR or PO{rejected ? ' (a PR was rejected)' : ' (partly approved)'}.</span>
          <Button size="sm" variant="primary" disabled={pending} title={pending ? 'A PR for this MO is still pending' : undefined} onClick={requestBalance}>{rejected && !prs.some(p => p.status === 'Approved') ? 'Raise new PR' : 'Request balance'}</Button>
        </div></Alert></div>}
      <dl className="sum-grid"><div><dt>Line</dt><dd>{mo.line ?? 'Unassigned'}</dd></div><div><dt>Stage</dt><dd>{stage?.name}</dd></div>
        <div><dt>Planned date</dt><dd>{fmtDate(mo.plannedDate)}</dd></div><div><dt>Sales order</dt><dd className="mono">{so.ref}</dd></div>
        {mo.reconciliation && <div style={{ gridColumn: 'span 2' }}><dt>Quantity reconciliation</dt><dd>BOM {fq(mo.reconciliation.bomOutput, mo.unit)} → MO {fq(mo.qty, mo.unit)} · “{mo.reconciliation.note}” · {mo.reconciliation.by}</dd></div>}</dl>
      <div className="section-title mt16">Purchase requests</div>
      {prs.length ? <div className="col" style={{ gap: 4 }}>{prs.map(pr => { const po = pr.poId ? db.supplierPOs.find(x => x.id === pr.poId) : undefined;
        return <div key={pr.id} className="row small" style={{ gap: 6 }}><a className="link mono" href={`#/procurement/prs?q=${pr.ref}`}>{pr.ref}</a><Badge>{pr.status}</Badge>
          <span className="muted">{pr.lines.map(l => `${materialById(db, l.materialId)?.name ?? '?'} ${fq(l.qty)}`).join(', ')}</span>
          {po && <a className="link" href={`#/procurement/pos?q=${po.ref}`}>→ {po.ref} · {po.status === 'Details required' ? po.status : po.receiptStatus}</a>}</div>; })}</div>
        : <div className="muted small">None needed.</div>}
      <div className="section-title mt16">Materials</div>
      <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
        <table className="tbl tbl-compact"><thead><tr><th style={{ minWidth: 260 }}>Material</th><th className="num">Required</th><th className="num">Available</th><th className="num">Reserved</th><th className="num">Issued</th><th className="num">Shortfall</th></tr></thead>
          <tbody>{st.rows.map(r => <tr key={r.materialId}><td>{r.material?.code} · {r.material?.name}</td><td className="num">{fq(r.required, r.material?.unit)}</td>
            <td className="num muted">{fq(r.available)}</td><td className="num">{fq(r.reserved)}</td><td className="num">{fq(r.issued)}</td>
            <td className="num" style={{ color: r.shortfall ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{r.shortfall ? fq(r.shortfall, r.material?.unit) : '—'}</td></tr>)}</tbody></table>
      </div>
    </div>
  </>;
}
