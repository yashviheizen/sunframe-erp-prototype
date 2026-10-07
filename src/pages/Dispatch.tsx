import { useState } from 'react';
import { Truck, Send, Upload } from 'lucide-react';
import { useStore, leadById } from '../store';
import type { Dispatch as DispatchRec } from '../lib/types';
import { qty as fq, fmtDate, fmtShort, fmtDateTime, todayISO, addDays, parseTermsDays, inr } from '../lib/format';
import { storeFile } from '../lib/files';
import { PageHead, Button, Badge, Empty, Modal, Field, Input, Alert, FilePick, FileLink, Tabs, SearchBox, Select, Cols, useList, attempt, toast } from '../ui/kit';
import { routeQuery } from '../ui/router';
import { sampleDispatch, samplePodFile } from '../lib/samples';

export default function Dispatch() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  // A deep link to a dispatched record opens the Dispatched tab.
  const [tab, setTab] = useState<'ready' | 'done'>(() => db.dispatches.some(d => d.status === 'Dispatched' && d.ref === routeQuery('q')) ? 'done' : 'ready');
  const [podFilter, setPodFilter] = useState('');
  const [confirm, setConfirm] = useState<DispatchRec | null>(null);
  const [pod, setPod] = useState<DispatchRec | null>(null);
  const ql = q.trim().toLowerCase();
  const rows = db.dispatches.filter(d => tab === 'ready' ? d.status === 'Ready' : d.status === 'Dispatched')
    .filter(d => tab === 'ready' || !podFilter || (podFilter === 'pending' ? !d.pod : !!d.pod))
    .filter(d => {
      if (!ql) return true;
      const mo = db.mos.find(m => m.id === d.moId), so = db.salesOrders.find(s => s.id === d.soId), rec = db.receivables.find(r => r.id === d.receivableId);
      return [d.ref, leadById(db, d.leadId)?.company, mo?.ref, mo?.productName, so?.ref, d.vehicleNo, d.lrNumber, d.transporter, rec?.ref].some(x => x?.toLowerCase().includes(ql));
    });
  const company = (d: DispatchRec) => leadById(db, d.leadId)?.company;
  const list = useList(rows, { resetKey: [q, tab, podFilter], sort: { ref: d => d.ref, client: company, qty: d => d.qty, ready: d => d.readyAt, date: d => d.dispatchDate, pod: d => d.pod ? 1 : 0, rec: d => db.receivables.find(r => r.id === d.receivableId)?.ref } });
  return <>
    <PageHead title="Dispatch" sub="Finished goods arrive here automatically. Confirming a dispatch reduces finished goods and creates the receivable." />
    <Tabs value={tab} onChange={setTab} tabs={[{ key: 'ready', label: 'Ready to dispatch', count: db.dispatches.filter(d => d.status === 'Ready').length },
      { key: 'done', label: 'Dispatched', count: db.dispatches.filter(d => d.status === 'Dispatched').length,
        attention: db.dispatches.filter(d => d.status === 'Dispatched' && !d.pod).length, attentionLabel: 'POD pending' }]} />
    <div className="card list">
      {db.dispatches.length > 0 && <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search dispatch, client, SO/MO, vehicle, LR…" />
        {tab === 'done' && <Select aria-label="Filter by POD" value={podFilter} onChange={e => setPodFilter(e.target.value)} style={{ width: 160 }}>
          <option value="">All PODs</option><option value="pending">POD pending</option><option value="received">POD received</option></Select>}
      </div>}
      {!rows.length ? <Empty icon={<Truck size={20} />} title={ql || podFilter ? 'No dispatches match' : tab === 'ready' ? 'Nothing ready to dispatch' : 'No dispatches yet'}
        body={tab === 'ready' ? 'When an MO reaches “Finished goods ready”, it appears here.' : 'Confirmed dispatches will be listed here.'} />
        : <><div className="table-scroll"><table className="tbl fixed">
          <Cols w={tab === 'ready' ? [150, undefined, 120, 150, 170] : [140, undefined, 92, 88, 128, 124, 140, 120]} />
          <thead><tr>{list.th('ref', 'Dispatch')}{list.th('client', 'Client / product')}{list.th('qty', 'Qty', 'num')}
            {tab === 'ready' ? list.th('ready', 'Ready since') : <>{list.th('date', 'Dispatched')}<th>Vehicle / LR</th>{list.th('pod', 'POD')}{list.th('rec', 'Receivable')}</>}<th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>{list.rows.map(d => {
            const mo = db.mos.find(m => m.id === d.moId), so = db.salesOrders.find(s => s.id === d.soId), rec = db.receivables.find(r => r.id === d.receivableId);
            return <tr key={d.id}>
              <td><div className="mono primary-cell">{d.ref}</div><div className="sub mono">{[so?.ref, mo?.ref].filter(Boolean).join(' · ')}</div></td>
              <td><div className="primary-cell">{leadById(db, d.leadId)?.company}</div><div className="sub">{mo?.productName}</div></td>
              <td className="num small">{fq(d.qty, d.unit)}</td>
              {tab === 'ready' ? <td className="muted small">{fmtDateTime(d.readyAt)}</td> : <>
                <td className="small" title={fmtDate(d.dispatchDate)}>{fmtShort(d.dispatchDate)}</td>
                <td className="small"><div>{d.vehicleNo}</div><div className="sub">{[d.transporter, d.lrNumber && `LR ${d.lrNumber}`].filter(Boolean).join(' · ')}</div></td>
                <td>{d.pod ? <FileLink meta={d.pod} compact /> : <Badge tone="warning">POD pending</Badge>}</td>
                <td className="small">{rec ? <><div className="mono">{rec.ref}</div><div className="sub" title={`${inr(rec.amount)} · due ${fmtDate(rec.dueDate)}`}>{inr(rec.amount)} · due {fmtShort(rec.dueDate)}</div></> : '—'}</td></>}
              <td className="right">{tab === 'ready' ? <Button size="sm" variant="primary" icon={<Send size={13} />} onClick={() => setConfirm(d)}>Confirm dispatch</Button>
                : !d.pod && <Button size="sm" icon={<Upload size={13} />} onClick={() => setPod(d)}>Add POD</Button>}</td>
            </tr>;
          })}</tbody></table></div>{list.pager}</>}
    </div>
    {confirm && <ConfirmModal d={confirm} onClose={() => setConfirm(null)} onDone={() => setTab('done')} />}
    {pod && <PodModal d={pod} onClose={() => setPod(null)} />}
  </>;
}

function ConfirmModal({ d, onClose, onDone }: { d: DispatchRec; onClose: () => void; onDone: () => void }) {
  const db = useStore(s => s.db);
  const so = db.salesOrders.find(s => s.id === d.soId);
  const lead = leadById(db, d.leadId);
  // Demo prefill: the transporter last used for this client (else a sample one) and an unused LR number.
  // Nothing is dispatched until "Confirm dispatch". A POD usually comes later, so a sample POD is offered, not attached.
  const [f, setF] = useState(() => sampleDispatch(useStore.getState().db, d.leadId));
  const podSample = () => samplePodFile(useStore.getState().db, d);
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }));
  const days = parseTermsDays(so?.paymentTerms ?? '');
  const save = async () => {
    setBusy(true);
    try {
      const pod = file ? await storeFile(file) : undefined;
      const r = attempt(() => useStore.getState().confirmDispatch(d.id, { ...f, pod, dueDate: days === null ? f.dueDate : undefined }));
      if (!r.ok) return setErr(r.error);
      toast(`${d.ref} dispatched · receivable created`); onDone(); onClose();
    } finally { setBusy(false); }
  };
  return <Modal title={`Confirm dispatch · ${d.ref}`} subtitle={`${fq(d.qty, d.unit)} to ${lead?.company}`} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={15} />} disabled={busy} onClick={save}>Confirm dispatch</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Dispatch date" required htmlFor="d-d"><Input id="d-d" type="date" value={f.dispatchDate} onChange={e => set('dispatchDate', e.target.value)} /></Field>
      <Field label="Vehicle number" required htmlFor="d-v"><Input id="d-v" value={f.vehicleNo} onChange={e => set('vehicleNo', e.target.value.toUpperCase())} placeholder="GJ 01 AB 1234" /></Field>
      <Field label="Transporter" htmlFor="d-t"><Input id="d-t" value={f.transporter} onChange={e => set('transporter', e.target.value)} /></Field>
      <Field label="Driver name / phone" htmlFor="d-dr"><Input id="d-dr" value={f.driver} onChange={e => set('driver', e.target.value)} /></Field>
      <Field label="LR number" htmlFor="d-lr"><Input id="d-lr" value={f.lrNumber} onChange={e => set('lrNumber', e.target.value)} /></Field>
      {days === null && <Field label="Payment due date" required htmlFor="d-due" hint={`Terms “${so?.paymentTerms || 'blank'}” can't be read as days.`}>
        <Input id="d-due" type="date" min={f.dispatchDate} value={f.dueDate} onChange={e => set('dueDate', e.target.value)} /></Field>}
      <Field label="Proof of delivery (optional)" full hint="You can also upload the POD later."><FilePick file={file} onChange={setFile} sample={podSample} accept="image/*,.pdf" label="Attach POD" /></Field>
    </div>
    <div className="mt16"><Alert kind="info">
      A receivable of <b>{inr(so?.total ?? 0)}</b> will be created{days !== null ? <>, due <b>{fmtDate(addDays(f.dispatchDate, days))}</b> ({days} days from dispatch, per “{so?.paymentTerms}”)</> : ''}.
    </Alert></div>
  </Modal>;
}

function PodModal({ d, onClose }: { d: DispatchRec; onClose: () => void }) {
  const podSample = () => samplePodFile(useStore.getState().db, d);
  const [file, setFile] = useState<File | null>(podSample);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!file) return setErr('Choose the POD file.');
    const meta = await storeFile(file);
    const r = attempt(() => useStore.getState().addPod(d.id, meta), 'POD uploaded');
    if (r.ok) onClose(); else setErr(r.error);
  };
  return <Modal size="sm" title={`Add POD · ${d.ref}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Upload</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <FilePick file={file} onChange={setFile} sample={podSample} accept="image/*,.pdf" label="Choose POD file" />
  </Modal>;
}
