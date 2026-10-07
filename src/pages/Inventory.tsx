import { useState } from 'react';
import { Plus, Boxes, SlidersHorizontal, Lock, PackageCheck } from 'lucide-react';
import { useStore, reservedQty, availableQty, materialById, leadById } from '../store';
import { sampleAdjustment } from '../lib/samples';
import type { Material } from '../lib/types';
import { MATERIAL_CATEGORIES } from '../lib/types';
import { qty as fq, fmtDateTime, fmtShort } from '../lib/format';
import { PageHead, Button, Badge, SearchBox, Empty, Modal, Field, NumInput, Input, Select, Alert, Tabs, InfoTip, Cols, IconAction, useList, attempt } from '../ui/kit';
import { MaterialModal } from '../ui/shared';
import { nav } from '../ui/router';

type Tab = 'materials' | 'reservations' | 'fg';

export default function Inventory({ tab = 'materials' }: { tab?: string }) {
  const db = useStore(s => s.db);
  const t = (['materials', 'reservations', 'fg'].includes(tab) ? tab : 'materials') as Tab;
  return <>
    <PageHead title="Inventory" sub="Available = On hand − Reserved. Reservations are held for manufacturing orders until materials are issued." />
    <Tabs<Tab> value={t} onChange={k => nav(`inventory/${k}`)} tabs={[
      { key: 'materials', label: 'Raw materials', count: db.materials.length },
      { key: 'reservations', label: 'Reservations', count: db.reservations.length, attention: db.reservations.filter(r => r.status === 'Reserved').length, attentionLabel: 'held' },
      { key: 'fg', label: 'Finished goods', count: db.fgItems.length, attention: db.fgItems.filter(f => f.producedQty - f.dispatchedQty > 0).length, attentionLabel: 'in stock' },
    ]} />
    {t === 'materials' && <Materials />}
    {t === 'reservations' && <Reservations />}
    {t === 'fg' && <FinishedGoods />}
  </>;
}

function Materials() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [adding, setAdding] = useState(false);
  const [adjust, setAdjust] = useState<Material | null>(null);
  const ql = q.toLowerCase();
  const rows = db.materials.filter(m => (!ql || `${m.code} ${m.name}`.toLowerCase().includes(ql)) && (!cat || m.category === cat));
  const list = useList(rows, { resetKey: [q, cat], sort: { code: m => m.code, name: m => m.name, onHand: m => m.onHand, res: m => reservedQty(db, m.id), av: m => availableQty(db, m.id) } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search code or name…" />
      <Select aria-label="Filter by category" value={cat} onChange={e => setCat(e.target.value)} style={{ width: 190 }}>
        <option value="">All categories</option>{MATERIAL_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select>
      <div className="spacer" />
      <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add material</Button>
    </div>
    {!rows.length ? <Empty icon={<Boxes size={20} />} title={db.materials.length ? 'No matching materials' : 'No raw materials yet'}
      body="Add materials with their opening stock. They can also be added inline while building a BOM." action={!db.materials.length && <Button variant="primary" onClick={() => setAdding(true)}>Add material</Button>} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[110, undefined, 120, 110, 120, 210, 64]} />
        <thead><tr>{list.th('code', 'Code')}{list.th('name', 'Material')}{list.th('onHand', 'On hand', 'num')}{list.th('res', 'Reserved', 'num')}{list.th('av', 'Available', 'num')}<th>Incoming (open POs)</th><th className="right">Action</th></tr></thead>
        <tbody>{list.rows.map(m => {
          const res = reservedQty(db, m.id), av = availableQty(db, m.id);
          const incoming = db.supplierPOs.filter(p => p.receiptStatus === 'Not received' && p.lines.some(l => l.materialId === m.id))
            .map(p => `${p.ref} · ${fq(p.lines.find(l => l.materialId === m.id)!.qty, m.unit)}`);
          return <tr key={m.id}>
            <td className="mono small">{m.code}</td>
            <td><div className="primary-cell">{m.name}</div><div className="sub">{m.category}</div></td>
            <td className="num">{fq(m.onHand, m.unit)}</td>
            <td className="num">{res > 0 ? fq(res, m.unit) : <span className="faint">—</span>}</td>
            <td className="num strong" style={{ color: av <= 0 ? 'var(--danger)' : undefined }}>{fq(av, m.unit)}</td>
            <td className="small muted">{incoming.join(', ') || '—'}</td>
            <td className="actions"><div className="row"><IconAction label={`Adjust stock · ${m.name}`} icon={<SlidersHorizontal size={14} />} onClick={() => setAdjust(m)} /></div></td>
          </tr>;
        })}</tbody></table></div>{list.pager}</>}
    {adding && <MaterialModal onClose={() => setAdding(false)} />}
    {adjust && <AdjustModal m={adjust} onClose={() => setAdjust(null)} />}
  </div>;
}

function AdjustModal({ m, onClose }: { m: Material; onClose: () => void }) {
  const db = useStore(s => s.db);
  // Demo prefill: a plausible count correction that stays at or above the reserved quantity.
  const [init] = useState(() => sampleAdjustment(useStore.getState().db, m));
  const [val, setVal] = useState(init.onHand);
  const [note, setNote] = useState(init.note);
  const [err, setErr] = useState('');
  const res = reservedQty(db, m.id);
  const save = () => { const r = attempt(() => useStore.getState().adjustStock(m.id, val, note), `${m.name} stock updated`); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal size="sm" title={`Adjust stock · ${m.name}`} subtitle="Physical count correction. If stock increases, use “Re-check stock” on a waiting MO to reserve it." onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save count</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Current on hand"><Input disabled value={fq(m.onHand, m.unit)} /></Field>
      <Field label={`New on hand (${m.unit})`} required htmlFor="adj-v" hint={res > 0 ? `Cannot go below reserved ${fq(res, m.unit)}` : undefined}><NumInput id="adj-v" value={val} onChange={setVal} /></Field>
      <Field label="Reason" full htmlFor="adj-n"><Input id="adj-n" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Physical stock count, opening balance" /></Field>
    </div>
  </Modal>;
}

function Reservations() {
  const db = useStore(s => s.db);
  const [status, setStatus] = useState('Reserved');
  const rows = db.reservations.filter(r => !status || r.status === status);
  const moOf = (moId: string) => db.mos.find(x => x.id === moId);
  const list = useList(rows, { resetKey: [status], sort: {
    mo: r => moOf(r.moId)?.ref, client: r => leadById(db, moOf(r.moId)?.leadId)?.company, mat: r => materialById(db, r.materialId)?.name,
    req: r => moOf(r.moId)?.requirements.find(x => x.materialId === r.materialId)?.required ?? 0, qty: r => r.qty, status: r => r.status } });
  return <div className="card list">
    <div className="toolbar">
      <Select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 170 }}>
        <option value="">All</option><option>Reserved</option><option>Issued</option></Select>
      <InfoTip text="Reserved stock is held for an MO and not available to others. Issuing materials consumes it." />
    </div>
    {!rows.length ? <Empty icon={<Lock size={20} />} title="No reservations" body="Saving an MO reserves the available stock for it." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[120, undefined, 220, 110, 130, 110, 110]} />
        <thead><tr>{list.th('mo', 'MO')}{list.th('client', 'Client')}{list.th('mat', 'Material')}{list.th('req', 'Required', 'num')}{list.th('qty', 'Reserved / issued', 'num')}<th className="num">Still short</th>{list.th('status', 'Status')}</tr></thead>
        <tbody>{list.rows.map(r => {
          const mo = db.mos.find(x => x.id === r.moId); const m = materialById(db, r.materialId);
          const req = mo?.requirements.find(x => x.materialId === r.materialId)?.required ?? 0;
          const short = r.status === 'Reserved' ? Math.max(0, req - r.qty) : 0;
          return <tr key={r.id} className="clickable" tabIndex={0} onClick={() => mo && nav(`sales/${mo.leadId}`)} onKeyDown={e => e.key === 'Enter' && mo && nav(`sales/${mo.leadId}`)}>
            <td className="mono primary-cell">{mo?.ref}</td><td>{leadById(db, mo?.leadId)?.company}</td><td className="small">{m?.name}</td>
            <td className="num">{fq(req, m?.unit)}</td><td className="num">{fq(r.qty, m?.unit)}</td>
            <td className="num" style={{ color: short > 0 ? 'var(--danger)' : undefined }}>{short > 0 ? fq(short, m?.unit) : '—'}</td>
            <td><Badge>{r.status}</Badge></td>
          </tr>;
        })}</tbody></table></div>{list.pager}</>}
  </div>;
}

function FinishedGoods() {
  const db = useStore(s => s.db);
  const list = useList(db.fgItems, { sort: {
    product: f => f.productName, mo: f => db.mos.find(x => x.id === f.moId)?.ref, produced: f => f.producedQty, dispatched: f => f.dispatchedQty,
    stock: f => f.producedQty - f.dispatchedQty, posted: f => f.postedAt } });
  return <div className="card list">
    {!db.fgItems.length ? <Empty icon={<PackageCheck size={20} />} title="No finished goods yet" body="When an MO reaches “Finished goods ready”, its output is added here and queued for dispatch." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 120, 110, 110, 110, 100, 210]} />
        <thead><tr>{list.th('product', 'Product / client')}{list.th('mo', 'MO')}{list.th('produced', 'Produced', 'num')}{list.th('dispatched', 'Dispatched', 'num')}{list.th('stock', 'In stock', 'num')}{list.th('posted', 'Posted')}<th>Dispatch</th></tr></thead>
        <tbody>{list.rows.map(f => {
          const mo = db.mos.find(x => x.id === f.moId); const d = db.dispatches.find(x => x.moId === f.moId);
          return <tr key={f.id}>
            <td><div className="primary-cell">{f.productName}</div><div className="sub">{leadById(db, f.leadId)?.company}</div></td><td className="mono small">{mo?.ref}</td>
            <td className="num">{fq(f.producedQty, f.unit)}</td><td className="num">{fq(f.dispatchedQty, f.unit)}</td>
            <td className="num strong">{fq(f.producedQty - f.dispatchedQty, f.unit)}</td>
            <td className="muted small nowrap" title={fmtDateTime(f.postedAt)}>{fmtShort(f.postedAt)}</td>
            <td>{d ? <span className="row"><span className="mono small">{d.ref}</span><Badge>{d.status}</Badge></span> : '—'}</td>
          </tr>;
        })}</tbody></table></div>{list.pager}</>}
  </div>;
}
