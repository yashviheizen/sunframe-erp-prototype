import { useState } from 'react';
import { Plus, ClipboardList, ShoppingCart, Building2, FileSpreadsheet, Check, X, Save, Download, PackageCheck, Trash2, Pencil, Eye, Info } from 'lucide-react';
import { useStore, isAdmin, currentUser, materialById, supplierById, poTotal, getDB, moOpenShortfall } from '../store';
import { samplePR, samplePO, sampleRate, sampleGrnFile, sampleSupplier, sampleQuotationRef, sampleQuotationFile } from '../lib/samples';
import type { PurchaseRequest, PRLine, POLine, SupplierPO, Supplier } from '../lib/types';
import { PRODUCT_CATEGORIES } from '../lib/types';
import { inr, fmtDate, fmtShort, fmtDateTime, todayISO, addDays, uid, qty as fq } from '../lib/format';
import { poSpec, specToStoredPdf } from '../lib/docs';
import { buildPdf } from '../lib/pdf';
import { downloadBlob, storeFile } from '../lib/files';
import { PageHead, Button, Badge, SearchBox, Empty, Drawer, Modal, Field, Input, NumInput, Select, Textarea, Alert, FilePick, FileLink, KV, Tabs, InfoTip, Cols, IconAction, useList, attempt, toast, toastError } from '../ui/kit';
import { MaterialSelect, DocPreview } from '../ui/shared';
import { nav, routeQuery } from '../ui/router';

type Tab = 'prs' | 'pos' | 'suppliers' | 'quotations';

export default function Procurement({ tab = 'prs' }: { tab?: string }) {
  const db = useStore(s => s.db);
  const t = (['prs', 'pos', 'suppliers', 'quotations'].includes(tab) ? tab : 'prs') as Tab;
  const me = currentUser(db), admin = isAdmin(db);
  const visiblePRs = db.prs.filter(p => admin || p.raisedById === me.id);
  return <>
    <PageHead title="Procurement" sub="Purchase requests, supplier purchase orders, suppliers and their quotations." />
    <Tabs<Tab> value={t} onChange={k => nav(`procurement/${k}`)} tabs={[
      { key: 'prs', label: 'Purchase requests', count: visiblePRs.length },
      { key: 'pos', label: 'Supplier purchase orders', count: db.supplierPOs.length },
      { key: 'suppliers', label: 'Suppliers', count: db.suppliers.length },
      { key: 'quotations', label: 'Supplier quotations', count: db.supplierQuotations.length },
    ]} />
    {t === 'prs' && <PRTab />}
    {t === 'pos' && <POTab />}
    {t === 'suppliers' && <SupplierTab />}
    {t === 'quotations' && <QuotationTab />}
  </>;
}

const prSummary = (db: ReturnType<typeof getDB>, lines: { materialId: string; qty: number }[]) =>
  lines.map(l => { const m = materialById(db, l.materialId); return `${m?.name ?? '?'} ${fq(l.qty, m?.unit)}`; }).join(', ');

/** Table cell: first material name, with its quantity (and "+N items") on a second line that never truncates. Full list is in the drawer. */
function ItemsCell({ lines }: { lines: { materialId: string; qty: number }[] }) {
  const db = useStore(s => s.db);
  const first = lines[0], m = first && materialById(db, first.materialId);
  if (!first) return <td><span className="faint">—</span></td>;
  const more = lines.length - 1;
  return <td title={prSummary(db, lines)}>
    <div className="items-name">{m?.name ?? 'Removed material'}</div>
    <div className="sub nowrap">{fq(first.qty, m?.unit)}{more > 0 && <span className="more"> · +{more} item{more === 1 ? '' : 's'}</span>}</div>
  </td>;
}

/** One compact line near the toolbar for the selected tab ("5 pending"), instead of chips on every tab. */
function AttnNote({ n, label, onClick, active }: { n: number; label: string; onClick?: () => void; active?: boolean }) {
  if (!n) return null;
  const body = <><i className="attn-dot" aria-hidden />{n} {label}</>;
  return onClick ? <button className={'attn-note link' + (active ? ' on' : '')} aria-pressed={active} title={active ? 'Show all' : `Show only ${label}`} onClick={onClick}>{body}</button>
    : <span className="attn-note">{body}</span>;
}

const SOURCE_LABEL: Record<PurchaseRequest['source'], string> = { Manual: 'Manual', 'Material shortfall': 'MO shortfall' };
const raisedBy = (p: PurchaseRequest) => p.source === 'Material shortfall' ? 'System' : p.raisedByName;

/* =================================================================== PRs */

function PRTab() {
  const db = useStore(s => s.db);
  const me = currentUser(db), admin = isAdmin(db);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState(() => routeQuery('q'));
  const ql = q.trim().toLowerCase();
  const prs = db.prs.filter(p => (admin || p.raisedById === me.id) && (!status || p.status === status) && (!ql || [p.ref, p.raisedByName, p.notes,
    db.mos.find(m => m.id === p.moId)?.ref, db.supplierPOs.find(x => x.id === p.poId)?.ref, prSummary(db, p.lines)].some(x => x?.toLowerCase().includes(ql))));
  const pending = db.prs.filter(p => (admin || p.raisedById === me.id) && p.status === 'Pending').length;
  const list = useList(prs, { resetKey: [q, status], sort: { ref: p => p.ref, source: p => SOURCE_LABEL[p.source], req: p => p.requiredBy, by: p => raisedBy(p), status: p => p.status, po: p => db.supplierPOs.find(x => x.id === p.poId)?.ref } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search PR, material, MO, PO…" />
      <Select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 160 }}>
        <option value="">All statuses</option><option>Pending</option><option>Approved</option><option>Rejected</option></Select>
      <span className="muted small row" style={{ gap: 4 }}>{admin ? 'All PRs' : 'My PRs'}<InfoTip text={admin ? 'Admin view: all purchase requests, including automatic MO shortfalls.' : `Showing only PRs raised by ${me.name}. Admins see all PRs.`} /></span>
      <AttnNote n={pending} label={admin ? 'pending approval' : 'pending'} active={status === 'Pending'} onClick={() => setStatus(status === 'Pending' ? '' : 'Pending')} />
      <div className="spacer" />
      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add PR</Button>
    </div>
    {!prs.length ? <Empty icon={<ClipboardList size={20} />} title={ql || status ? 'No PRs match' : db.prs.length && !admin ? 'You have not raised any PRs' : 'No purchase requests'}
      body="PRs are raised manually here, or automatically when an MO is short of material." action={<Button variant="primary" onClick={() => setAdding(true)}>Add PR</Button>} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[132, 120, undefined, 100, 128, 108, 136]} />
        <thead><tr>{list.th('ref', 'PR')}{list.th('source', 'Source')}<th>Materials</th>{list.th('req', 'Required by')}{list.th('by', 'Raised by')}{list.th('status', 'Status')}{list.th('po', 'Supplier PO')}</tr></thead>
        <tbody>{list.rows.map(p => {
          const po = db.supplierPOs.find(x => x.id === p.poId);
          const mo = db.mos.find(m => m.id === p.moId);
          return <tr key={p.id} className="clickable" tabIndex={0} onClick={() => setOpen(p.id)} onKeyDown={e => e.key === 'Enter' && setOpen(p.id)}>
            <td><div className="primary-cell mono">{p.ref}</div><div className="sub" title={fmtDate(p.createdAt)}>{fmtShort(p.createdAt)}</div></td>
            <td><div>{SOURCE_LABEL[p.source]}</div>{mo && <a className="sub link mono" href={`#/manufacturing/orders?q=${encodeURIComponent(mo.ref)}`} title={`Open ${mo.ref}`} onClick={e => e.stopPropagation()}>{mo.ref}</a>}</td>
            <ItemsCell lines={p.lines} />
            <td className="muted nowrap" title={fmtDate(p.requiredBy)}>{fmtShort(p.requiredBy)}</td>
            <td className={p.source === 'Material shortfall' ? 'muted' : undefined} title={p.source === 'Material shortfall' ? (/^system/i.test(p.raisedByName) ? 'Raised automatically for an MO shortfall' : `Raised automatically for an MO shortfall (triggered by ${p.raisedByName})`) : p.raisedByName}>{raisedBy(p)}</td>
            <td><Badge>{p.status}</Badge></td>
            <td>{po ? <><div className="mono">{po.ref}</div><div className="sub">{po.receiptStatus === 'Received' ? 'Goods received' : po.status}</div></> : <span className="faint">—</span>}</td>
          </tr>;
        })}</tbody></table></div>{list.pager}</>}
    {adding && <AddPRModal onClose={() => setAdding(false)} />}
    {open && <PRDrawer id={open} onClose={() => setOpen(null)} />}
  </div>;
}

function AddPRModal({ onClose }: { onClose: () => void }) {
  // Demo prefill: the tightest material at a typical reorder quantity. Nothing is approved until an admin acts.
  const [init] = useState(() => samplePR(useStore.getState().db));
  const [lines, setLines] = useState(init.lines);
  const [requiredBy, setRB] = useState(addDays(todayISO(), 14));
  const [notes, setNotes] = useState(init.notes);
  const [err, setErr] = useState('');
  const db = useStore(s => s.db);
  const save = () => {
    const r = attempt(() => useStore.getState().addPR({ lines, requiredBy, notes }));
    if (!r.ok) return setErr(r.error);
    toast(`${r.value.ref} raised · awaiting admin approval`); onClose();
  };
  return <Modal title="Add purchase request" subtitle={`Raised by ${currentUser(db).name}. An admin approves it, which creates a supplier PO.`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Raise PR</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
      <thead><tr><th>Material</th><th className="num" style={{ width: 140 }}>Quantity</th><th style={{ width: 60 }}>Unit</th><th style={{ width: 40 }} /></tr></thead>
      <tbody>{lines.map((l, i) => <tr key={l.id}>
        <td><MaterialSelect label={`Line ${i + 1} material`} value={l.materialId} exclude={lines.map(x => x.materialId)} showAvail onChange={id => setLines(ls => ls.map(x => x.id === l.id ? { ...x, materialId: id } : x))} /></td>
        <td><NumInput aria-label={`Line ${i + 1} quantity`} className="right" value={l.qty} onChange={n => setLines(ls => ls.map(x => x.id === l.id ? { ...x, qty: n } : x))} /></td>
        <td className="muted">{materialById(db, l.materialId)?.unit ?? '—'}</td>
        <td><Button size="sm" variant="ghost" iconOnly aria-label="Remove line" disabled={lines.length <= 1} onClick={() => setLines(ls => ls.filter(x => x.id !== l.id))} icon={<Trash2 size={14} />} /></td>
      </tr>)}</tbody>
    </table>
    <Button size="sm" variant="ghost" className="mt8" icon={<Plus size={14} />} onClick={() => setLines(ls => [...ls, { id: uid(), materialId: '', qty: 0 }])}>Add material</Button>
    <div className="form-grid mt16">
      <Field label="Required by" htmlFor="pr-rb"><Input id="pr-rb" type="date" value={requiredBy} onChange={e => setRB(e.target.value)} /></Field>
      <Field label="Notes" full htmlFor="pr-n"><Textarea id="pr-n" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Purpose, preferred supplier, etc." /></Field>
    </div>
  </Modal>;
}

function PRDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useStore(s => s.db);
  const pr = db.prs.find(p => p.id === id)!;
  const admin = isAdmin(db);
  const [lines, setLines] = useState<PRLine[]>(pr.lines);
  const [err, setErr] = useState('');
  const editable = admin && pr.status === 'Pending';
  const dirty = JSON.stringify(lines) !== JSON.stringify(pr.lines);
  const mo = db.mos.find(m => m.id === pr.moId);
  const po = db.supplierPOs.find(p => p.id === pr.poId);
  const approve = () => {
    const s = useStore.getState();
    if (dirty) { const r = attempt(() => s.updatePRLines(pr.id, lines)); if (!r.ok) return setErr(r.error); }
    const r = attempt(() => s.approvePR(pr.id));
    if (!r.ok) return setErr(r.error);
    toast(`${pr.ref} approved · ${r.value.ref} created — add supplier, price and terms`);
    onClose(); nav('procurement/pos');
  };
  return <Drawer title={pr.ref} subtitle={<span className="row"><span className="muted">{SOURCE_LABEL[pr.source]}</span><Badge>{pr.status}</Badge></span>} onClose={onClose}
    footer={editable ? <>
      <Button variant="danger" icon={<X size={15} />} onClick={() => { const r = attempt(() => useStore.getState().rejectPR(pr.id), `${pr.ref} rejected`); if (r.ok) onClose(); else setErr(r.error); }}>Reject</Button>
      {dirty && <Button icon={<Save size={15} />} onClick={() => { const r = attempt(() => useStore.getState().updatePRLines(pr.id, lines), 'Quantities updated'); if (!r.ok) setErr(r.error); }}>Save quantities</Button>}
      <Button variant="success" icon={<Check size={15} />} onClick={approve}>Approve{dirty ? ' with edits' : ''}</Button>
    </> : undefined}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    {pr.status === 'Pending' && !admin && <div className="mb12"><Alert kind="info">Waiting for an admin to approve.</Alert></div>}
    {mo && pr.status !== 'Pending' && (() => {
      const open = moOpenShortfall(db, mo);
      if (!open.length || mo.materialsIssued) return null;
      const pending = db.prs.some(p => p.moId === mo.id && p.status === 'Pending');
      return <div className="mb12"><Alert kind={pr.status === 'Rejected' ? 'error' : 'warning'}>
        <div><b>{mo.ref} is blocked</b> — still uncovered: {open.map(o => `${o.material?.name} ${fq(o.uncovered, o.material?.unit)}`).join(', ')}.</div>
        <div className="row mt8" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" disabled={pending} onClick={() => { const r = attempt(() => useStore.getState().raiseShortfallPR(mo.id)); if (r.ok) { toast(`${r.value.ref} raised for the balance`); onClose(); } else setErr(r.error); }}>
            {pr.status === 'Rejected' ? 'Raise new PR for shortfall' : 'Request balance'}</Button>
          {mo.leadId && <a className="link small" href={`#/sales/${mo.leadId}`}>Open sales record</a>}
          {pending && <span className="small muted">Another PR for this MO is pending.</span>}
        </div></Alert></div>;
    })()}
    <KV items={[['Source', pr.source === 'Material shortfall' ? `MO shortfall — raised automatically by the system when ${mo?.ref ?? 'the MO'} could not reserve enough stock` : 'Manual request'],
      ['Raised by', pr.source === 'Material shortfall' ? (/^system/i.test(pr.raisedByName) ? 'System' : `System (triggered by ${pr.raisedByName})`) : pr.raisedByName], ['Raised on', fmtDateTime(pr.createdAt)], ['Required by', fmtDate(pr.requiredBy)],
      ['Linked MO', mo ? <a className="link mono" href={`#/manufacturing/orders?q=${encodeURIComponent(mo.ref)}`}>{mo.ref}</a> : ''], ['Decision', pr.decidedAt ? `${pr.status} by ${pr.decidedBy} · ${fmtDateTime(pr.decidedAt)}` : ''],
      ['Supplier PO', po ? <span className="row"><span className="mono">{po.ref}</span><Badge>{po.status}</Badge></span> : ''], ['Notes', pr.notes]]} />
    <div className="section-title mt24">Materials ({lines.length}){editable && <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}> — edit quantities before approving</span>}</div>
    <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)' }}>
      <thead><tr><th>Material</th><th className="num">Requested</th><th className="num" style={{ width: 140 }}>{editable ? 'Approve qty' : 'Quantity'}</th></tr></thead>
      <tbody>{lines.map(l => { const m = materialById(db, l.materialId); return <tr key={l.id}>
        <td>{m?.code} · {m?.name}</td><td className="num muted">{fq(l.requestedQty, m?.unit)}</td>
        <td>{editable ? <NumInput aria-label={`Approved quantity for ${m?.name}`} className="right" value={l.qty} onChange={n => setLines(ls => ls.map(x => x.id === l.id ? { ...x, qty: n } : x))} /> : <div className="right">{fq(l.qty, m?.unit)}</div>}</td>
      </tr>; })}</tbody>
    </table>
  </Drawer>;
}

/* =================================================================== Supplier POs */

function POTab() {
  const db = useStore(s => s.db);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState(() => routeQuery('q'));
  const ql = q.toLowerCase();
  const pos = db.supplierPOs.filter(p => !ql || [p.ref, supplierById(db, p.supplierId)?.name, db.prs.find(x => x.id === p.prId)?.ref].some(x => x?.toLowerCase().includes(ql)));
  const needDetails = db.supplierPOs.filter(p => p.status === 'Details required').length;
  const list = useList(pos, { resetKey: [q], sort: { ref: p => p.ref, sup: p => supplierById(db, p.supplierId)?.name, total: p => p.status === 'Approved' ? poTotal(p) : null, terms: p => p.paymentTermsDays || null, status: p => p.status + ' ' + p.receiptStatus } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search PO, supplier, PR…" />
      <AttnNote n={needDetails} label={needDetails === 1 ? 'needs supplier details' : 'need supplier details'} />
      <div className="spacer" />
      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>New supplier PO</Button>
    </div>
    {!pos.length ? <Empty icon={<ShoppingCart size={20} />} title="No supplier purchase orders" body="Approving a PR creates a PO automatically; you can also create one manually." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[132, undefined, 230, 124, 84, 144]} />
        <thead><tr>{list.th('ref', 'PO')}{list.th('sup', 'Supplier / PR')}<th>Items</th>{list.th('total', 'Total', 'num')}{list.th('terms', 'Terms')}{list.th('status', 'Status')}</tr></thead>
        <tbody>{list.rows.map(p => { const pr = db.prs.find(x => x.id === p.prId)?.ref; return <tr key={p.id} className="clickable" tabIndex={0} onClick={() => setOpen(p.id)} onKeyDown={e => e.key === 'Enter' && setOpen(p.id)}>
          <td><div className="primary-cell mono">{p.ref}</div><div className="sub" title={fmtDate(p.date)}>{fmtShort(p.date)}</div></td>
          <td><div>{supplierById(db, p.supplierId)?.name ?? <span className="faint">Not chosen</span>}</div><div className="sub mono">{pr ? `Against ${pr}` : 'Manual PO'}</div></td>
          <ItemsCell lines={p.lines} />
          <td className="num">{p.status === 'Approved' ? inr(poTotal(p)) : <span className="faint">—</span>}</td>
          <td className="muted nowrap">{p.paymentTermsDays ? `${p.paymentTermsDays} days` : '—'}</td>
          <td><Badge>{p.status}</Badge>{p.status === 'Approved' && <div className="sub">{p.receiptStatus === 'Received' ? 'Goods received' : 'Awaiting receipt'}</div>}</td>
        </tr>; })}</tbody></table></div>{list.pager}</>}
    {open && <PODrawer id={open} onClose={() => setOpen(null)} />}
    {creating && <POFormModal onClose={() => setCreating(false)} onSaved={id => { setCreating(false); setOpen(id); }} />}
  </div>;
}

async function attachPdf(poId: string) {
  const po = getDB().supplierPOs.find(p => p.id === poId);
  if (!po || po.documentId) return;
  const meta = await specToStoredPdf(poSpec(getDB(), po), `${po.ref}.pdf`);
  useStore.getState().attachPODocument(poId, meta);
}

/** Used both to complete an auto-created PO ("Details required") and to create one manually. */
function POFormModal({ po, onClose, onSaved }: { po?: SupplierPO; onClose: () => void; onSaved?: (id: string) => void }) {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  // Demo prefill: saved values stay; blanks get a matching active supplier, last PO rates and 30-day terms.
  // Quantities are never changed (PR-linked POs keep the approved quantities). A pending PR is never preselected.
  const [init] = useState(() => samplePO(useStore.getState().db, po));
  const [prId, setPrId] = useState(po?.prId ?? '');
  const [supplierId, setSup] = useState(init.supplierId);
  const [lines, setLines] = useState<POLine[]>(init.lines);
  const [expectedDelivery, setED] = useState(po?.expectedDelivery || addDays(todayISO(), 10));
  const [terms, setTerms] = useState<30 | 60 | 90 | 0>(init.terms);
  const [quotationIds, setQIds] = useState<string[]>(init.quotationIds);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadingQ, setUploadingQ] = useState(false);
  const eligiblePRs = db.prs.filter(p => !p.poId && p.status !== 'Rejected' && !db.supplierPOs.some(x => x.prId === p.id));
  const pickPR = (id: string) => {
    setPrId(id);
    const pr = db.prs.find(p => p.id === id);
    if (pr) setLines(pr.lines.map(l => ({ id: uid(), materialId: l.materialId, qty: l.qty, rate: sampleRate(db, l.materialId) })));
  };
  const supQuotes = db.supplierQuotations.filter(q => q.supplierId === supplierId);
  const total = lines.reduce((a, l) => a + l.qty * l.rate, 0);
  const save = async () => {
    setBusy(true);
    const r = attempt(() => useStore.getState().savePO({ id: po?.id, supplierId, prId: prId || undefined, lines, expectedDelivery, paymentTermsDays: terms as 30 | 60 | 90, quotationIds }));
    if (!r.ok) { setErr(r.error); setBusy(false); return; }
    try { await attachPdf(r.value.id); } catch (e) { toastError('PO saved, but the PDF could not be generated: ' + (e as Error).message); }
    setBusy(false);
    toast(`${r.value.ref} approved · payable created`);
    onSaved?.(r.value.id); onClose();
  };
  const fromPR = !!po?.prId;
  return <Modal size="lg" title={po ? `Complete ${po.ref}` : 'New supplier PO'} subtitle={po ? 'Status: Details required (assumption). Add supplier, prices and terms; saving makes it Approved.' : 'Optionally pick an approved PR to pre-fill items. Saving approves the PO.'} onClose={onClose}
    footer={<><span className="muted small" style={{ marginRight: 'auto' }}>PO total (excl. GST) <b>{inr(total)}</b></span><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={<Check size={15} />} disabled={busy} onClick={save}>Save & approve PO</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="grid g3">
      {!po && <Field label="Against PR (optional)" htmlFor="po-pr" hint={!admin ? 'Pending PRs can only be used by an admin.' : 'Pending PRs are approved when this PO is saved.'}>
        <Select id="po-pr" value={prId} onChange={e => pickPR(e.target.value)}>
          <option value="">No PR — standalone PO</option>
          {eligiblePRs.map(p => <option key={p.id} value={p.id} disabled={p.status === 'Pending' && !admin}>{p.ref} · {p.status} · {prSummary(db, p.lines).slice(0, 50)}</option>)}
        </Select></Field>}
      {fromPR && <Field label="Against PR"><Input disabled value={db.prs.find(p => p.id === po!.prId)?.ref ?? ''} /></Field>}
      <Field label="Supplier" required htmlFor="po-sup" hint="Inactive suppliers cannot be selected.">
        <Select id="po-sup" value={supplierId} invalid={!supplierId && !!err} onChange={e => { setSup(e.target.value); setQIds([]); }}>
          <option value="">Select supplier…</option>
          {db.suppliers.map(s => <option key={s.id} value={s.id} disabled={!s.active}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}
        </Select></Field>
      <Field label="Payment terms" required htmlFor="po-t"><Select id="po-t" value={terms} onChange={e => setTerms(+e.target.value as 30)}>
        <option value={0}>Select…</option><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option></Select></Field>
      <Field label="Expected delivery" htmlFor="po-ed"><Input id="po-ed" type="date" value={expectedDelivery} onChange={e => setED(e.target.value)} /></Field>
    </div>
    {!db.suppliers.some(s => s.active) && <div className="mt12"><Alert kind="warning">No active suppliers yet. <button className="link" onClick={() => { onClose(); nav('procurement/suppliers'); }}>Add a supplier</button> first.</Alert></div>}
    <div className="section-title mt16">Items</div>
    <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)' }}>
      <thead><tr><th>Material</th><th className="num" style={{ width: 130 }}>Qty</th><th style={{ width: 60 }}>Unit</th><th className="num" style={{ width: 140 }}>Rate (₹)</th><th className="num" style={{ width: 130 }}>Amount</th>{!fromPR && <th style={{ width: 40 }} />}</tr></thead>
      <tbody>{lines.map((l, i) => { const m = materialById(db, l.materialId); return <tr key={l.id}>
        <td>{fromPR || prId ? <span>{m?.code} · {m?.name}</span> : <MaterialSelect label={`Item ${i + 1} material`} value={l.materialId} exclude={lines.map(x => x.materialId)} onChange={id => setLines(ls => ls.map(x => x.id === l.id ? { ...x, materialId: id } : x))} />}</td>
        <td>{fromPR || prId ? <div className="right">{fq(l.qty)}</div> : <NumInput aria-label={`Item ${i + 1} quantity`} className="right" value={l.qty} onChange={n => setLines(ls => ls.map(x => x.id === l.id ? { ...x, qty: n } : x))} />}</td>
        <td className="muted">{m?.unit ?? '—'}</td>
        <td><NumInput aria-label={`Item ${i + 1} rate`} className="right" value={l.rate} onChange={n => setLines(ls => ls.map(x => x.id === l.id ? { ...x, rate: n } : x))} /></td>
        <td className="num">{inr(l.qty * l.rate)}</td>
        {!fromPR && !prId && <td><Button size="sm" variant="ghost" iconOnly aria-label="Remove item" disabled={lines.length <= 1} onClick={() => setLines(ls => ls.filter(x => x.id !== l.id))} icon={<Trash2 size={14} />} /></td>}
      </tr>; })}</tbody>
    </table>
    {!fromPR && !prId && <Button size="sm" variant="ghost" className="mt8" icon={<Plus size={14} />} onClick={() => setLines(ls => [...ls, { id: uid(), materialId: '', qty: 0, rate: 0 }])}>Add item</Button>}
    {(fromPR || prId) && <div className="faint small mt8">Quantities come from the approved PR.</div>}
    <div className="section-title mt16">Attach supplier quotations</div>
    {!supplierId ? <div className="muted small">Choose a supplier to see their uploaded quotations.</div>
      : <div className="col" style={{ gap: 6 }}>
        {!supQuotes.length && <div className="muted small">No quotations uploaded for this supplier yet.</div>}
        {supQuotes.map(q => <label key={q.id} className="row small">
          <input type="checkbox" checked={quotationIds.includes(q.id)} onChange={e => setQIds(ids => e.target.checked ? [...ids, q.id] : ids.filter(x => x !== q.id))} />
          <span className="strong">{q.reference}</span><span className="muted">· {q.category} · {fmtDate(q.date)} · {q.file.name}</span></label>)}
        <div><Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setUploadingQ(true)}>Upload quotation here</Button></div>
      </div>}
    {uploadingQ && <QuotationModal supplierId={supplierId} category={materialById(db, lines[0]?.materialId)?.category}
      onClose={() => setUploadingQ(false)} onSaved={id => setQIds(ids => [...ids, id])} />}
  </Modal>;
}

function PODrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useStore(s => s.db);
  const po = db.supplierPOs.find(p => p.id === id)!;
  const [completing, setCompleting] = useState(false);
  const [grn, setGrn] = useState(false);
  const [preview, setPreview] = useState(false);
  const sup = supplierById(db, po.supplierId);
  const pr = db.prs.find(p => p.id === po.prId);
  const mo = db.mos.find(m => m.id === pr?.moId);
  const g = db.grns.find(x => x.id === po.grnId);
  const payable = db.payables.find(p => p.poId === po.id);
  const doc = db.documents.find(d => d.id === po.documentId);
  const quotes = db.supplierQuotations.filter(q => po.quotationIds.includes(q.id));
  return <Drawer wide title={po.ref} subtitle={<span className="row"><Badge>{po.status}</Badge>{po.status === 'Approved' && <span className="muted">{po.receiptStatus === 'Received' ? 'Goods received' : 'Awaiting receipt'}</span>}</span>} onClose={onClose}
    footer={po.status === 'Details required' ? <Button variant="primary" icon={<Pencil size={15} />} onClick={() => setCompleting(true)}>Add supplier, price & terms</Button>
      : <>
        <Button icon={<Eye size={15} />} onClick={() => setPreview(true)}>Preview</Button>
        <Button icon={<Download size={15} />} onClick={() => downloadBlob(buildPdf(poSpec(db, po)), `${po.ref}.pdf`)}>Download PDF</Button>
        {po.receiptStatus !== 'Received' && <Button variant="primary" icon={<PackageCheck size={15} />} onClick={() => setGrn(true)}>Receive goods (GRN)</Button>}
      </>}>
    {po.status === 'Details required' && <div className="mb16"><Alert kind="warning">Created automatically from {pr?.ref}. Choose a supplier, enter rates and payment terms; saving makes it Approved.
      <div className="tiny mt8" style={{ marginTop: 4 }}>Assumption (to confirm): approving a PR creates the PO in “Details required”; there is no separate PO approval step.</div></Alert></div>}
    <KV items={[['Supplier', sup ? `${sup.name}${sup.active ? '' : ' (inactive)'}` : ''], ['PO date', fmtDate(po.date)], ['Against PR', pr?.ref ?? ''], ['For MO', mo ? <span className="mono">{mo.ref}</span> : ''],
      ['Expected delivery', fmtDate(po.expectedDelivery)], ['Payment terms', po.paymentTermsDays ? `${po.paymentTermsDays} days` : ''],
      ['Total (excl. GST)', po.status === 'Approved' ? <b>{inr(poTotal(po), { decimals: true })}</b> : ''], ['Payable', payable ? `${payable.ref} · due ${fmtDate(payable.dueDate)}` : ''],
      ['PO document', doc ? <FileLink meta={doc.file} /> : ''],
      ['Quotations', quotes.length ? <div className="col">{quotes.map(q => <FileLink key={q.id} meta={q.file} />)}</div> : ''],
      ['GRN', g ? <span>{g.number} · {fmtDate(g.date)}{g.file && <> · <FileLink meta={g.file} compact /></>}</span> : '']]} />
    <div className="section-title mt24">Items</div>
    <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)' }}>
      <thead><tr><th>Material</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
      <tbody>{po.lines.map(l => { const m = materialById(db, l.materialId); return <tr key={l.id}><td>{m?.code} · {m?.name}</td><td className="num">{fq(l.qty, m?.unit)}</td>
        <td className="num">{l.rate ? inr(l.rate, { decimals: true }) : '—'}</td><td className="num">{l.rate ? inr(l.qty * l.rate) : '—'}</td></tr>; })}</tbody>
    </table>
    {completing && <POFormModal po={po} onClose={() => setCompleting(false)} />}
    {grn && <GRNModal po={po} onClose={() => setGrn(false)} />}
    {preview && <Modal size="lg" title={`Preview · ${po.ref}`} onClose={() => setPreview(false)} footer={<Button onClick={() => setPreview(false)}>Close</Button>}><DocPreview spec={poSpec(db, po)} /></Modal>}
  </Drawer>;
}

function GRNModal({ po, onClose }: { po: SupplierPO; onClose: () => void }) {
  const db = useStore(s => s.db);
  const [number, setNumber] = useState(() => {
    const used = new Set(db.grns.map(g => g.number));
    let n = db.grns.length + 1;
    while (used.has(`GRN-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`)) n++;
    return `GRN-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
  });
  const [date, setDate] = useState(todayISO());
  const grnSample = () => sampleGrnFile(useStore.getState().db, po, number);
  const [file, setFile] = useState<File | null>(grnSample);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pr = db.prs.find(p => p.id === po.prId);
  const mo = db.mos.find(m => m.id === pr?.moId);
  const save = async () => {
    setBusy(true);
    try {
      const meta = file ? await storeFile(file) : undefined;
      const r = attempt(() => useStore.getState().receiveGoods(po.id, { number, date, lines: po.lines.map(l => ({ materialId: l.materialId, qty: l.qty })), file: meta }));
      if (!r.ok) return setErr(r.error);
      toast(`${number} recorded · inventory updated${mo ? ` · allocated to ${mo.ref}` : ''}`); onClose();
    } finally { setBusy(false); }
  };
  return <Modal title={`Receive goods · ${po.ref}`} subtitle={`From ${supplierById(db, po.supplierId)?.name}. Full receipt of all items.`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<PackageCheck size={15} />} disabled={busy} onClick={save}>Record GRN & add to stock</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="GRN number" required htmlFor="g-n"><Input id="g-n" value={number} onChange={e => setNumber(e.target.value)} /></Field>
      <Field label="Receipt date" required htmlFor="g-d"><Input id="g-d" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
    </div>
    <table className="tbl tbl-compact mt16" style={{ border: '1px solid var(--border)' }}>
      <thead><tr><th>Material</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">On hand after</th></tr></thead>
      <tbody>{po.lines.map(l => { const m = materialById(db, l.materialId); return <tr key={l.id}><td>{m?.name}</td><td className="num">{fq(l.qty, m?.unit)}</td>
        <td className="num strong">{fq(l.qty, m?.unit)}</td><td className="num muted">{fq((m?.onHand ?? 0) + l.qty, m?.unit)}</td></tr>; })}</tbody>
    </table>
    {mo && <div className="mt12"><Alert kind="info">This PO was raised for {mo.ref}. Received stock is reserved for that MO first.</Alert></div>}
    <div className="mt16"><Field label="Photo / delivery challan (optional)" hint="Assumption: the GRN photo is optional — confirm whether it should be mandatory."><FilePick file={file} onChange={setFile} sample={grnSample} label="Attach file" accept="image/*,.pdf" /></Field></div>
  </Modal>;
}

/* =================================================================== Suppliers */

function SupplierTab() {
  const db = useStore(s => s.db);
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const ql = q.toLowerCase();
  const sups = db.suppliers.filter(s => (!ql || [s.name, s.contact, s.gst, s.email].some(x => x.toLowerCase().includes(ql))) && (!cat || s.category === cat));
  const inactive = db.suppliers.filter(s => !s.active).length;
  const list = useList(sups, { resetKey: [q, cat], sort: { name: s => s.name, gst: s => s.gst, contact: s => s.contact, pos: s => db.supplierPOs.filter(p => p.supplierId === s.id).length, active: s => s.active ? 0 : 1 } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search suppliers…" />
      <Select aria-label="Filter by category" value={cat} onChange={e => setCat(e.target.value)} style={{ width: 180 }}>
        <option value="">All categories</option>{PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select>
      <AttnNote n={inactive} label="inactive" />
      <div className="spacer" />
      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>Add supplier</Button>
    </div>
    {!sups.length ? <Empty icon={<Building2 size={20} />} title={db.suppliers.length ? 'No matching suppliers' : 'No suppliers yet'} body="Suppliers are needed to approve purchase orders." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 170, 250, 70, 140, 64]} />
        <thead><tr>{list.th('name', 'Supplier')}{list.th('gst', 'GST')}{list.th('contact', 'Contact')}{list.th('pos', 'POs', 'num')}{list.th('active', 'Status')}<th className="right">Action</th></tr></thead>
        <tbody>{list.rows.map(s => <tr key={s.id}>
          <td><div className="primary-cell">{s.name}</div><div className="sub">{s.category}</div></td>
          <td className="mono small">{s.gst || '—'}</td>
          <td><div className="small">{s.contact || '—'}</div><div className="sub">{[s.phone, s.email].filter(Boolean).join(' · ')}</div></td>
          <td className="num">{db.supplierPOs.filter(p => p.supplierId === s.id).length}</td>
          <td><label className="row small" style={{ cursor: 'pointer' }}><input type="checkbox" role="switch" checked={s.active} aria-label={`${s.name} active`}
            onChange={() => { const r = attempt(() => useStore.getState().toggleSupplier(s.id), `${s.name} marked ${s.active ? 'inactive' : 'active'}`); if (!r.ok) toastError(r.error); }} />{s.active ? <span className="muted">Active</span> : <Badge tone="neutral">Inactive</Badge>}</label></td>
          <td className="actions"><div className="row"><IconAction label={`Edit ${s.name}`} icon={<Pencil size={14} />} onClick={() => setEdit(s)} /></div></td>
        </tr>)}</tbody></table></div>{list.pager}</>}
    {edit && <SupplierModal sup={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
  </div>;
}

function SupplierModal({ sup, onClose }: { sup?: Supplier; onClose: () => void }) {
  const [f, setF] = useState(() => sup ? { name: sup.name, gst: sup.gst, contact: sup.contact, phone: sup.phone, email: sup.email, category: sup.category, active: sup.active } : sampleSupplier(useStore.getState().db));
  const [err, setErr] = useState('');
  const set = (k: string, v: unknown) => setF(p => ({ ...p, [k]: v }));
  const save = () => { const r = attempt(() => useStore.getState().saveSupplier({ ...f, id: sup?.id }), sup ? 'Supplier updated' : 'Supplier added'); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal title={sup ? `Edit ${sup.name}` : 'Add supplier'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{sup ? 'Save' : 'Add supplier'}</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Supplier name" required full htmlFor="s-n"><Input id="s-n" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
      <Field label="GST number" htmlFor="s-g" hint="15 characters"><Input id="s-g" className="mono" value={f.gst} maxLength={15} onChange={e => set('gst', e.target.value.toUpperCase())} /></Field>
      <Field label="Category" htmlFor="s-c"><Select id="s-c" value={f.category} onChange={e => set('category', e.target.value)}>{PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Contact person" htmlFor="s-ct"><Input id="s-ct" value={f.contact} onChange={e => set('contact', e.target.value)} /></Field>
      <Field label="Phone" htmlFor="s-p"><Input id="s-p" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
      <Field label="Email" full htmlFor="s-e"><Input id="s-e" type="email" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
      <label className="row full small"><input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} /> Active — can be chosen on new purchase orders</label>
    </div>
  </Modal>;
}

/* =================================================================== Quotations */

function QuotationTab() {
  const db = useStore(s => s.db);
  const [sup, setSup] = useState('');
  const [cat, setCat] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = db.supplierQuotations.filter(q => (!sup || q.supplierId === sup) && (!cat || q.category === cat));
  const list = useList(rows, { resetKey: [sup, cat], sort: { ref: q => q.reference, sup: q => supplierById(db, q.supplierId)?.name, cat: q => q.category, date: q => q.date } });
  return <div className="card list">
    <div className="toolbar">
      <Select aria-label="Filter by supplier" value={sup} onChange={e => setSup(e.target.value)} style={{ width: 220 }}>
        <option value="">All suppliers</option>{db.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      <Select aria-label="Filter by category" value={cat} onChange={e => setCat(e.target.value)} style={{ width: 180 }}>
        <option value="">All categories</option>{PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select>
      <div className="spacer" />
      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)} disabled={!db.suppliers.length} title={db.suppliers.length ? '' : 'Add a supplier first'}>Upload quotation</Button>
    </div>
    {!rows.length ? <Empty icon={<FileSpreadsheet size={20} />} title={db.supplierQuotations.length ? 'No quotations match these filters' : 'No supplier quotations'} body={db.suppliers.length ? 'Upload quotations received from suppliers; they can then be attached to POs.' : 'Add a supplier first, then upload their quotations.'} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 220, 150, 96, 210, 150]} />
        <thead><tr>{list.th('ref', 'Reference')}{list.th('sup', 'Supplier')}{list.th('cat', 'Category')}{list.th('date', 'Date')}<th>File</th><th>Attached to</th></tr></thead>
        <tbody>{list.rows.map(q => <tr key={q.id}>
          <td className="primary-cell">{q.reference}</td><td>{supplierById(db, q.supplierId)?.name}</td><td className="muted">{q.category}</td>
          <td className="muted nowrap" title={fmtDate(q.date)}>{fmtShort(q.date)}</td><td><FileLink meta={q.file} compact /></td>
          <td className="mono small">{db.supplierPOs.filter(p => p.quotationIds.includes(q.id)).map(p => p.ref).join(', ') || '—'}</td>
        </tr>)}</tbody></table></div>{list.pager}</>}
    {adding && <QuotationModal onClose={() => setAdding(false)} />}
  </div>;
}

/** Also opened inline from the PO form (supplier preset); the new quotation goes to the library and Documents, and is ticked on the PO. */
function QuotationModal({ onClose, supplierId: preset, category: presetCat, onSaved }: { onClose: () => void; supplierId?: string; category?: string; onSaved?: (id: string) => void }) {
  const db = useStore(s => s.db);
  const [supplierId, setSup] = useState(preset || (db.suppliers.find(s => s.active)?.id ?? ''));
  const [category, setCat] = useState(presetCat && (PRODUCT_CATEGORIES as readonly string[]).includes(presetCat) ? presetCat : supplierById(db, supplierId)?.category ?? 'Steel coil');
  const [reference, setRef] = useState(() => sampleQuotationRef(db, supplierId));
  const [date, setDate] = useState(todayISO());
  const qSample = () => sampleQuotationFile(useStore.getState().db, supplierId, reference || 'quotation', category);
  const [file, setFile] = useState<File | null>(qSample);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!file) return setErr('Attach the quotation file.');
    const meta = await storeFile(file);
    const r = attempt(() => useStore.getState().addSupplierQuotation({ supplierId, category, reference, date, file: meta }), 'Quotation uploaded · added to the library and Documents');
    if (r.ok) { onSaved?.(r.value); onClose(); } else setErr(r.error);
  };
  return <Modal title="Upload supplier quotation" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Upload</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Supplier" required htmlFor="sq-s"><Select id="sq-s" value={supplierId} disabled={!!preset} onChange={e => { setSup(e.target.value); setCat(supplierById(db, e.target.value)?.category ?? category); }}>
        {db.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inactive)'}</option>)}</Select></Field>
      <Field label="Category" htmlFor="sq-c"><Select id="sq-c" value={category} onChange={e => setCat(e.target.value)}>{PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Reference / name" required htmlFor="sq-r"><Input id="sq-r" value={reference} onChange={e => setRef(e.target.value)} placeholder="e.g. TS/Q/2026/118" /></Field>
      <Field label="Quotation date" htmlFor="sq-d"><Input id="sq-d" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
      <Field label="File" required full><FilePick file={file} onChange={setFile} sample={qSample} accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.doc,.docx" /></Field>
    </div>
  </Modal>;
}

export type { PurchaseRequest };
