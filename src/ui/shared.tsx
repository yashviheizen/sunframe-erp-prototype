import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PriceLine, Material } from '../lib/types';
import { UNITS, MATERIAL_CATEGORIES } from '../lib/types';
import { inr, uid, lineTotal, qty as fq } from '../lib/format';
import type { DocSpec } from '../lib/pdf';
import { useStore, availableQty } from '../store';
import { Button, Modal, Field, Input, NumInput, Select, Alert, attempt } from './kit';
import { Logo } from './logo';
import { sampleMaterial } from '../lib/samples';

/** HTML rendering of the same spec the PDF is built from, so preview and download match. */
export function DocPreview({ spec }: { spec: DocSpec }) {
  return <div className="doc-paper">
    <div className="doc-top">
      <Logo size={36} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>SunFrame</div>
        <div className="muted tiny">{spec.company.legal}</div>
        <div className="faint tiny" style={{ marginTop: 4 }}>{spec.company.address}<br />{spec.company.gst} · {spec.company.contact}</div>
      </div>
      <div className="right"><h3>{spec.title}</h3><div className="muted mono">{spec.ref}</div></div>
    </div>
    <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
      <div style={{ flex: 1 }}>
        <div className="faint tiny strong" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{spec.partyLabel}</div>
        {spec.partyLines.filter(Boolean).map((l, i) => <div key={i} className={i === 0 ? 'strong' : ''}>{l}</div>)}
      </div>
      <dl className="kv" style={{ gridTemplateColumns: 'auto auto', gap: '3px 14px', fontSize: 12 }}>
        {spec.meta.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="right">{v ? v.replace('Rs. ', '₹') : '—'}</dd></div>)}
      </dl>
    </div>
    <table><thead><tr>{spec.columns.map(c => <th key={c} className={/qty|rate|amount/i.test(c) ? 'right' : ''}>{c}</th>)}</tr></thead>
      <tbody>{spec.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={/qty|rate|amount/i.test(spec.columns[j]) ? 'right' : ''}>{typeof c === 'string' ? c.replace('Rs. ', '₹') : c}</td>)}</tr>)}</tbody></table>
    <div className="totals">{spec.totals.map(([k, v, b]) => <div key={k} style={{ display: 'contents', fontWeight: b ? 700 : 400 }}>
      <span className={b ? '' : 'muted'} style={b ? { fontWeight: 700 } : undefined}>{k}</span><span className="right" style={b ? { fontWeight: 700 } : undefined}>{v.replace('Rs. ', '₹')}</span></div>)}</div>
    {spec.sections.filter(s => s.body.trim()).map(s => <div className="doc-sec" key={s.heading}><b>{s.heading}</b><p>{s.body}</p></div>)}
  </div>;
}

export function PriceLinesEditor({ lines, onChange, readOnly, showRate = true }: { lines: PriceLine[]; onChange?: (l: PriceLine[]) => void; readOnly?: boolean; showRate?: boolean }) {
  const upd = (id: string, p: Partial<PriceLine>) => onChange?.(lines.map(l => (l.id === id ? { ...l, ...p } : l)));
  return <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
    <table className="tbl tbl-compact">
      <thead><tr><th style={{ width: 32 }}>#</th><th style={{ minWidth: 260 }}>Description</th><th className="num" style={{ width: 96 }}>Qty</th><th style={{ width: 88 }}>Unit</th>
        {showRate && <><th className="num" style={{ width: 120 }}>Rate (₹)</th><th className="num" style={{ width: 130 }}>Amount</th></>}{!readOnly && <th style={{ width: 40 }} />}</tr></thead>
      <tbody>{lines.map((l, i) => <tr key={l.id}>
        <td className="faint">{i + 1}</td>
        {readOnly ? <><td>{l.description}</td><td className="num">{fq(l.qty)}</td><td>{l.unit}</td>{showRate && <><td className="num">{inr(l.rate, { decimals: true })}</td><td className="num">{inr(lineTotal(l), { decimals: true })}</td></>}</>
          : <>
            <td><Input aria-label={`Line ${i + 1} description`} value={l.description} onChange={e => upd(l.id, { description: e.target.value })} /></td>
            <td><NumInput aria-label={`Line ${i + 1} quantity`} className="right" blankZero placeholder="0" value={l.qty} onChange={n => upd(l.id, { qty: n })} /></td>
            <td><Select aria-label={`Line ${i + 1} unit`} value={l.unit} onChange={e => upd(l.id, { unit: e.target.value })}>{[...new Set([...UNITS, l.unit])].map(u => <option key={u}>{u}</option>)}</Select></td>
            {showRate && <><td><NumInput aria-label={`Line ${i + 1} rate`} className="right" blankZero placeholder="0.00" value={l.rate} onChange={n => upd(l.id, { rate: n })} /></td>
              <td className="num">{inr(lineTotal(l), { decimals: true })}</td></>}
            <td><Button size="sm" variant="ghost" iconOnly aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 1} onClick={() => onChange?.(lines.filter(x => x.id !== l.id))} icon={<Trash2 size={14} />} /></td>
          </>}
      </tr>)}</tbody>
    </table>
    {!readOnly && <div style={{ padding: 8 }}><Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onChange?.([...lines, { id: uid(), description: '', qty: 0, unit: 'pcs', rate: 0 }])}>Add line</Button></div>}
  </div>;
}

export function MaterialModal({ onClose, onCreated, initialName = '' }: { onClose: () => void; onCreated?: (m: Material) => void; initialName?: string }) {
  // Demo prefill: a fictional, unused material (a name typed in a material dropdown is kept).
  const [init] = useState(() => sampleMaterial(useStore.getState().db, initialName));
  const [name, setName] = useState(init.name);
  const [code, setCode] = useState('');
  const [category, setCategory] = useState<string>(init.category);
  const [unit, setUnit] = useState(init.unit);
  const [onHand, setOnHand] = useState(init.onHand);
  const [err, setErr] = useState('');
  const save = () => {
    const r = attempt(() => useStore.getState().addMaterial({ name, code, category, unit, onHand }), 'Material added');
    if (!r.ok) return setErr(r.error);
    onCreated?.(r.value); onClose();
  };
  return <Modal size="sm" title="New material" subtitle="Added to the raw-material master so it can be used on BOMs, PRs and POs." onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Add material</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Material name" required full htmlFor="m-n"><Input id="m-n" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. HR coil 2.0 mm" /></Field>
      <Field label="Category" htmlFor="m-c"><Select id="m-c" value={category} onChange={e => setCategory(e.target.value)}>{MATERIAL_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Unit" required htmlFor="m-u"><Select id="m-u" value={unit} onChange={e => setUnit(e.target.value)}>{UNITS.map(u => <option key={u}>{u}</option>)}</Select></Field>
      <Field label="Code" htmlFor="m-code" hint="Leave blank to auto-number"><Input id="m-code" value={code} onChange={e => setCode(e.target.value)} placeholder="RM-00x" /></Field>
      <Field label="Opening stock on hand" htmlFor="m-oh"><NumInput id="m-oh" value={onHand} onChange={setOnHand} /></Field>
    </div>
  </Modal>;
}

/** Material dropdown with an inline "add new" entry. */
export function MaterialSelect({ value, onChange, exclude = [], label, showAvail }: { value: string; onChange: (id: string) => void; exclude?: string[]; label: string; showAvail?: boolean }) {
  const db = useStore(s => s.db);
  const [adding, setAdding] = useState(false);
  return <>
    <Select aria-label={label} value={value} invalid={!value} onChange={e => { if (e.target.value === '__new') setAdding(true); else onChange(e.target.value); }}>
      <option value="">Select material…</option>
      {db.materials.filter(m => m.id === value || !exclude.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.code} · {m.name}{showAvail ? ` (avail ${fq(availableQty(db, m.id), m.unit)})` : ''}</option>)}
      <option value="__new">+ Add new material…</option>
    </Select>
    {adding && <MaterialModal onClose={() => setAdding(false)} onCreated={m => onChange(m.id)} />}
  </>;
}
