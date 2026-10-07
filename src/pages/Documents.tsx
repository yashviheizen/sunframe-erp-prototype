import { useState } from 'react';
import { FolderOpen, Upload, ExternalLink, Download } from 'lucide-react';
import { useStore } from '../store';
import { sampleDocumentFile } from '../lib/samples';
import type { DocCategory, DocRefType, DB } from '../lib/types';
import { DOC_CATEGORIES } from '../lib/types';
import { fmtDate, fmtShort, fmtDateTime, fileSize, todayISO, addDays } from '../lib/format';
import { storeFile, openFile, downloadFile } from '../lib/files';
import { PageHead, Button, Badge, Empty, Modal, Field, Input, Select, Alert, FilePick, SearchBox, Tabs, InfoTip, Cols, IconAction, useList, attempt, toastError } from '../ui/kit';
import { nav, routeQuery } from '../ui/router';
import type { DocumentRec } from '../lib/types';

const REF_LABEL: Record<DocRefType, string> = { quote: 'Quote', cpo: 'Client PO', so: 'Sales order', mo: 'Manufacturing order', po: 'Supplier PO', grn: 'GRN',
  dispatch: 'Dispatch', receivable: 'Receivable', payable: 'Payable', quotation: 'Supplier quotation' };

/** Licence validity from its expiry date; "Expiring soon" = within 60 days. */
export function licenceStatus(d: DocumentRec, today = todayISO()): 'Valid' | 'Expiring soon' | 'Expired' | 'No expiry' {
  if (!d.expiry) return 'No expiry';
  if (d.expiry < today) return 'Expired';
  return d.expiry <= addDays(today, 60) ? 'Expiring soon' : 'Valid';
}

export default function Documents({ tab }: { tab?: string }) {
  const db = useStore(s => s.db);
  const section = tab === 'licences' ? 'licences' : 'library';
  const licences = db.documents.filter(d => d.category === 'Licence');
  const [adding, setAdding] = useState(false);
  return <>
    <PageHead title="Documents" sub="Every quote, SO, PO, GRN, POD, payment proof and uploaded file in one place."
      actions={<Button variant="primary" icon={<Upload size={15} />} onClick={() => setAdding(true)}>{section === 'licences' ? 'Upload licence' : 'Upload document'}</Button>} />
    <Tabs value={section} onChange={k => nav(k === 'library' ? 'documents' : 'documents/licences')} tabs={[
      { key: 'library', label: 'Library', count: db.documents.length },
      { key: 'licences', label: 'Licences', count: licences.length, attention: licences.filter(d => licenceStatus(d) === 'Expired' || licenceStatus(d) === 'Expiring soon').length, attentionLabel: 'expired / expiring' },
    ]} />
    {section === 'licences' ? <Licences /> : <Library />}
    {adding && <UploadModal category={section === 'licences' ? 'Licence' : 'Other'} onClose={() => setAdding(false)} />}
  </>;
}

function Licences() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const today = todayISO();
  const ql = q.toLowerCase();
  const order = { Expired: 0, 'Expiring soon': 1, Valid: 2, 'No expiry': 3 };
  const rows = db.documents.filter(d => d.category === 'Licence').map(d => ({ d, st: licenceStatus(d, today) }))
    .filter(r => (!ql || [r.d.name, r.d.linkedRef].some(x => x.toLowerCase().includes(ql))) && (!status || r.st === status))
    .sort((a, b) => order[a.st] - order[b.st] || (a.d.expiry || '9').localeCompare(b.d.expiry || '9'));
  const act = (fn: () => Promise<void>) => fn().catch(e => toastError((e as Error).message));
  const list = useList(rows, { resetKey: [q, status], sort: {
    name: r => r.d.name, no: r => r.d.linkedRef, uploaded: r => r.d.uploadedAt, expiry: r => r.d.expiry, st: r => order[r.st],
  } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search licence name or number…" />
      <Select aria-label="Validity" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 170 }}>
        <option value="">Any validity</option><option>Valid</option><option>Expiring soon</option><option>Expired</option><option>No expiry</option></Select>
      <InfoTip text="Expiring soon = expires within 60 days." />
    </div>
    {!rows.length ? <Empty icon={<FolderOpen size={20} />} title="No licences match" body="Upload a document with the category “Licence” and its expiry date to track it here." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 160, 104, 112, 136, 84]} />
        <thead><tr>{list.th('name', 'Licence')}{list.th('no', 'Licence no.')}{list.th('uploaded', 'Uploaded')}{list.th('expiry', 'Expiry')}{list.th('st', 'Validity')}<th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{list.rows.map(({ d, st }) => <tr key={d.id}>
          <td><div className="primary-cell">{d.name}</div><div className="sub">{d.file.name} · {fileSize(d.file.size)}</div></td>
          <td className="mono small">{d.linkedRef || '—'}</td>
          <td className="muted small" title={fmtDate(d.uploadedAt.slice(0, 10))}>{fmtShort(d.uploadedAt.slice(0, 10))}</td>
          <td className="small" title={d.expiry ? fmtDate(d.expiry) : undefined}>{d.expiry ? fmtShort(d.expiry) : <span className="faint">—</span>}</td>
          <td><Badge>{st}</Badge></td>
          <td className="actions"><div className="row">
            <IconAction label={`Open ${d.name}`} icon={<ExternalLink size={14} />} onClick={() => act(() => openFile(d.file))} />
            <IconAction label={`Download ${d.name}`} icon={<Download size={14} />} onClick={() => act(() => downloadFile(d.file))} />
          </div></td>
        </tr>)}</tbody></table></div>{list.pager}</>}
  </div>;
}

function Library() {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const [cat, setCat] = useState('');
  const [client, setClient] = useState('');
  const [supplier, setSupplier] = useState('');
  const clients = [...new Set(db.documents.filter(d => d.partyType === 'client').map(d => d.partyName).filter(Boolean))].sort();
  const suppliers = [...new Set(db.documents.filter(d => d.partyType === 'supplier').map(d => d.partyName).filter(Boolean))].sort();
  const ql = q.toLowerCase();
  const rows = db.documents.filter(d => (!ql || [d.name, d.linkedRef, d.partyName].some(x => x.toLowerCase().includes(ql)))
    && (!cat || d.category === cat) && (!client || (d.partyType === 'client' && d.partyName === client)) && (!supplier || (d.partyType === 'supplier' && d.partyName === supplier)));
  const today = todayISO();
  const act = (fn: () => Promise<void>) => fn().catch(e => toastError((e as Error).message));
  const list = useList(rows, { resetKey: [q, cat, client, supplier], sort: {
    name: d => d.name, cat: d => d.category, party: d => d.partyName, ref: d => d.linkedRef, added: d => d.uploadedAt, expiry: d => d.expiry,
  } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search name or reference…" />
      <Select aria-label="Category" value={cat} onChange={e => setCat(e.target.value)} style={{ width: 170 }}>
        <option value="">All categories</option>{DOC_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select>
      <Select aria-label="Client" value={client} onChange={e => { setClient(e.target.value); if (e.target.value) setSupplier(''); }} style={{ width: 170 }}>
        <option value="">All clients</option>{clients.map(c => <option key={c}>{c}</option>)}</Select>
      <Select aria-label="Supplier" value={supplier} onChange={e => { setSupplier(e.target.value); if (e.target.value) setClient(''); }} style={{ width: 170 }}>
        <option value="">All suppliers</option>{suppliers.map(c => <option key={c}>{c}</option>)}</Select>
    </div>
    {!rows.length ? <Empty icon={<FolderOpen size={20} />} title={db.documents.length ? 'No documents match these filters' : 'No documents yet'}
      body="Generated quotes, SOs and POs, and uploaded GRNs, PODs and proofs appear here automatically." />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[undefined, 150, 180, 140, 92, 112, 84]} />
        <thead><tr>{list.th('name', 'Document')}{list.th('cat', 'Category')}{list.th('party', 'Party')}{list.th('ref', 'Linked to')}{list.th('added', 'Added')}{list.th('expiry', 'Expiry')}<th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{list.rows.map(d => <tr key={d.id}>
          <td><div className="primary-cell">{d.name}</div><div className="sub">{d.file.name} · {fileSize(d.file.size)}</div></td>
          <td><div><Badge plain>{d.category}</Badge></div><div className="sub">{d.source === 'Generated' ? 'Generated' : 'Uploaded'}</div></td>
          <td className="small"><div>{d.partyName || '—'}</div>{d.partyType !== 'none' && <div className="sub">{d.partyType === 'client' ? 'Client' : 'Supplier'}</div>}</td>
          <td className="small">{d.leadId ? <a className="link" href={`#/sales/${d.leadId}`}>{d.linkedRef || 'Lead'}</a> : <span className="mono">{d.linkedRef || '—'}</span>}{d.refType && <div className="sub">{REF_LABEL[d.refType]}</div>}</td>
          <td className="muted small" title={fmtDateTime(d.uploadedAt)}>{fmtShort(d.uploadedAt.slice(0, 10))}</td>
          <td className="small" title={d.expiry ? fmtDate(d.expiry) : undefined}>{d.expiry ? <span style={{ color: d.expiry < today ? 'var(--danger)' : undefined }}>{fmtShort(d.expiry)}{d.expiry < today ? ' · expired' : ''}</span> : <span className="faint">—</span>}</td>
          <td className="actions"><div className="row">
            <IconAction label={`Open ${d.name}`} icon={<ExternalLink size={14} />} onClick={() => act(() => openFile(d.file))} />
            <IconAction label={`Download ${d.name}`} icon={<Download size={14} />} onClick={() => act(() => downloadFile(d.file))} />
          </div></td>
        </tr>)}</tbody></table></div>{list.pager}</>}
  </div>;
}

/** Records of a lead that an upload can be linked to, by stable id. */
export function leadRecords(db: DB, leadId: string): { type: DocRefType; id: string; ref: string; label: string }[] {
  const out: { type: DocRefType; id: string; ref: string; label: string }[] = [];
  const q = db.quotes.find(x => x.leadId === leadId); if (q) out.push({ type: 'quote', id: q.id, ref: q.ref, label: `Quote ${q.ref}` });
  const c = db.clientPOs.find(x => x.leadId === leadId); if (c) out.push({ type: 'cpo', id: c.id, ref: c.poNumber, label: `Client PO ${c.poNumber}` });
  const so = db.salesOrders.find(x => x.leadId === leadId); if (so) out.push({ type: 'so', id: so.id, ref: so.ref, label: `Sales order ${so.ref}` });
  const mo = db.mos.find(x => x.leadId === leadId); if (mo) out.push({ type: 'mo', id: mo.id, ref: mo.ref, label: `Manufacturing order ${mo.ref}` });
  db.dispatches.filter(d => d.leadId === leadId).forEach(d => out.push({ type: 'dispatch', id: d.id, ref: d.ref, label: `Dispatch ${d.ref}` }));
  db.receivables.filter(r => r.leadId === leadId).forEach(r => out.push({ type: 'receivable', id: r.id, ref: r.ref, label: `Receivable ${r.ref}` }));
  return out;
}

/** Upload with stable-id links to a lead (and one of its records) and/or a supplier. */
export function UploadModal({ onClose, leadId: presetLead = '', category: presetCat = 'Other' }: { onClose: () => void; leadId?: string; category?: DocCategory }) {
  const db = useStore(s => s.db);
  // Demo prefill: a descriptive name and a generated, clearly fictional sample file. Stored only on Upload.
  const presetCompany = db.leads.find(l => l.id === presetLead)?.company;
  const [f, setF] = useState(() => ({ name: `${presetCat === 'Other' ? 'Site visit notes' : presetCat}${presetCompany ? ` — ${presetCompany}` : ''} (sample)`, category: presetCat as DocCategory, leadId: presetLead, record: '', supplierId: '', expiry: '', licenceNo: '' }));
  const docSample = () => sampleDocumentFile(useStore.getState().db, f.name || 'Document', f.category, db.leads.find(l => l.id === f.leadId)?.company ?? db.suppliers.find(s => s.id === f.supplierId)?.name);
  const [file, setFile] = useState<File | null>(docSample);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }));
  const records = f.leadId ? leadRecords(db, f.leadId) : [];
  const save = async () => {
    if (!file) return setErr('Choose a file to upload.');
    setBusy(true);
    try {
      const meta = await storeFile(file);
      const lead = db.leads.find(l => l.id === f.leadId);
      const sup = db.suppliers.find(s => s.id === f.supplierId);
      const rec = records.find(r => r.id === f.record);
      const r = attempt(() => useStore.getState().addDocument({
        name: f.name || file.name, file: meta, category: f.category, expiry: f.expiry,
        partyType: lead ? 'client' : sup ? 'supplier' : 'none', partyName: lead?.company ?? sup?.name ?? '',
        linkedRef: f.category === 'Licence' && f.licenceNo.trim() ? f.licenceNo.trim() : rec?.ref ?? lead?.ref ?? '', leadId: lead?.id, supplierId: sup?.id, refType: rec?.type, refId: rec?.id,
      }), 'Document uploaded');
      if (r.ok) onClose(); else setErr(r.error);
    } finally { setBusy(false); }
  };
  return <Modal title="Upload document" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>Upload</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="File" required full><FilePick file={file} sample={docSample} onChange={x => { setFile(x); if (x && !f.name) set('name', x.name.replace(/\.[^.]+$/, '')); }} /></Field>
      <Field label="Document name" required htmlFor="u-n"><Input id="u-n" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
      <Field label="Category" required htmlFor="u-c"><Select id="u-c" value={f.category} onChange={e => set('category', e.target.value)}>{DOC_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Lead / project" htmlFor="u-l"><Select id="u-l" value={f.leadId} disabled={!!presetLead} onChange={e => setF(p => ({ ...p, leadId: e.target.value, record: '' }))}>
        <option value="">Not linked</option>{db.leads.map(l => <option key={l.id} value={l.id}>{l.company}{l.project ? ` · ${l.project}` : ''} ({l.ref})</option>)}</Select></Field>
      <Field label="Related record" htmlFor="u-r"><Select id="u-r" value={f.record} disabled={!records.length} onChange={e => set('record', e.target.value)}>
        <option value="">{f.leadId ? (records.length ? 'Whole lead' : 'No records yet') : 'Choose a lead first'}</option>{records.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
      <Field label="Supplier" htmlFor="u-s"><Select id="u-s" value={f.supplierId} onChange={e => set('supplierId', e.target.value)}>
        <option value="">Not linked</option>{db.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      {f.category === 'Licence' && <Field label="Licence number" htmlFor="u-ln"><Input id="u-ln" value={f.licenceNo} onChange={e => set('licenceNo', e.target.value)} /></Field>}
      <Field label={f.category === 'Licence' ? 'Expiry date (leave blank if none)' : 'Expiry date (optional)'} htmlFor="u-e"><Input id="u-e" type="date" value={f.expiry} onChange={e => set('expiry', e.target.value)} /></Field>
    </div>
  </Modal>;
}
