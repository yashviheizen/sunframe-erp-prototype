import { useState } from 'react';
import { Wallet, IndianRupee } from 'lucide-react';
import { useStore, leadById, supplierById, receivableBalance } from '../store';
import { sampleProofFile } from '../lib/samples';
import type { Receivable, Payable } from '../lib/types';
import { inr, fmtDate, fmtShort, todayISO, daysBetween } from '../lib/format';
import { storeFile } from '../lib/files';
import { PageHead, Button, Badge, Empty, Modal, Field, Input, NumInput, Select, Alert, FilePick, FileLink, Tabs, Drawer, KV, SearchBox, InfoTip, Cols, useList, attempt, toast } from '../ui/kit';
import { nav, routeQuery } from '../ui/router';

type Tab = 'receivables' | 'payables';
type Kind = 'rec' | 'pay';

function dueInfo(dueDate: string, outstanding: number) {
  if (outstanding <= 0) return { overdue: false, label: '' };
  const d = daysBetween(todayISO(), dueDate);
  return d < 0 ? { overdue: true, label: `${-d} day${d === -1 ? '' : 's'} overdue` } : { overdue: false, label: d === 0 ? 'Due today' : `Due in ${d} day${d === 1 ? '' : 's'}` };
}

const overdue = (rs: (Receivable | Payable)[]) => rs.filter(r => dueInfo(r.dueDate, receivableBalance(r).outstanding).overdue).length;

export default function Finance({ tab = 'receivables' }: { tab?: string }) {
  const db = useStore(s => s.db);
  const t = (tab === 'payables' ? 'payables' : 'receivables') as Tab;
  const sum = (rs: (Receivable | Payable)[]) => rs.reduce((a, r) => { const b = receivableBalance(r); const o = dueInfo(r.dueDate, b.outstanding).overdue;
    return { out: a.out + b.outstanding, over: a.over + (o ? b.outstanding : 0) }; }, { out: 0, over: 0 });
  const rs = sum(db.receivables), ps = sum(db.payables);
  return <>
    <PageHead title="Finance" sub="Receivables are created on dispatch; payables when a supplier PO is approved." />
    <div className="grid g4 mb12">
      {([['Receivable outstanding', rs.out, false], ['Receivable overdue', rs.over, true], ['Payable outstanding', ps.out, false], ['Payable overdue', ps.over, true]] as const).map(([l, v, danger]) =>
        <div key={l} className="card kpi" style={{ padding: '10px 14px' }}><div className="muted small">{l}</div>
          <div className="value" style={{ fontSize: 19, marginTop: 2, color: danger && v ? 'var(--danger)' : undefined }}>{inr(v)}</div></div>)}
    </div>
    <Tabs<Tab> value={t} onChange={k => nav(`finance/${k}`)} tabs={[{ key: 'receivables', label: 'Receivables', count: db.receivables.length, attention: overdue(db.receivables), attentionLabel: 'overdue' },
      { key: 'payables', label: 'Payables', count: db.payables.length, attention: overdue(db.payables), attentionLabel: 'overdue' }]} />
    <Ledger kind={t === 'receivables' ? 'rec' : 'pay'} key={t} />
  </>;
}

function Ledger({ kind }: { kind: Kind }) {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const rows: (Receivable | Payable)[] = kind === 'rec' ? db.receivables : db.payables;
  const party = (r: Receivable | Payable) => kind === 'rec' ? leadById(db, (r as Receivable).leadId)?.company ?? '' : supplierById(db, (r as Payable).supplierId)?.name ?? '';
  const docRef = (r: Receivable | Payable) => kind === 'rec' ? db.salesOrders.find(s => s.id === (r as Receivable).soId)?.ref : db.supplierPOs.find(p => p.id === (r as Payable).poId)?.ref;
  const ql = q.trim().toLowerCase();
  // Receivables are due from the dispatch date; payables from the PO date.
  const startDate = (r: Receivable | Payable) => kind === 'rec' ? db.dispatches.find(d => d.id === (r as Receivable).dispatchId)?.dispatchDate : (r as Payable).poDate;
  const list = rows.filter(r => {
    const b = receivableBalance(r); const o = dueInfo(r.dueDate, b.outstanding).overdue;
    // Overdue is an extra flag, not a replacement: an overdue Pending/Partially paid row still matches its payment status.
    const match = !status || (status === 'Overdue' ? o : b.status === status);
    return (!ql || [r.ref, party(r), docRef(r)].some(x => x?.toLowerCase().includes(ql))) && match;
  });
  const lst = useList(list, { resetKey: [q, status], sort: {
    party, doc: r => docRef(r), start: r => startDate(r), due: r => r.dueDate,
    amount: r => receivableBalance(r).outstanding, status: r => receivableBalance(r).status,
  } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder={kind === 'rec' ? 'Search client, SO, ref…' : 'Search supplier, PO, ref…'} />
      <Select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 160 }}>
        <option value="">All statuses</option><option>Pending</option><option>Partially paid</option><option>Paid</option><option>Overdue</option></Select>
      <InfoTip text={kind === 'rec' ? 'Created when a dispatch is confirmed. Due date = dispatch date + payment terms.' : 'Created when a supplier PO is approved. Due date = PO date + 30/60/90 days.'} />
    </div>
    {!list.length ? <Empty icon={<Wallet size={20} />} title={rows.length ? 'No matching entries' : kind === 'rec' ? 'No receivables yet' : 'No payables yet'}
      body={rows.length ? 'Try a different search or status.' : kind === 'rec' ? 'A receivable is created when a dispatch is confirmed. Due date = dispatch date + payment terms.' : 'A payable is created when a supplier PO is approved. Due date = PO date + 30/60/90 days.'} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 112, 88, 124, 136, 196, 112]} />
        <thead><tr>{lst.th('party', kind === 'rec' ? 'Client' : 'Supplier')}{lst.th('doc', kind === 'rec' ? 'SO' : 'PO')}{lst.th('start', kind === 'rec' ? 'Dispatched' : 'PO date')}
          {lst.th('due', 'Due')}{lst.th('amount', 'Outstanding', 'num')}{lst.th('status', 'Status')}<th className="right"><span className="sr-only">Action</span></th></tr></thead>
        <tbody>{lst.rows.map(r => {
          const b = receivableBalance(r); const di = dueInfo(r.dueDate, b.outstanding); const sd = startDate(r);
          return <tr key={r.id} className="clickable" tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={e => e.key === 'Enter' && setOpen(r.id)}>
            <td><div className="primary-cell">{party(r)}</div><div className="sub mono">{r.ref}</div></td>
            <td className="mono small">{docRef(r)}</td>
            <td className="muted small" title={sd ? fmtDate(sd) : undefined}>{sd ? fmtShort(sd) : '—'}</td>
            <td title={fmtDate(r.dueDate)}><div>{fmtShort(r.dueDate)}</div>{di.label && <div className="sub" style={{ color: di.overdue ? 'var(--danger)' : undefined }}>{di.label}</div>}</td>
            <td className="num"><div className="strong">{inr(b.outstanding)}</div><div className="sub">of {inr(r.amount)}</div></td>
            <td><span className="row" style={{ gap: 4 }}><Badge>{b.status}</Badge>{di.overdue && <Badge tone="danger">Overdue</Badge>}</span></td>
            <td className="actions"><div className="row">{b.outstanding > 0 && <Button size="sm" icon={<IndianRupee size={13} />} title={kind === 'rec' ? 'Record receipt' : 'Record payment'} onClick={e => { e.stopPropagation(); setPaying(r.id); }} onKeyDown={e => e.stopPropagation()}>{kind === 'rec' ? 'Receipt' : 'Pay'}</Button>}</div></td>
          </tr>;
        })}</tbody></table></div>{lst.pager}</>}
    {open && <EntryDrawer kind={kind} id={open} onClose={() => setOpen(null)} onPay={() => setPaying(open)} />}
    {paying && <PaymentModal kind={kind} id={paying} onClose={() => setPaying(null)} />}
  </div>;
}

function EntryDrawer({ kind, id, onClose, onPay }: { kind: Kind; id: string; onClose: () => void; onPay: () => void }) {
  const db = useStore(s => s.db);
  const r = (kind === 'rec' ? db.receivables : db.payables).find(x => x.id === id);
  if (!r) return null;
  const b = receivableBalance(r);
  const di = dueInfo(r.dueDate, b.outstanding);
  const rec = kind === 'rec' ? r as Receivable : null, pay = kind === 'pay' ? r as Payable : null;
  const dsp = rec ? db.dispatches.find(d => d.id === rec.dispatchId) : undefined;
  const po = pay ? db.supplierPOs.find(p => p.id === pay.poId) : undefined;
  return <Drawer title={r.ref} subtitle={<span className="row"><Badge>{b.status}</Badge>{di.overdue && <Badge tone="danger">{di.label}</Badge>}</span>} onClose={onClose}
    footer={b.outstanding > 0 ? <Button variant="primary" icon={<IndianRupee size={15} />} onClick={onPay}>{kind === 'rec' ? 'Record receipt' : 'Record payment'}</Button> : undefined}>
    <KV items={rec ? [['Client', leadById(db, rec.leadId)?.company ?? ''], ['Sales order', db.salesOrders.find(s => s.id === rec.soId)?.ref ?? ''],
      ['Dispatch', dsp ? `${dsp.ref} · ${fmtDate(dsp.dispatchDate)}` : ''], ['Payment terms', rec.paymentTerms], ['Due date', `${fmtDate(rec.dueDate)}${di.label ? ` · ${di.label}` : ''}`],
      ['Amount', inr(rec.amount, { decimals: true })], ['Received', inr(b.paid, { decimals: true })], ['Outstanding', <b>{inr(b.outstanding, { decimals: true })}</b>]]
      : [['Supplier', supplierById(db, pay!.supplierId)?.name ?? ''], ['Supplier PO', po?.ref ?? ''], ['PO date', fmtDate(pay!.poDate)], ['Terms', `${pay!.termsDays} days`],
        ['Due date', `${fmtDate(pay!.dueDate)}${di.label ? ` · ${di.label}` : ''}`], ['Amount', inr(pay!.amount, { decimals: true })], ['Paid', inr(b.paid, { decimals: true })], ['Outstanding', <b>{inr(b.outstanding, { decimals: true })}</b>]]} />
    <div className="section-title mt24">Payments</div>
    {!r.payments.length ? <div className="muted small">No payments recorded yet.</div>
      : <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)' }}>
        <thead><tr><th>Date</th><th>Mode / ref</th><th className="num">Amount</th><th>Payment proof</th></tr></thead>
        <tbody>{r.payments.map(p => <tr key={p.id}><td className="nowrap">{fmtDate(p.date)}</td><td className="small">{p.mode}<div className="faint">{p.reference}</div></td>
          <td className="num">{inr(p.amount, { decimals: true })}</td><td>{p.proof ? <FileLink meta={p.proof} compact /> : <span className="faint">—</span>}</td></tr>)}</tbody>
      </table>}
  </Drawer>;
}

function PaymentModal({ kind, id, onClose }: { kind: Kind; id: string; onClose: () => void }) {
  const db = useStore(s => s.db);
  const r = (kind === 'rec' ? db.receivables : db.payables).find(x => x.id === id)!;
  const b = receivableBalance(r);
  // The amount starts blank: status comes only from the amounts actually recorded (cumulative), never from a proof upload.
  const [f, setF] = useState(() => ({ date: todayISO(), amount: 0, mode: 'Bank transfer (NEFT/RTGS)', reference: '' }));
  const party = kind === 'rec' ? leadById(db, (r as { leadId?: string }).leadId)?.company ?? '' : supplierById(db, (r as { supplierId?: string }).supplierId)?.name ?? '';
  const proofSample = () => sampleProofFile(useStore.getState().db, r.ref, party, f.amount, f.reference);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const over = f.amount > b.outstanding + 0.004;
  const after = f.amount > 0 && !over ? (b.outstanding - f.amount <= 0.004 ? 'Paid' : 'Partially paid') : b.status;
  const save = async () => {
    if (!(f.amount > 0)) return setErr('Enter the amount received/paid (more than ₹0).');
    if (over) return setErr(`Amount exceeds the outstanding balance of ${inr(b.outstanding, { decimals: true })}.`);
    setBusy(true);
    try {
      const proof = file ? await storeFile(file) : undefined;
      const s = useStore.getState();
      const r2 = attempt(() => kind === 'rec' ? s.recordReceipt(id, { ...f, proof }) : s.recordPayablePayment(id, { ...f, proof }));
      if (!r2.ok) return setErr(r2.error);
      toast(`${inr(f.amount)} ${kind === 'rec' ? 'received' : 'paid'} against ${r.ref}`); onClose();
    } finally { setBusy(false); }
  };
  return <Modal title={kind === 'rec' ? `Record receipt · ${r.ref}` : `Record payment · ${r.ref}`} subtitle={`Outstanding ${inr(b.outstanding, { decimals: true })}`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || over} onClick={save}>Save</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Payment date" required htmlFor="p-d"><Input id="p-d" type="date" value={f.date} onChange={e => setF(p => ({ ...p, date: e.target.value }))} /></Field>
      <Field label="Amount (₹)" required htmlFor="p-a" error={over ? 'More than the outstanding balance' : undefined}><div className="row" style={{ gap: 6 }}><NumInput id="p-a" invalid={over} blankZero placeholder="0.00" value={f.amount} onChange={n => { setErr(''); setF(p => ({ ...p, amount: n })); }} />
        <Button size="sm" onClick={() => { setErr(''); setF(p => ({ ...p, amount: Math.round(b.outstanding * 100) / 100 })); }}>Full balance</Button></div></Field>
      <Field label="Mode" htmlFor="p-m"><Select id="p-m" value={f.mode} onChange={e => setF(p => ({ ...p, mode: e.target.value }))}>
        {['Bank transfer (NEFT/RTGS)', 'UPI', 'Cheque', 'Cash', 'Other'].map(m => <option key={m}>{m}</option>)}</Select></Field>
      <Field label="Reference / UTR" htmlFor="p-r"><Input id="p-r" value={f.reference} onChange={e => setF(p => ({ ...p, reference: e.target.value }))} /></Field>
      <Field label="Payment proof (optional)" full hint="Attaching proof doesn't change the status — only the amount does."><FilePick file={file} onChange={setFile} sample={proofSample} accept="image/*,.pdf" label="Attach proof" /></Field>
    </div>
    <div className="muted small mt12" aria-live="polite">Status after saving: <Badge tone={after === 'Paid' ? 'success' : after === 'Partially paid' ? 'info' : 'neutral'}>{after}</Badge>
      {f.amount > 0 && !over && <> · outstanding {inr(Math.max(0, b.outstanding - f.amount), { decimals: true })}</>}</div>
  </Modal>;
}
