import { useState } from 'react';
import { Plus, List, Columns3, Users, ArrowRight, Pencil, Trophy, Building2, Eye, CalendarClock } from 'lucide-react';
import { useStore, leadValue, salesStatus, clientPoForLead, quoteForLead, soForLead, receivableBalance, isOpenStage } from '../store';
import type { DB, Lead, LeadStage } from '../lib/types';
import { LEAD_STAGES } from '../lib/types';
import { inr, inrShort, fmtDate, fmtDateTime, fmtShort, todayISO } from '../lib/format';
import { PageHead, Button, Badge, SearchBox, Empty, Drawer, Modal, Field, Input, NumInput, Select, Alert, KV, Tabs, InfoTip, Cols, IconAction, useList, useBoardLayout, initials, attempt, tryToast } from '../ui/kit';
import { nav, routeQuery } from '../ui/router';
import { sampleLead } from '../lib/samples';

const stageLabel = (s: LeadStage) => (s === 'Closed' ? 'Closed (won)' : s);
/** Small colour key per stage, used by the board headers. Lost is a muted red. */
const STAGE_DOT: Record<LeadStage, string> = { New: '#98A2B3', Warm: '#E3A21A', Hot: '#E4683F', 'Quote sent': '#3D7FD9', Negotiation: '#8A63D2', Closed: '#2E9E6A', Lost: '#C27474' };
const stageMsg = (company: string, s: LeadStage) => s === 'Closed' ? `${company} closed as won` : s === 'Lost' ? `${company} marked as lost` : `${company} moved to ${s}`;

type LeadForm = Omit<Lead, 'id' | 'ref' | 'stage' | 'createdAt'>;

function LeadModal({ lead, onClose }: { lead?: Lead; onClose: () => void }) {
  const [f, setF] = useState<LeadForm>(lead ? { company: lead.company, contact: lead.contact, email: lead.email, phone: lead.phone, project: lead.project, estValue: lead.estValue, owner: lead.owner, nextFollowUp: lead.nextFollowUp } : sampleLead(useStore.getState().db));
  const [stage, setStage] = useState<LeadStage>('New');
  const [err, setErr] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState('');
  const set = (k: keyof LeadForm, v: unknown) => setF(p => ({ ...p, [k]: v }));
  const save = () => {
    const e: Record<string, string> = {};
    if (!f.company.trim()) e.company = 'Company is required';
    if (!f.contact.trim()) e.contact = 'Contact name is required';
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) e.email = 'Enter a valid email';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = lead ? attempt(() => useStore.getState().updateLead(lead.id, f), 'Lead updated')
      : attempt(() => useStore.getState().addLead({ ...f, stage }), 'Lead added');
    if (!r.ok) return setFormErr(r.error);
    onClose();
  };
  return <Modal title={lead ? `Edit ${lead.ref}` : 'New lead'} subtitle={lead ? undefined : 'Prefilled with fictional sample values — edit anything. Company and contact are required.'} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{lead ? 'Save changes' : 'Add lead'}</Button></>}>
    {formErr && <div className="mb12"><Alert kind="error">{formErr}</Alert></div>}
    <form className="form-grid" onSubmit={e => { e.preventDefault(); save(); }}>
      <Field label="Company" required error={err.company} htmlFor="l-co"><Input id="l-co" value={f.company} invalid={!!err.company} onChange={e => set('company', e.target.value)} placeholder="e.g. Greenvolt Renewables" /></Field>
      <Field label="Contact person" required error={err.contact} htmlFor="l-ct"><Input id="l-ct" value={f.contact} invalid={!!err.contact} onChange={e => set('contact', e.target.value)} /></Field>
      <Field label="Email" error={err.email} htmlFor="l-em"><Input id="l-em" type="email" value={f.email} invalid={!!err.email} onChange={e => set('email', e.target.value)} /></Field>
      <Field label="Phone" htmlFor="l-ph"><Input id="l-ph" value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
      <Field label="Project / site" full htmlFor="l-pr"><Input id="l-pr" value={f.project} onChange={e => set('project', e.target.value)} placeholder="e.g. 5 MW ground-mount, Anantapur" /></Field>
      <Field label="Estimated value (₹)" htmlFor="l-ev" hint="Used for pipeline value until a quote exists"><NumInput id="l-ev" value={f.estValue} onChange={n => set('estValue', n || null)} /></Field>
      <Field label="Owner" htmlFor="l-ow"><Input id="l-ow" value={f.owner} onChange={e => set('owner', e.target.value)} /></Field>
      <Field label="Next follow-up" htmlFor="l-fu"><Input id="l-fu" type="date" value={f.nextFollowUp} onChange={e => set('nextFollowUp', e.target.value)} /></Field>
      {!lead && <Field label="Stage" htmlFor="l-st"><Select id="l-st" value={stage} onChange={e => setStage(e.target.value as LeadStage)}>
        {LEAD_STAGES.filter(s => s !== 'Closed' && s !== 'Lost' && s !== 'Quote sent').map(s => <option key={s}>{s}</option>)}</Select></Field>}
      <button type="submit" hidden />
    </form>
  </Modal>;
}

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useStore(s => s.db);
  const lead = db.leads.find(l => l.id === id);
  const [edit, setEdit] = useState(false);
  if (!lead) return null;
  const acts = db.activities.filter(a => a.leadId === id).slice(0, 12);
  const locked = !!clientPoForLead(db, id);
  return <Drawer title={lead.company} subtitle={<span className="row"><span className="mono">{lead.ref}</span><Badge>{lead.stage === 'Closed' ? 'Won' : lead.stage}</Badge></span>} onClose={onClose}
    footer={<><Button icon={<Pencil size={14} />} onClick={() => setEdit(true)}>Edit details</Button>
      <Button variant="primary" icon={<ArrowRight size={15} />} onClick={() => nav(`sales/${lead.id}`)}>Open sales workspace</Button></>}>
    <Field label="Stage" htmlFor="d-stage" hint={locked ? 'A Client PO exists, so this deal stays Closed.' : 'Change manually. Marking a quote as sent moves the lead to "Quote sent" automatically.'}>
      <Select id="d-stage" value={lead.stage} disabled={locked} onChange={e => tryToast(() => useStore.getState().setLeadStage(id, e.target.value as LeadStage), e.target.value === 'Closed' ? 'Deal closed as won' : e.target.value === 'Lost' ? 'Deal marked as lost' : 'Stage updated')}>
        {LEAD_STAGES.map(s => <option key={s} value={s}>{stageLabel(s)}</option>)}
      </Select>
    </Field>
    {lead.stage === 'Lost' && <div className="lost-note mt12">Marked as lost — excluded from the open pipeline. Change the stage to reopen it.</div>}
    {lead.stage === 'Closed' && <div className="won-banner mt12"><Trophy size={16} />Deal won — enter the Client PO in the sales workspace.</div>}
    <div className="section-title mt24">Details</div>
    <KV items={[['Contact', lead.contact], ['Email', lead.email], ['Phone', lead.phone], ['Project', lead.project], ['Estimated value', lead.estValue ? inr(lead.estValue) : ''],
      ['Pipeline value', inr(leadValue(db, lead))], ['Owner', lead.owner], ['Next follow-up', lead.nextFollowUp ? fmtDate(lead.nextFollowUp) : ''], ['Sales status', salesStatus(db, lead)], ['Created', fmtDateTime(lead.createdAt)]]} />
    <div className="section-title mt24">Activity</div>
    {acts.length ? <ul className="timeline">{acts.map(a => <li key={a.id}><div><div>{a.text}</div><div className="faint small">{fmtDateTime(a.at)} · {a.userName}</div></div></li>)}</ul>
      : <div className="muted small">No activity yet.</div>}
    {edit && <LeadModal lead={lead} onClose={() => setEdit(false)} />}
  </Drawer>;
}

/* ---------------- Accounts: leads grouped by company (derived — no separate account records) */

/** Normalised company key, so "Tapi Agro Foods Pvt Ltd" and "tapi agro foods pvt. ltd." are one account. */
const companyKey = (c: string) => c.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
const personKey = (n: string) => n.toLowerCase().replace(/\s+/g, ' ').trim();
/** Unique non-blank names in first-seen order (case/spacing-insensitive). */
const uniqueNames = (xs: string[]) => { const seen = new Set<string>(); return xs.filter(x => { const k = personKey(x ?? ''); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

interface Account {
  key: string; company: string; leads: Lead[]; contacts: string[]; owners: string[];
  open: number; won: number; lost: number;
  /** Open stages only (New … Negotiation); Closed (won) and Lost never count. */
  pipeline: number;
  /** Sum of the saved sales-order totals (incl. discount, freight and GST) for this account's projects; null when no SO. */
  soValue: number | null; soCount: number;
  /** Unpaid balance across this account's receivables after recorded receipts; null when it has no receivables. */
  outstanding: number | null;
  last: string;
}
export function accountsOf(db: DB): Account[] {
  const map = new Map<string, Lead[]>();
  for (const l of db.leads) { const k = companyKey(l.company); map.set(k, [...(map.get(k) ?? []), l]); }
  return [...map.entries()].map(([key, leads]) => {
    // Oldest project first: it names the account and gives the primary contact.
    const byAge = [...leads].sort((a, z) => a.createdAt.localeCompare(z.createdAt));
    const ids = new Set(leads.map(l => l.id));
    const sos = db.salesOrders.filter(so => ids.has(so.leadId));
    const recs = db.receivables.filter(r => ids.has(r.leadId));
    const openLeads = leads.filter(l => isOpenStage(l.stage));
    return {
      key, leads: byAge, company: byAge[0].company,
      contacts: uniqueNames(byAge.map(l => l.contact)), owners: uniqueNames(byAge.map(l => l.owner)),
      open: openLeads.length, won: leads.filter(l => l.stage === 'Closed').length, lost: leads.filter(l => l.stage === 'Lost').length,
      pipeline: openLeads.reduce((a, l) => a + leadValue(db, l), 0),
      soValue: sos.length ? sos.reduce((a, so) => a + so.total, 0) : null, soCount: sos.length,
      outstanding: recs.length ? recs.reduce((a, r) => a + receivableBalance(r).outstanding, 0) : null,
      last: leads.reduce((a, l) => (l.createdAt > a ? l.createdAt : a), ''),
    };
  }).sort((a, z) => z.last.localeCompare(a.last));
}

const TIP = {
  pipeline: 'Open pipeline: quote total (or the lead estimate) of projects in New, Warm, Hot, Quote sent or Negotiation. Closed (won) and Lost are excluded. “—” = no open projects.',
  so: 'Sales order value: sum of the saved sales-order totals for this account, including discount, freight and GST. “—” = no sales order yet.',
  outstanding: 'Outstanding: unpaid balance of this account’s receivables after recorded receipts. ₹0 = all paid. “—” = no receivables yet.',
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** "First +N" with every name in the tooltip. */
function FirstPlus({ names, noun }: { names: string[]; noun: string }) {
  if (!names.length) return <span className="faint">—</span>;
  const more = names.length - 1;
  return <span className="first-plus" title={names.join(', ')}>
    <span className="fp-name">{names[0]}</span>
    {more > 0 && <span className="fp-more" aria-label={`and ${plural(more, noun)} more`}>+{more}</span>}</span>;
}
const money = (v: number | null) => v === null ? <span className="faint" aria-label="Not applicable">—</span> : inr(v);

function AccountDrawer({ account, onClose, onLead }: { account: Account; onClose: () => void; onLead: (id: string) => void }) {
  const db = useStore(s => s.db);
  const ids = new Set(account.leads.map(l => l.id));
  const recs = db.receivables.filter(r => ids.has(r.leadId));
  const sos = db.salesOrders.filter(so => ids.has(so.leadId));
  const leadOf = (id: string) => account.leads.find(l => l.id === id);
  // One row per distinct contact, with the projects they are on.
  const contacts = account.contacts.map(name => {
    const ls = account.leads.filter(l => personKey(l.contact) === personKey(name));
    const withPhone = ls.find(l => l.phone), withMail = ls.find(l => l.email);
    return { name, phone: withPhone?.phone, email: withMail?.email, projects: ls.length };
  });
  const breakdown = [account.open && `${account.open} open`, account.won && `${account.won} won`, account.lost && `${account.lost} lost`].filter(Boolean).join(' · ');
  return <Drawer wide title={account.company} subtitle={`${plural(account.leads.length, 'project')}${breakdown ? ` · ${breakdown}` : ''}`} onClose={onClose}>
    <div className="acct-stats">
      <div><span className="label">Open pipeline</span><b>{money(account.open ? account.pipeline : null)}</b><span className="faint tiny">{account.open ? plural(account.open, 'open project') : 'No open projects'}</span></div>
      <div><span className="label">Sales order value</span><b>{money(account.soValue)}</b><span className="faint tiny">{account.soCount ? plural(account.soCount, 'sales order') : 'No sales order yet'}</span></div>
      <div><span className="label">Outstanding</span><b className={account.outstanding ? 'warn-text' : undefined}>{money(account.outstanding)}</b><span className="faint tiny">{recs.length ? plural(recs.length, 'receivable') : 'No receivables yet'}</span></div>
    </div>
    <KV items={[
      ['Contacts', <>{contacts.map((c, i) => <div key={c.name} className="acct-contact">{c.name}{i === 0 && contacts.length > 1 && <span className="faint tiny"> · primary</span>}
        <span className="faint small">{c.phone ? ` · ${c.phone}` : ''}{c.email ? ` · ${c.email}` : ''}{account.leads.length > 1 ? ` · ${plural(c.projects, 'project')}` : ''}</span></div>)}</>],
      ['Owners', account.owners.length ? account.owners.join(', ') : null],
    ]} />
    <div className="section-title mt24">Projects ({account.leads.length})</div>
    <div className="table-wrap"><table className="tbl">
      <thead><tr><th>Project</th><th>Stage</th><th>Owner</th><th>Quote</th><th className="num">Value</th><th><span className="sr-only">Open</span></th></tr></thead>
      <tbody>{account.leads.map(l => { const q = quoteForLead(db, l.id);
        return <tr key={l.id} className="clickable" onClick={() => onLead(l.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && onLead(l.id)}>
          <td><div className="primary-cell">{l.project || '—'}</div><div className="faint small"><span className="mono">{l.ref}</span> · {l.contact}</div></td>
          <td><Badge>{l.stage === 'Closed' ? 'Won' : l.stage}</Badge></td>
          <td className="small">{l.owner || <span className="faint">—</span>}</td>
          <td className="small">{q ? <><span className="mono">{q.ref}</span> <span className="faint">· {q.status}</span></> : <span className="faint">—</span>}</td>
          <td className="num">{inr(leadValue(db, l))}</td>
          <td className="actions"><button className="link small" onClick={e => { e.stopPropagation(); onLead(l.id); }}>Open lead</button></td>
        </tr>; })}</tbody></table></div>
    <div className="section-title mt24">Sales orders ({sos.length})</div>
    {sos.length ? <div className="table-wrap"><table className="tbl">
      <thead><tr><th>Sales order</th><th>Project</th><th>Date</th><th className="num">Total</th><th><span className="sr-only">Open</span></th></tr></thead>
      <tbody>{sos.map(so => { const open = () => nav(`sales/${so.leadId}?step=so`);
        return <tr key={so.id} className="clickable" onClick={open} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open()}>
          <td className="mono small">{so.ref}</td><td className="small">{leadOf(so.leadId)?.project || '—'}</td><td className="small">{fmtDate(so.date)}</td>
          <td className="num">{inr(so.total)}</td><td className="actions"><button className="link small" onClick={e => { e.stopPropagation(); open(); }}>Open SO</button></td></tr>; })}</tbody></table></div>
      : <p className="faint small">No sales order yet.</p>}
    <div className="section-title mt24">Receivables ({recs.length})</div>
    {recs.length ? <div className="table-wrap"><table className="tbl"><thead><tr><th>Ref</th><th>Due</th><th className="num">Amount</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
      <tbody>{recs.map(r => { const b = receivableBalance(r); const open = () => nav(`finance/receivables?q=${encodeURIComponent(r.ref)}`);
        return <tr key={r.id} className="clickable" onClick={open} tabIndex={0} onKeyDown={e => e.key === 'Enter' && open()}>
          <td className="mono small">{r.ref}</td><td>{fmtDate(r.dueDate)}</td><td className="num">{inr(r.amount)}</td><td className="num">{inr(b.outstanding)}</td><td><Badge>{b.status}</Badge></td></tr>; })}</tbody></table></div>
      : <p className="faint small">No receivables yet — they are created when goods are dispatched.</p>}
  </Drawer>;
}

function Accounts({ onLead }: { onLead: (id: string) => void }) {
  const db = useStore(s => s.db);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const all = accountsOf(db);
  const ql = q.toLowerCase();
  const filtered = all.filter(a => !ql || [a.company, ...a.contacts, ...a.owners, ...a.leads.map(l => l.project)].some(x => x?.toLowerCase().includes(ql)));
  const list = useList(filtered, { resetKey: [q], sort: { company: a => a.company, contact: a => a.contacts[0], projects: a => a.leads.length, owner: a => a.owners[0], pipeline: a => a.open ? a.pipeline : null, so: a => a.soValue, outstanding: a => a.outstanding } });
  const acc = all.find(a => a.key === open);
  return <div className="card list">
    <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search company, contact, project, owner…" />
      <InfoTip text="Accounts group leads by company name — there are no separate account records to maintain." /></div>
    {filtered.length ? <><div className="table-scroll"><table className="tbl fixed accounts-tbl">
      <Cols w={[undefined, 184, 100, 150, 140, 172, 140]} />
      <thead><tr>{list.th('company', 'Company')}{list.th('contact', 'Contact')}{list.th('projects', 'Projects')}{list.th('owner', 'Owner')}
        {list.th('pipeline', 'Open pipeline', 'num', TIP.pipeline)}{list.th('so', 'Sales order value', 'num', TIP.so)}{list.th('outstanding', 'Outstanding', 'num', TIP.outstanding)}</tr></thead>
      <tbody>{list.rows.map(a => <tr key={a.key} className="clickable" onClick={() => setOpen(a.key)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && setOpen(a.key)}
        aria-label={`${a.company}: open account details`}>
        <td><div className="primary-cell ellipsis" title={a.company}>{a.company}</div></td>
        <td className="small"><FirstPlus names={a.contacts} noun="contact" /></td>
        <td className="small" title={[a.open && `${a.open} open`, a.won && `${a.won} won`, a.lost && `${a.lost} lost`].filter(Boolean).join(' · ')}>{plural(a.leads.length, 'project')}</td>
        <td className="small"><FirstPlus names={a.owners} noun="owner" /></td>
        <td className="num">{money(a.open ? a.pipeline : null)}</td>
        <td className="num">{money(a.soValue)}</td>
        <td className="num">{money(a.outstanding)}</td>
      </tr>)}</tbody></table></div>{list.pager}</>
      : <Empty icon={<Building2 size={20} />} title={all.length ? 'No matching accounts' : 'No accounts yet'} body={all.length ? 'Try a different search.' : 'Accounts appear as soon as a lead is added.'} />}
    {acc && <AccountDrawer account={acc} onClose={() => setOpen(null)} onLead={id => { setOpen(null); onLead(id); }} />}
  </div>;
}

const stageOrder = (s: LeadStage) => LEAD_STAGES.indexOf(s);

/** Kanban card: company → project → value → owner initials and follow-up. Full details are in the tooltip and the drawer. */
function DealCard({ lead, value, today, onOpen }: { lead: Lead; value: number; today: string; onOpen: () => void }) {
  const late = !!lead.nextFollowUp && lead.nextFollowUp < today && isOpenStage(lead.stage);
  const tip = [lead.company, lead.project, inr(value), lead.owner && `Owner: ${lead.owner}`, lead.nextFollowUp && `Follow-up: ${fmtDate(lead.nextFollowUp)}${late ? ' (overdue)' : ''}`].filter(Boolean).join('\n');
  return <button className={'deal-card' + (lead.stage === 'Lost' ? ' lost' : '')} draggable title={tip} onDragStart={e => { e.dataTransfer.setData('text/plain', lead.id); e.dataTransfer.effectAllowed = 'move'; }} onClick={onOpen}>
    <span className="co clamp2">{lead.company}</span>
    {(lead.project || lead.contact) && <span className="proj clamp2">{lead.project || lead.contact}</span>}
    <span className="val">{inr(value)}</span>
    <span className="card-foot">
      <span className={'avatar' + (lead.owner ? '' : ' none')} aria-label={lead.owner ? `Owner ${lead.owner}` : 'No owner'}>{initials(lead.owner) || '?'}</span>
      {lead.owner && <span className="owner">{lead.owner.split(' ')[0]}</span>}
      {lead.nextFollowUp ? <span className={'due' + (late ? ' late' : '')} aria-label={`Follow-up ${fmtDate(lead.nextFollowUp)}${late ? ', overdue' : ''}`}><CalendarClock size={12} />{fmtShort(lead.nextFollowUp)}</span>
        : <span className="due faint">No follow-up</span>}
    </span>
  </button>;
}

export default function CRM({ tab }: { tab?: string }) {
  const db = useStore(s => s.db);
  const section: 'pipeline' | 'accounts' = tab === 'accounts' ? 'accounts' : 'pipeline';
  const [view, setView] = useState<'list' | 'board'>(() => (localStorage.getItem('crm-view') as 'list' | 'board') || 'list');
  const [q, setQ] = useState('');
  const [stageF, setStageF] = useState(() => { const s = routeQuery('stage'); return s === 'open' || (LEAD_STAGES as readonly string[]).includes(s) ? s : ''; });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<LeadStage | null>(null);
  const setV = (v: 'list' | 'board') => { setView(v); try { localStorage.setItem('crm-view', v); } catch { /* ignore */ } };

  const ql = q.toLowerCase();
  const leads = db.leads.filter(l => (!stageF || (stageF === 'open' ? isOpenStage(l.stage) : l.stage === stageF)) &&
    (!ql || [l.company, l.contact, l.project, l.ref, l.owner].some(x => x?.toLowerCase().includes(ql))));
  const today = todayISO();
  const editLead = editing ? db.leads.find(l => l.id === editing) : undefined;

  const drop = (stage: LeadStage, leadId: string) => {
    setDragOver(null);
    const l = db.leads.find(x => x.id === leadId);
    if (!l || l.stage === stage) return;
    tryToast(() => useStore.getState().setLeadStage(leadId, stage), stageMsg(l.company, stage));
  };

  const list = useList(leads, { resetKey: [q, stageF], sort: { company: l => l.company, contact: l => l.contact, stage: l => stageOrder(l.stage), value: l => leadValue(db, l), owner: l => l.owner, followUp: l => l.nextFollowUp } });
  const boardShown = section === 'pipeline' && view === 'board' && db.leads.length > 0;
  useBoardLayout(boardShown);
  const overdue = (l: Lead) => !!l.nextFollowUp && l.nextFollowUp < today && isOpenStage(l.stage);

  return <>
    <PageHead title="CRM" sub="Leads and deal pipeline. Closed means won; Lost deals are kept for reference." actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>New lead</Button>} />
    <Tabs value={section} onChange={k => nav(k === 'pipeline' ? 'crm' : 'crm/accounts')} tabs={[
      { key: 'pipeline', label: 'Pipeline', count: db.leads.length, attention: db.leads.filter(overdue).length, attentionLabel: 'follow-up overdue' },
      { key: 'accounts', label: 'Accounts', count: accountsOf(db).length },
    ]} />
    {section === 'accounts' ? <Accounts onLead={setOpen} /> : <div className={'card ' + (boardShown ? 'board-card' : 'list')}>
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search company, contact, project…" />
        <Select aria-label="Filter by stage" value={stageF} onChange={e => setStageF(e.target.value)} style={{ width: 160 }}>
          <option value="">All stages</option><option value="open">Open pipeline</option>{LEAD_STAGES.map(s => <option key={s} value={s}>{stageLabel(s)}</option>)}
        </Select>
        {boardShown && <InfoTip text="Drag a card to another column to change its stage, or open the card and use the stage selector." />}
        <div className="spacer" />
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'list'} onClick={() => setV('list')}><List size={15} />List</button>
          <button aria-pressed={view === 'board'} onClick={() => setV('board')}><Columns3 size={15} />Pipeline</button>
        </div>
      </div>
      {!db.leads.length ? <Empty icon={<Users size={20} />} title="No leads yet" body="Add your first lead to start the sales flow: BOM → Quote → Client PO → SO → MO."
        action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>New lead</Button>} />
        : view === 'list' ? (leads.length ? <><div className="table-scroll"><table className="tbl fixed">
          <Cols w={[undefined, 170, 116, 124, 132, 104, 76]} />
          <thead><tr>{list.th('company', 'Company / project')}{list.th('contact', 'Contact')}{list.th('stage', 'Stage')}{list.th('value', 'Value', 'num')}{list.th('owner', 'Owner')}{list.th('followUp', 'Follow-up')}<th className="right">Action</th></tr></thead>
          <tbody>{list.rows.map(l => <tr key={l.id} className="clickable" onClick={() => setOpen(l.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && e.target === e.currentTarget && setOpen(l.id)}>
            <td><div className="primary-cell">{l.company}</div><div className="sub">{l.project || <span className="faint">No project yet</span>}</div></td>
            <td>{l.contact || <span className="faint">—</span>}</td>
            <td><Badge>{l.stage === 'Closed' ? 'Won' : l.stage}</Badge></td>
            <td className={'num' + (l.stage === 'Lost' ? ' muted' : '')}>{inr(leadValue(db, l))}</td>
            <td className="muted">{l.owner || '—'}</td>
            <td className={overdue(l) ? 'strong' : 'muted'} style={overdue(l) ? { color: 'var(--danger)' } : undefined} title={l.nextFollowUp ? `${fmtDate(l.nextFollowUp)}${overdue(l) ? ' · overdue' : ''}` : undefined}>{fmtShort(l.nextFollowUp)}</td>
            <td className="actions"><div className="row">
              <IconAction label={`View ${l.company}`} icon={<Eye size={15} />} onClick={() => setOpen(l.id)} />
              <IconAction label={`Edit ${l.company}`} icon={<Pencil size={14} />} onClick={() => setEditing(l.id)} />
            </div></td>
          </tr>)}</tbody></table></div>{list.pager}</>
          : <Empty icon={<Users size={20} />} title="No matching leads" body="Try a different search or stage filter." />)
        : <div className="board" role="list" aria-label="Pipeline by stage">
          {LEAD_STAGES.map(s => {
            const col = leads.filter(l => l.stage === s);
            const val = col.reduce((a, l) => a + leadValue(db, l), 0);
            return <section key={s} role="listitem" aria-label={`${stageLabel(s)}: ${col.length} deals`} className={'board-col' + (dragOver === s ? ' drop' : '')}
              onDragOver={e => { e.preventDefault(); if (dragOver !== s) setDragOver(s); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
              onDrop={e => drop(s, e.dataTransfer.getData('text/plain'))}>
              <div className="board-col-head"><div className="t"><i className="dot" style={{ background: STAGE_DOT[s] }} aria-hidden /><b>{stageLabel(s)}</b><span className="count-pill">{col.length}</span></div><span className="v" title={isOpenStage(s) ? 'Total deal value' : 'Not counted in the open pipeline'}>{inrShort(val)}{!isOpenStage(s) && <span className="faint"> · not in pipeline</span>}</span></div>
              <div className="board-cards">
                {col.map(l => <DealCard key={l.id} lead={l} value={leadValue(db, l)} today={today} onOpen={() => setOpen(l.id)} />)}
                {!col.length && <div className="board-empty">Drop a deal here</div>}
              </div>
            </section>;
          })}
        </div>}
    </div>}
    {open && <LeadDrawer id={open} onClose={() => setOpen(null)} />}
    {adding && <LeadModal onClose={() => setAdding(false)} />}
    {editLead && <LeadModal lead={editLead} onClose={() => setEditing(null)} />}
  </>;
}

export { LeadModal };
