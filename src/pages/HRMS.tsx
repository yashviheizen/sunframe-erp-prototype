import { useState } from 'react';
import { UserPlus, CalendarPlus, Plus, Check, X, IdCard } from 'lucide-react';
import type { Employee, EmployeeStatus, LeaveRequest, PayrollRun } from '../lib/types';
import { DEPARTMENTS, LEAVE_TYPES } from '../lib/types';
import { useStore, isAdmin } from '../store';
import { sampleEmployee, sampleLeave, samplePayrollMonth } from '../lib/samples';
import { inr, fmtDate, fmtShort, fmtDateTime, todayISO } from '../lib/format';
import { PageHead, Button, Badge, Modal, Field, Input, NumInput, Select, Textarea, Alert, Empty, SearchBox, Tabs, InfoTip, Cols, useList, attempt, tryToast } from '../ui/kit';
import { nav } from '../ui/router';

type HrTab = 'employees' | 'leave' | 'payroll';
const TABS: HrTab[] = ['employees', 'leave', 'payroll'];
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }); };

export default function HRMS({ tab }: { tab?: string }) {
  const db = useStore(s => s.db);
  const section: HrTab = TABS.includes(tab as HrTab) ? tab as HrTab : 'employees';
  return <>
    <PageHead title="HRMS" sub="Employee records, leave and monthly payroll totals (no statutory PF/ESI/TDS calculations)." />
    <Tabs value={section} onChange={k => nav(k === 'employees' ? 'hrms' : `hrms/${k}`)} tabs={[
      { key: 'employees', label: 'Employees', count: db.employees.length, attention: db.employees.filter(e => e.status === 'On notice').length, attentionLabel: 'on notice' },
      { key: 'leave', label: 'Leave', count: db.leaves.length, attention: db.leaves.filter(l => l.status === 'Pending').length, attentionLabel: 'pending' },
      { key: 'payroll', label: 'Payroll', count: db.payrollRuns.length, attention: db.payrollRuns.filter(r => r.status === 'Draft').length, attentionLabel: 'draft' },
    ]} />
    {section === 'employees' && <Employees />}
    {section === 'leave' && <Leave />}
    {section === 'payroll' && <Payroll />}
  </>;
}

function Employees() {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  const ql = q.toLowerCase();
  const rows = db.employees.filter(e => (!ql || [e.name, e.code, e.designation, e.phone].some(x => x.toLowerCase().includes(ql))) && (!dept || e.department === dept) && (!status || e.status === status));
  const active = db.employees.filter(e => e.status !== 'Inactive');
  const list = useList(rows, { resetKey: [q, dept, status], sort: {
    code: e => e.code, name: e => e.name, dept: e => e.department, line: e => e.lineShift, joined: e => e.joinedOn, salary: e => e.monthlySalary, status: e => e.status,
  } });
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search name, code, designation…" />
      <Select aria-label="Department" value={dept} onChange={e => setDept(e.target.value)} style={{ width: 160 }}>
        <option value="">All departments</option>{DEPARTMENTS.map(d => <option key={d}>{d}</option>)}</Select>
      <Select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 140 }}>
        <option value="">Any status</option><option>Active</option><option>On notice</option><option>Inactive</option></Select>
      <span className="muted small nowrap">{active.length} on payroll · {inr(active.reduce((a, e) => a + e.monthlySalary, 0))}/mo</span>
      <div className="spacer" />
      {admin && <Button size="sm" variant="primary" icon={<UserPlus size={14} />} onClick={() => setEdit('new')}>Add employee</Button>}
    </div>
    {!rows.length ? <Empty icon={<IdCard size={20} />} title={db.employees.length ? 'No employees match' : 'No employees yet'} body={db.employees.length ? 'Try a different search or filter.' : admin ? 'Add employees to track leave and payroll.' : 'An admin adds employees.'} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[88, undefined, 128, 132, 124, 92, 116, 104]} />
        <thead><tr>{list.th('code', 'Code')}{list.th('name', 'Name')}{list.th('dept', 'Department')}{list.th('line', 'Line / shift')}<th>Phone</th>{list.th('joined', 'Joined')}{list.th('salary', 'Salary / mo', 'num')}{list.th('status', 'Status')}</tr></thead>
        <tbody>{list.rows.map(e => <tr key={e.id} className={admin ? 'clickable' : undefined} tabIndex={admin ? 0 : undefined}
          onClick={admin ? () => setEdit(e) : undefined} onKeyDown={admin ? ev => ev.key === 'Enter' && setEdit(e) : undefined}>
          <td className="mono small">{e.code}</td>
          <td><div className="primary-cell">{e.name}</div><div className="sub">{e.designation || '—'}</div></td>
          <td className="small">{e.department}</td><td className="small">{e.lineShift || '—'}</td><td className="small">{e.phone || '—'}</td>
          <td className="small" title={fmtDate(e.joinedOn)}>{fmtShort(e.joinedOn)}</td><td className="num small">{inr(e.monthlySalary)}</td><td><Badge>{e.status}</Badge></td>
        </tr>)}</tbody></table></div>{list.pager}</>}
    {edit && <EmployeeModal emp={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
  </div>;
}

function EmployeeModal({ emp, onClose }: { emp: Employee | null; onClose: () => void }) {
  // Saved values when editing; a fictional sample employee when adding.
  const [f, setF] = useState(() => { const x = emp ?? sampleEmployee(useStore.getState().db);
    return { name: x.name, department: x.department, designation: x.designation, lineShift: x.lineShift, phone: x.phone, joinedOn: x.joinedOn, monthlySalary: x.monthlySalary, status: x.status as EmployeeStatus }; });
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));
  const save = () => { const r = attempt(() => useStore.getState().saveEmployee({ ...f, id: emp?.id }), emp ? `${emp.code} updated` : `${f.name.trim()} added`); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal title={emp ? `${emp.code} · ${emp.name}` : 'Add employee'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Name" required htmlFor="em-n"><Input id="em-n" value={f.name} onChange={e => set('name', e.target.value)} /></Field>
      <Field label="Designation" htmlFor="em-d"><Input id="em-d" value={f.designation} onChange={e => set('designation', e.target.value)} /></Field>
      <Field label="Department" required htmlFor="em-dp"><Select id="em-dp" value={f.department} onChange={e => set('department', e.target.value)}>{DEPARTMENTS.map(d => <option key={d}>{d}</option>)}</Select></Field>
      <Field label="Line / shift" htmlFor="em-l"><Input id="em-l" value={f.lineShift} onChange={e => set('lineShift', e.target.value)} placeholder="e.g. Line 1 · Shift A" /></Field>
      <Field label="Phone" htmlFor="em-p"><Input id="em-p" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
      <Field label="Joined on" htmlFor="em-j"><Input id="em-j" type="date" value={f.joinedOn} onChange={e => set('joinedOn', e.target.value)} /></Field>
      <Field label="Monthly salary (₹)" htmlFor="em-s"><NumInput id="em-s" value={f.monthlySalary} onChange={n => set('monthlySalary', n)} /></Field>
      <Field label="Status" htmlFor="em-st"><Select id="em-st" value={f.status} onChange={e => set('status', e.target.value as EmployeeStatus)}><option>Active</option><option>On notice</option><option>Inactive</option></Select></Field>
    </div>
  </Modal>;
}

function Leave() {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const emp = (id: string) => db.employees.find(e => e.id === id);
  const rows = db.leaves.filter(l => !status || l.status === status).sort((a, b) => Number(b.status === 'Pending') - Number(a.status === 'Pending') || b.from.localeCompare(a.from));
  const decide = (l: LeaveRequest, s: 'Approved' | 'Rejected') => tryToast(() => useStore.getState().decideLeave(l.id, s), `Leave ${s.toLowerCase()} for ${emp(l.employeeId)?.name}`);
  const list = useList(rows, { resetKey: [status], sort: {
    emp: l => emp(l.employeeId)?.name, type: l => l.type, from: l => l.from, status: l => l.status,
  } });
  return <div className="card list">
    <div className="toolbar">
      <Select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 150 }}>
        <option value="">All requests</option><option>Pending</option><option>Approved</option><option>Rejected</option></Select>
      <InfoTip text={admin ? 'Pending requests are listed first. Approve or reject them from the row.' : 'An admin approves leave requests.'} />
      <div className="spacer" />
      <Button size="sm" variant="primary" icon={<CalendarPlus size={14} />} disabled={!db.employees.length} onClick={() => setAdding(true)}>Request leave</Button>
    </div>
    {!rows.length ? <Empty icon={<CalendarPlus size={20} />} title={db.leaves.length ? 'No matching leave requests' : 'No leave requests'} />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[200, 100, 140, undefined, 156, 188]} />
        <thead><tr>{list.th('emp', 'Employee')}{list.th('type', 'Type')}{list.th('from', 'Dates')}<th>Reason</th>{list.th('status', 'Status')}<th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{list.rows.map(l => <tr key={l.id}>
          <td><div className="primary-cell">{emp(l.employeeId)?.name ?? '—'}</div><div className="sub">{emp(l.employeeId)?.department}</div></td>
          <td className="small">{l.type}</td>
          <td className="small" title={`${fmtDate(l.from)} – ${fmtDate(l.to)}`}><div>{l.from === l.to ? fmtShort(l.from) : `${fmtShort(l.from)} – ${fmtShort(l.to)}`}</div><div className="sub">{l.days} day{l.days === 1 ? '' : 's'}</div></td>
          <td className="small">{l.reason || '—'}</td>
          <td><div><Badge>{l.status}</Badge></div>{l.decidedBy && <div className="sub" title={`${l.decidedBy} · ${fmtDate(l.decidedAt?.slice(0, 10))}`}>{fmtShort(l.decidedAt?.slice(0, 10))} · {l.decidedBy}</div>}</td>
          <td className="actions"><div className="row">{admin && l.status === 'Pending' && <>
            <Button size="sm" variant="ghost" icon={<Check size={13} />} onClick={() => decide(l, 'Approved')}>Approve</Button>
            <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => decide(l, 'Rejected')}>Reject</Button></>}</div></td>
        </tr>)}</tbody></table></div>{list.pager}</>}
    {adding && <LeaveModal onClose={() => setAdding(false)} />}
  </div>;
}

function LeaveModal({ onClose }: { onClose: () => void }) {
  const db = useStore(s => s.db);
  const staff = db.employees.filter(e => e.status !== 'Inactive');
  // Demo prefill: next week, for an employee with no overlapping leave. Submitting still goes through approval.
  const [f, setF] = useState<{ employeeId: string; type: LeaveRequest['type']; from: string; to: string; reason: string }>(() => sampleLeave(db, staff));
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));
  const save = () => { const r = attempt(() => useStore.getState().addLeave(f), 'Leave requested'); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal size="sm" title="Request leave" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Submit request</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Employee" required full htmlFor="lv-e"><Select id="lv-e" value={f.employeeId} onChange={e => set('employeeId', e.target.value)}>{staff.map(e => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}</Select></Field>
      <Field label="Type" htmlFor="lv-t"><Select id="lv-t" value={f.type} onChange={e => set('type', e.target.value as LeaveRequest['type'])}>{LEAVE_TYPES.map(t => <option key={t}>{t}</option>)}</Select></Field>
      <div />
      <Field label="From" required htmlFor="lv-f"><Input id="lv-f" type="date" value={f.from} onChange={e => set('from', e.target.value)} /></Field>
      <Field label="To" required htmlFor="lv-to"><Input id="lv-to" type="date" value={f.to} onChange={e => set('to', e.target.value)} /></Field>
      <Field label="Reason" full htmlFor="lv-r"><Textarea id="lv-r" rows={2} value={f.reason} onChange={e => set('reason', e.target.value)} /></Field>
    </div>
  </Modal>;
}

function Payroll() {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  const [edit, setEdit] = useState<PayrollRun | 'new' | null>(null);
  const rows = [...db.payrollRuns].sort((a, b) => b.month.localeCompare(a.month));
  const list = useList(rows, { sort: { month: r => r.month, emps: r => r.employees, gross: r => r.gross, ded: r => r.deductions, net: r => r.net, status: r => r.status } });
  const editable = (r: PayrollRun) => admin && r.status === 'Draft';
  return <div className="card list">
    <div className="toolbar">
      <span className="muted small">Monthly totals only</span>
      <InfoTip text="Gross = sum of monthly salaries of active and on-notice employees when the run is created. Deductions are entered as one total. Draft runs can be edited and completed." />
      <div className="spacer" />
      {admin && <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEdit('new')}>New payroll run</Button>}
    </div>
    {!rows.length ? <Empty icon={<IdCard size={20} />} title="No payroll runs yet" />
      : <><div className="table-scroll"><table className="tbl fixed">
        <Cols w={[120, 104, 132, 124, 132, 196, undefined]} />
        <thead><tr>{list.th('month', 'Month')}{list.th('emps', 'Employees', 'num')}{list.th('gross', 'Gross', 'num')}{list.th('ded', 'Deductions', 'num')}{list.th('net', 'Net pay', 'num')}{list.th('status', 'Status')}<th>Notes</th></tr></thead>
        <tbody>{list.rows.map(r => <tr key={r.id} className={editable(r) ? 'clickable' : undefined} tabIndex={editable(r) ? 0 : undefined}
          onClick={editable(r) ? () => setEdit(r) : undefined} onKeyDown={editable(r) ? e => e.key === 'Enter' && setEdit(r) : undefined}>
          <td className="primary-cell">{monthLabel(r.month)}</td><td className="num small">{r.employees}</td><td className="num small">{inr(r.gross)}</td>
          <td className="num small">{inr(r.deductions)}</td><td className="num small strong">{inr(r.net)}</td>
          <td><div><Badge>{r.status}</Badge></div>{r.completedBy && <div className="sub">{r.completedBy} · {fmtDateTime(r.completedAt)}</div>}</td>
          <td className="small">{r.notes || '—'}</td>
        </tr>)}</tbody></table></div>{list.pager}</>}
    {edit && <PayrollModal run={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
  </div>;
}

function PayrollModal({ run, onClose }: { run: PayrollRun | null; onClose: () => void }) {
  const db = useStore(s => s.db);
  const staff = db.employees.filter(e => e.status !== 'Inactive');
  // New run: the first month without a run, deductions ≈ 5% of gross (sample). Saved runs keep their values.
  const [f, setF] = useState(() => run ? { month: run.month, deductions: run.deductions, notes: run.notes }
    : { month: samplePayrollMonth(db), deductions: Math.round(staff.reduce((a, e) => a + e.monthlySalary, 0) * 0.05), notes: 'PF, ESI and advances (sample figures)' });
  const [err, setErr] = useState('');
  const gross = run?.gross ?? staff.reduce((a, e) => a + e.monthlySalary, 0);
  const s = useStore.getState();
  const save = () => { const r = attempt(() => run ? s.updatePayrollRun(run.id, f) : s.createPayrollRun(f), run ? 'Payroll draft saved' : 'Payroll draft created'); if (r.ok) onClose(); else setErr(r.error); };
  const complete = () => { const r = attempt(() => { s.updatePayrollRun(run!.id, f); s.completePayrollRun(run!.id); }, `Payroll for ${monthLabel(run!.month)} completed`); if (r.ok) onClose(); else setErr(r.error); };
  return <Modal size="sm" title={run ? `Payroll · ${monthLabel(run.month)}` : 'New payroll run'} subtitle="Totals only — no statutory calculations." onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button>{run && <Button variant="success" onClick={complete}>Save & complete</Button>}<Button variant="primary" onClick={save}>{run ? 'Save draft' : 'Create draft'}</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="form-grid">
      <Field label="Month" required htmlFor="pr-m"><Input id="pr-m" type="month" value={f.month} disabled={!!run} onChange={e => setF(p => ({ ...p, month: e.target.value }))} /></Field>
      <Field label="Employees"><div className="small" style={{ paddingTop: 8 }}>{run?.employees ?? staff.length}</div></Field>
      <Field label="Gross"><div className="small" style={{ paddingTop: 8 }}>{inr(gross)}</div></Field>
      <Field label="Deductions (₹)" htmlFor="pr-d"><NumInput id="pr-d" value={f.deductions} onChange={n => setF(p => ({ ...p, deductions: n }))} /></Field>
      <Field label="Net pay" full><div className="strong" style={{ paddingTop: 4 }}>{inr(gross - f.deductions)}</div></Field>
      <Field label="Notes" full htmlFor="pr-n"><Textarea id="pr-n" rows={2} value={f.notes} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} /></Field>
    </div>
  </Modal>;
}
