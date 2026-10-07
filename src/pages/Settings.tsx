import { useState } from 'react';
import { UserPlus, Check, Minus, CheckCircle2, Circle } from 'lucide-react';
import type { Role, Settings as CompanySettings } from '../lib/types';
import { DEPARTMENTS } from '../lib/types';
import { useStore, emptySettings, isAdmin, currentUser } from '../store';
import { sampleUser } from '../lib/samples';
import { PageHead, Button, Badge, Modal, Field, Input, Select, Textarea, Alert, Confirm, Tabs, InfoTip, Cols, useList, attempt, toast } from '../ui/kit';
import { clearFiles } from '../lib/files';
import { nav } from '../ui/router';

type SettingsTab = 'company' | 'users' | 'roles' | 'approvals';
const TABS: SettingsTab[] = ['company', 'users', 'roles', 'approvals'];

/** What each role can do. Mirrors the admin checks enforced in src/store.ts — read-only, not configurable. */
const PERMISSIONS: { area: string; action: string; user: boolean }[] = [
  { area: 'CRM & sales', action: 'Create and edit leads, BOMs, quotes, Client POs, SOs and MOs', user: true },
  { area: 'Procurement', action: 'Raise purchase requests (sees own PRs only)', user: true },
  { area: 'Procurement', action: 'See all PRs, edit PR quantities, approve or reject PRs', user: false },
  { area: 'Procurement', action: 'Create a supplier PO against a pending PR (approves the PR)', user: false },
  { area: 'Procurement', action: 'Add suppliers, set active/inactive, upload supplier quotations', user: true },
  { area: 'Procurement', action: 'Complete PO details, receive goods (GRN)', user: true },
  { area: 'Manufacturing', action: 'Assign MOs to a production line', user: false },
  { area: 'Manufacturing', action: 'Configure production stages', user: false },
  { area: 'Manufacturing', action: 'Issue materials and move MOs through stages', user: true },
  { area: 'Dispatch & finance', action: 'Confirm dispatch, upload POD, record receipts and supplier payments', user: true },
  { area: 'Documents', action: 'Upload and open documents', user: true },
  { area: 'HRMS', action: 'Request leave', user: true },
  { area: 'HRMS', action: 'Add/edit employees, approve leave, create and complete payroll', user: false },
  { area: 'Settings', action: 'Edit company settings, add users, erase data', user: false },
];

/** Approval steps implemented in the workflows. Shown for reference; they are not configurable in this prototype. */
const RULES: { what: string; rule: string; approver: string; result: string }[] = [
  { what: 'Purchase request', rule: 'Every PR (manual or automatic MO shortfall) needs approval; admin may edit quantities first', approver: 'Admin', result: 'Approval creates a linked supplier PO ("Details required"); rejection closes the PR' },
  { what: 'Supplier PO', rule: 'Saved once supplier, rates and payment terms (30/60/90 days) are complete; inactive suppliers cannot be used', approver: 'Admin (when it approves a pending PR)', result: 'Saved as Approved and creates a payable due PO date + terms' },
  { what: 'Production line', rule: 'MOs wait in the unassigned queue until a line is chosen', approver: 'Admin', result: 'MO appears on Line 1 / Line 2; materials can be issued once fully reserved' },
  { what: 'Leave request', rule: 'Requests start as Pending; overlapping requests for the same employee are blocked', approver: 'Admin', result: 'Approved or Rejected (decision is final)' },
  { what: 'Payroll run', rule: 'One run per month; Draft totals editable until completed', approver: 'Admin', result: 'Completed runs are locked' },
  { what: 'Quote', rule: 'No approval step: Draft → Quote sent (moves the lead to "Quote sent"); shown green when the lead is Won', approver: '—', result: '—' },
];

export default function Settings({ tab }: { tab?: string }) {
  const db = useStore(s => s.db);
  const section: SettingsTab = TABS.includes(tab as SettingsTab) ? tab as SettingsTab : 'company';
  const admins = db.users.filter(u => u.role === 'admin').length;
  return <>
    <PageHead title="Settings" sub="Company details for PDFs, simulated users and roles, and the approval rules built into the workflows." />
    <Tabs value={section} onChange={k => nav(k === 'company' ? 'settings' : `settings/${k}`)} tabs={[
      { key: 'company', label: 'Company' },
      { key: 'users', label: 'Users', count: db.users.length },
      { key: 'roles', label: 'Roles', count: 2 },
      { key: 'approvals', label: 'Approval rules', count: RULES.length },
    ]} />
    {section !== 'company' && <div className="mb12"><Alert kind="info">
      Simulated users, no sign-in — pick who you act as in the top bar ({admins} admin{admins === 1 ? '' : 's'}, {db.users.length - admins} user{db.users.length - admins === 1 ? '' : 's'}).
    </Alert></div>}
    {section === 'company' && <Company />}
    {section === 'users' && <Users />}
    {section === 'roles' && <Roles />}
    {section === 'approvals' && <Approvals />}
  </>;
}

function Company() {
  const db = useStore(s => s.db);
  const [f, setF] = useState<CompanySettings>({ ...emptySettings(), ...db.settings });
  const [err, setErr] = useState('');
  const [resetting, setResetting] = useState(false);
  const set = (k: keyof CompanySettings, v: string) => setF(p => ({ ...p, [k]: v }));
  const admin = isAdmin(db);
  const dirty = JSON.stringify(f) !== JSON.stringify({ ...emptySettings(), ...db.settings });
  const save = () => { const r = attempt(() => useStore.getState().saveSettings(f), 'Company settings saved'); setErr(r.ok ? '' : r.error); };
  return <><SetupChecklist /><div className="card card-pad" style={{ maxWidth: 860 }}>
    <div className="muted small mb12">Printed on quotes, sales orders and purchase orders. Leave a field blank to print a labelled placeholder.</div>
    {!admin && <div className="mb12"><Alert kind="warning">Only an admin can change company settings.</Alert></div>}
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="form-grid">
        <Field label="Legal name" htmlFor="cs-l"><Input id="cs-l" value={f.legalName} onChange={e => set('legalName', e.target.value)} /></Field>
        <Field label="GSTIN" htmlFor="cs-g"><Input id="cs-g" value={f.gstin} onChange={e => set('gstin', e.target.value.toUpperCase())} /></Field>
        <Field label="Address" full htmlFor="cs-a"><Input id="cs-a" value={f.address} onChange={e => set('address', e.target.value)} /></Field>
        <Field label="Contact (email · phone)" full htmlFor="cs-c"><Input id="cs-c" value={f.contact} onChange={e => set('contact', e.target.value)} /></Field>
        <Field label="Default quote payment terms" htmlFor="cs-qp" hint="e.g. “30 days from dispatch” — days are read for due dates"><Input id="cs-qp" value={f.quotePaymentTerms} onChange={e => set('quotePaymentTerms', e.target.value)} /></Field>
        <Field label="Default quote delivery terms" htmlFor="cs-qd"><Input id="cs-qd" value={f.quoteDeliveryTerms} onChange={e => set('quoteDeliveryTerms', e.target.value)} /></Field>
        <Field label="Default quote terms & conditions" full htmlFor="cs-qt"><Textarea id="cs-qt" rows={3} value={f.quoteTerms} onChange={e => set('quoteTerms', e.target.value)} /></Field>
        <Field label="Purchase order notes" full htmlFor="cs-po"><Textarea id="cs-po" rows={2} value={f.poNotes} onChange={e => set('poNotes', e.target.value)} /></Field>
      </div>
    </fieldset>
    {admin && <div className="row mt12"><div className="spacer" />
      <Button disabled={!dirty} onClick={() => { setF({ ...emptySettings(), ...db.settings }); setErr(''); }}>Discard changes</Button>
      <Button variant="primary" disabled={!dirty} onClick={save}>Save</Button></div>}
    {admin && <details className="mt24 small">
      <summary className="muted">Data in this browser</summary>
      <div className="row mt12" style={{ alignItems: 'center' }}>
        <span className="muted" style={{ flex: 1 }}>Records are stored in this browser and uploaded files in IndexedDB. Erasing clears both; nothing is re-added afterwards.</span>
        <Button size="sm" variant="danger" onClick={() => setResetting(true)}>Erase all data…</Button>
      </div>
    </details>}
    {resetting && <Confirm title="Erase all data?" confirmLabel="Erase everything" danger onClose={() => setResetting(false)}
      onConfirm={async () => { await clearFiles(); useStore.getState().reset(); toast('All data erased'); nav('dashboard'); }}
      body="Every lead, order, stock record and uploaded file in this browser will be permanently deleted." />}
  </div></>;
}

/** Setup checklist — lives here rather than on the Dashboard. Hidden once everything is in place. */
function SetupChecklist() {
  const db = useStore(s => s.db);
  const st = db.settings;
  const steps = [
    { label: 'Company details', done: !!(st?.legalName && st.address), go: undefined },
    { label: 'Raw materials', done: db.materials.length > 0, go: () => nav('inventory') },
    { label: 'Suppliers', done: db.suppliers.length > 0, go: () => nav('procurement/suppliers') },
    { label: 'First lead', done: db.leads.length > 0, go: () => nav('crm') },
  ];
  if (steps.every(x => x.done)) return null;
  return <div className="setup-strip" aria-label="Setup checklist" style={{ maxWidth: 860 }}>
    <b>Setup</b>
    {steps.map(x => x.go
      ? <button key={x.label} className={'st link' + (x.done ? ' ok' : '')} onClick={x.go}>{x.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}{x.label}</button>
      : <span key={x.label} className={'st' + (x.done ? ' ok' : '')}>{x.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}{x.label}</span>)}
  </div>;
}

function Users() {
  const db = useStore(s => s.db);
  const me = currentUser(db);
  const admin = isAdmin(db);
  const [adding, setAdding] = useState(false);
  const prs = (id: string) => db.prs.filter(p => p.raisedById === id).length;
  const list = useList(db.users, { sort: { name: u => u.name, title: u => u.title, dept: u => u.department, email: u => u.email, role: u => u.role, prs: u => prs(u.id) } });
  return <div className="card list">
    <div className="toolbar"><span className="muted small">Each person's role sets what they can see and approve. To work as someone else, log out and sign in with their account.</span>
      <InfoTip text="Users cannot be removed, to keep the history of approvals and requests intact." /><div className="spacer" />
      {admin ? <Button size="sm" variant="primary" icon={<UserPlus size={14} />} onClick={() => setAdding(true)}>Add user</Button>
        : <span className="faint small">Only an admin can add users</span>}</div>
    <div className="table-scroll"><table className="tbl fixed">
      <Cols w={[undefined, 170, 130, 210, 90, 104]} />
      <thead><tr>{list.th('name', 'Name')}{list.th('title', 'Title')}{list.th('dept', 'Department')}{list.th('email', 'Email')}{list.th('role', 'Role')}{list.th('prs', 'PRs raised', 'num')}</tr></thead>
      <tbody>{list.rows.map(u => <tr key={u.id}>
        <td><div className="primary-cell">{u.name}{u.id === me.id && <span className="faint tiny" style={{ fontWeight: 400 }}> · you</span>}</div></td>
        <td className="small">{u.title || '—'}</td>
        <td className="small">{u.department || '—'}</td>
        <td className="small">{u.email || <span className="faint">—</span>}</td>
        <td><Badge>{u.role === 'admin' ? 'Admin' : 'User'}</Badge></td>
        <td className="num small">{prs(u.id)}</td>
              </tr>)}</tbody>
    </table></div>
    {list.pager}
    {adding && <AddUser onClose={() => setAdding(false)} />}
  </div>;
}

function AddUser({ onClose }: { onClose: () => void }) {
  // Demo prefill: a fictional user (.example email) with the non-admin role.
  const [f, setF] = useState<{ name: string; title: string; department: string; email: string; role: Role }>(() => sampleUser(useStore.getState().db));
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }));
  const save = () => { const r = attempt(() => useStore.getState().addUser({ ...f, email: f.email.trim() || undefined, department: f.department || undefined }), `${f.name.trim()} added`); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal size="sm" title="Add user" subtitle="A simulated user for trying the workflows — no password or sign-in." onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Add user</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Name" required full htmlFor="nu-n"><Input id="nu-n" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
      <Field label="Title" htmlFor="nu-t"><Input id="nu-t" value={f.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Purchase executive" /></Field>
      <Field label="Department" htmlFor="nu-d"><Select id="nu-d" value={f.department} onChange={e => set('department', e.target.value)}>
        <option value="">—</option>{DEPARTMENTS.map(d => <option key={d}>{d}</option>)}</Select></Field>
      <Field label="Email" htmlFor="nu-e"><Input id="nu-e" type="email" value={f.email} onChange={e => set('email', e.target.value)} /></Field>
      <Field label="Role" htmlFor="nu-r"><Select id="nu-r" value={f.role} onChange={e => set('role', e.target.value)}><option value="user">User</option><option value="admin">Admin</option></Select></Field>
    </div>
  </Modal>;
}

function Roles() {
  const db = useStore(s => s.db);
  const count = (r: Role) => db.users.filter(u => u.role === r).length;
  const Yes = () => <Check size={15} style={{ color: 'var(--success)' }} aria-label="Allowed" />;
  const No = () => <Minus size={15} className="faint" aria-label="Not allowed" />;
  return <div className="card list">
    <div className="toolbar"><span className="muted small">Two fixed roles</span><InfoTip text="This matrix shows the permissions enforced by the app; it is not editable." /></div>
    <div className="table-scroll"><table className="tbl fixed">
      <Cols w={[160, undefined, 120, 120]} />
      <thead><tr><th>Area</th><th>Action</th><th className="center">Admin ({count('admin')})</th><th className="center">User ({count('user')})</th></tr></thead>
      <tbody>{PERMISSIONS.map((p, i) => <tr key={i}>
        <td className="small muted">{p.area}</td><td className="small">{p.action}</td>
        <td className="center"><Yes /></td><td className="center">{p.user ? <Yes /> : <No />}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

/** Reference text that wraps to two lines (full text in the tooltip) instead of a one-line ellipsis. */
const Wrap = ({ children }: { children: string }) => <div className="clamp2" style={{ display: '-webkit-box', whiteSpace: 'normal' }}>{children}</div>;

function Approvals() {
  return <div className="card list">
    <div className="toolbar"><span className="muted small">Approval steps built into the workflows</span><InfoTip text="Shown for reference. They are not configurable in this prototype." /></div>
    <div className="table-scroll"><table className="tbl fixed">
      <Cols w={[150, undefined, 150, 300]} />
      <thead><tr><th>Record</th><th>Rule</th><th>Approver</th><th>Outcome</th></tr></thead>
      <tbody>{RULES.map(r => <tr key={r.what}>
        <td className="primary-cell">{r.what}</td><td className="small"><Wrap>{r.rule}</Wrap></td><td className="small"><Wrap>{r.approver}</Wrap></td><td className="small"><Wrap>{r.result}</Wrap></td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}
