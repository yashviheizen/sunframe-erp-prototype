import { useRef, useState, type DragEvent } from 'react';
import { Factory, Settings2, PackageOpen, ArrowRight, Check, Plus, Trash2, ArrowUp, ArrowDown, Lock, RefreshCw, Inbox, CalendarDays, ArrowLeftRight, X, GripVertical } from 'lucide-react';
import { useStore, isAdmin, leadById, moMaterialStatus, stageIndex, prsForMO, moOpenShortfall, FIXED_FIRST_STAGE, FIXED_LAST_STAGE } from '../store';
import type { ManufacturingOrder, StageDef, StageGroup } from '../lib/types';
import { qty as fq, fmtDate, fmtDateTime, fmtShort, uid } from '../lib/format';
import { PageHead, Button, Badge, Drawer, Modal, Alert, Input, Select, Empty, KV, SearchBox, Tabs, InfoTip, Cols, useList, attempt, tryToast, toast } from '../ui/kit';
import { nav, routeQuery } from '../ui/router';

type Line = 'Line 1' | 'Line 2';

type MfgTab = 'board' | 'orders' | 'issued';
const MFG_TABS: MfgTab[] = ['board', 'orders', 'issued'];

export default function Manufacturing({ tab }: { tab?: string }) {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  const section: MfgTab = MFG_TABS.includes(tab as MfgTab) ? tab as MfgTab : 'board';
  const [open, setOpen] = useState<string | null>(null);
  const [stages, setStages] = useState(false);
  // A drawer opened on one tab is closed when switching to another.
  const [shownSection, setShownSection] = useState(section);
  if (shownSection !== section) { setShownSection(section); setOpen(null); }
  const openMOs = db.mos.filter(m => !m.fgPosted);
  const head = <>
    <PageHead title="Manufacturing" sub="MOs enter the unassigned queue; an admin assigns a production line, then they move through the stages. The final stage configuration is TBC."
      actions={admin && <Button size="sm" icon={<Settings2 size={14} />} onClick={() => setStages(true)}>Configure stages</Button>} />
    <Tabs value={section} onChange={k => nav(k === 'board' ? 'manufacturing' : `manufacturing/${k}`)} tabs={[
      { key: 'board', label: 'Line board', count: openMOs.length, attention: openMOs.filter(m => !m.line).length, attentionLabel: 'unassigned' },
      { key: 'orders', label: 'Manufacturing orders', count: db.mos.length, attention: openMOs.filter(m => !m.materialsIssued && !moMaterialStatus(db, m).ready).length, attentionLabel: 'short of material' },
      { key: 'issued', label: 'Materials issued', count: db.materialIssues.length },
    ]} />
  </>;
  const overlays = <>{open && <MODrawer id={open} onClose={() => setOpen(null)} />}{stages && <StagesModal onClose={() => setStages(false)} />}</>;
  if (section === 'orders') return <>{head}<MOTable onOpen={setOpen} />{overlays}</>;
  if (section === 'issued') return <>{head}<IssueRegister onOpen={setOpen} />{overlays}</>;
  return <>{head}<Board onOpen={setOpen} />{overlays}</>;
}

/** Whether an MO may be dropped on a lane — mirrors the rules enforced by assignLine. */
function dropCheck(mo: ManufacturingOrder, target: Line | null): { ok: boolean; same: boolean; reason?: string } {
  if (mo.line === target) return { ok: false, same: true };
  if (mo.fgPosted) return { ok: false, same: false, reason: 'Completed orders cannot be reassigned.' };
  if (!target && mo.materialsIssued) return { ok: false, same: false, reason: 'Materials are already issued — this order cannot return to Unassigned.' };
  return { ok: true, same: false };
}

/** Compact drag image: ref, client and where it is coming from. Removed right after the browser snapshots it. */
function dragPreview(e: DragEvent, mo: ManufacturingOrder, company: string) {
  const el = document.createElement('div');
  el.className = 'drag-preview';
  const b = document.createElement('b'); b.textContent = mo.ref;
  const c = document.createElement('span'); c.textContent = company;
  const f = document.createElement('small'); f.textContent = mo.line ? `From ${mo.line}` : 'From Unassigned';
  el.append(b, c, f);
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, 14, 14);
  setTimeout(() => el.remove(), 0);
}

function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const db = useStore(s => s.db);
  const admin = isAdmin(db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const [status, setStatus] = useState('');
  const [line, setLine] = useState('');
  const ql = q.trim().toLowerCase();
  const statusOf = (m: ManufacturingOrder) => m.fgPosted ? 'fg' : m.materialsIssued ? 'prod' : moMaterialStatus(db, m).ready ? 'reserved' : 'short';
  // A searched-for MO is shown even when completed.
  const active = db.mos.filter(m => (status === 'fg' || ql ? true : !m.fgPosted) && (!status || statusOf(m) === status)
    && (!ql || [m.ref, m.productName, leadById(db, m.leadId)?.company, leadById(db, m.leadId)?.project].some(x => x?.toLowerCase().includes(ql))));
  const allLanes: { key: Line | null; title: string; sub: string; cls: string }[] = [
    { key: null, title: 'Unassigned', sub: 'Waiting for line assignment', cls: 'queue' },
    { key: 'Line 1', title: 'Line 1', sub: 'Assigned orders', cls: 'line1' },
    { key: 'Line 2', title: 'Line 2', sub: 'Assigned orders', cls: 'line2' },
  ];
  const lanes = allLanes.filter(l => !line || (line === 'queue' ? l.key === null : l.key === line));
  // Drag-and-drop between lanes (admins only). Every drop goes through the same assignLine action as the buttons.
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const lastDrag = useRef(0);
  const dragMo = dragId ? db.mos.find(m => m.id === dragId) : undefined;
  const laneId = (k: Line | null) => k ?? 'queue';
  const endDrag = () => { setDragId(null); setOver(null); lastDrag.current = Date.now(); };
  const drop = (target: Line | null) => {
    const mo = dragMo; endDrag();
    if (!mo || mo.line === target) return;
    const short = !mo.materialsIssued && !moMaterialStatus(db, mo).ready;
    const msg = target ? `${mo.ref} ${mo.line ? 'moved' : 'assigned'} to ${target}${short && !mo.line ? ' — materials are still short' : ''}` : `${mo.ref} returned to the queue`;
    if (tryToast(() => useStore.getState().assignLine(mo.id, target), msg)) {
      setFlash(mo.id); setTimeout(() => setFlash(f => (f === mo.id ? null : f)), 1600);
    }
  };
  const laneDragOver = (e: DragEvent<HTMLElement>, k: Line | null) => {
    if (!dragMo) return;
    e.preventDefault(); // allow the drop — invalid targets still receive it, so the reason can be shown
    e.dataTransfer.dropEffect = 'move';
    if (over !== laneId(k)) setOver(laneId(k));
    // Auto-scroll the lane's card list when hovering near its top or bottom edge.
    const list = e.currentTarget.querySelector<HTMLElement>('.lane-cards');
    if (list) {
      const r = list.getBoundingClientRect(), edge = 56;
      if (e.clientY < r.top + edge) list.scrollTop -= Math.ceil((r.top + edge - e.clientY) / 4);
      else if (e.clientY > r.bottom - edge) list.scrollTop += Math.ceil((e.clientY - (r.bottom - edge)) / 4);
    }
  };
  return <>
    {db.mos.length > 0 && <div className="card mb12"><div className="toolbar" style={{ borderBottom: 'none' }}>
      <SearchBox value={q} onChange={setQ} placeholder="Search MO, client, product…" />
      <Select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)} style={{ width: 190 }}>
        <option value="">Open MOs (all statuses)</option><option value="short">Short of material</option><option value="reserved">Materials reserved</option>
        <option value="prod">In production</option><option value="fg">Completed (FG ready)</option></Select>
      <Select aria-label="Filter by line" value={line} onChange={e => setLine(e.target.value)} style={{ width: 160 }}>
        <option value="">All lines</option><option value="queue">Unassigned</option><option>Line 1</option><option>Line 2</option></Select>
      <span className="muted small">{active.length} shown</span>
    </div></div>}
    {!db.mos.length ? <div className="card"><Empty icon={<Factory size={20} />} title="No manufacturing orders yet"
      body="An MO is created from a sales record after the SO is generated. It reserves stock and joins the queue here."
      action={<Button onClick={() => nav('sales')}>Go to sales workspace</Button>} /></div>
      : <div className="mfg-board" style={lanes.length < 3 ? { gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` } : undefined}>
        {lanes.map(l => {
          const mos = active.filter(m => m.line === l.key).sort((a, b) => (a.plannedDate || '9').localeCompare(b.plannedDate || '9'));
          const Icon = l.key ? Factory : Inbox;
          const chk = dragMo ? dropCheck(dragMo, l.key) : null;
          const isOver = over === laneId(l.key);
          const dropCls = !chk || chk.same ? '' : chk.ok ? ' drop-ok' + (isOver ? ' drop-over' : '') : ' drop-bad' + (isOver ? ' drop-over' : '');
          return <section key={l.title} className={'lane ' + l.cls + dropCls} aria-label={`${l.title} — ${l.sub}: ${mos.length} MO${mos.length === 1 ? '' : 's'}`}
            onDragOver={e => laneDragOver(e, l.key)} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === laneId(l.key) ? null : o)); }}
            onDrop={e => { if (!dragMo) return; e.preventDefault(); drop(l.key); }}>
            <div className="lane-head">
              <span className="lane-ic" aria-hidden><Icon size={15} /></span>
              <div className="lane-t"><div className="row" style={{ gap: 6 }}><h3>{l.title}</h3><span className="count-pill" aria-label={`${mos.length} orders`}>{mos.length}</span></div>
                <span className="sub">{l.sub}</span></div>
            </div>
            <div className="lane-cards">
              {chk && !chk.same && <div className={'drop-slot' + (chk.ok ? '' : ' bad') + (isOver ? ' on' : '') + (mos.length ? '' : ' tall')} aria-hidden>
                {chk.ok ? (l.key ? `Drop to ${dragMo!.line ? 'move' : 'assign'} to ${l.title}` : 'Drop to return to the queue') : chk.reason}</div>}
              {!mos.length && !(chk && !chk.same) && <div className="board-empty"><Icon size={16} style={{ display: 'block', margin: '0 auto 4px' }} />{l.key ? 'No orders on this line' : 'Nothing waiting'}</div>}
              {mos.map(m => <MOCard key={m.id} mo={m} admin={admin} dragging={dragId === m.id} flash={flash === m.id}
                onOpen={() => { if (Date.now() - lastDrag.current > 300) onOpen(m.id); }}
                onDragStart={() => setTimeout(() => setDragId(m.id), 0)} onDragEnd={endDrag} />)}
            </div>
          </section>;
        })}
      </div>}
  </>;
}

/** One row per MO: the same records as the board, as a searchable table. */
function MOTable({ onOpen }: { onOpen: (id: string) => void }) {
  const db = useStore(s => s.db);
  const [q, setQ] = useState(() => routeQuery('q'));
  const [line, setLine] = useState('');
  const [ready, setReady] = useState('');
  const ql = q.trim().toLowerCase();
  const rows = db.mos.map(m => {
    const lead = leadById(db, m.leadId), so = db.salesOrders.find(s => s.id === m.soId), st = moMaterialStatus(db, m);
    const readiness = m.fgPosted ? 'FG ready' : m.materialsIssued ? 'Issued' : st.ready ? 'Reserved' : 'Short';
    return { m, lead, so, st, readiness, stage: db.stages.find(s => s.id === m.stageId)?.name ?? '' };
  }).filter(r => (!ql || [r.m.ref, r.m.productName, r.lead?.company, r.lead?.project, r.so?.ref].some(x => x?.toLowerCase().includes(ql)))
    && (!line || (line === 'queue' ? !r.m.line : r.m.line === line)) && (!ready || r.readiness === ready))
    .sort((a, b) => Number(a.m.fgPosted) - Number(b.m.fgPosted) || (a.m.plannedDate || '9').localeCompare(b.m.plannedDate || '9'));
  const list = useList(rows, { resetKey: [q, line, ready], sort: { mo: r => r.m.ref, client: r => r.lead?.company, product: r => r.m.productName, qty: r => r.m.qty, planned: r => r.m.plannedDate, line: r => r.m.line, stage: r => r.m.fgPosted ? 999 : r.m.line ? stageIndex(db, r.m.stageId) : -1 } });
  if (!db.mos.length) return <div className="card"><Empty icon={<Factory size={20} />} title="No manufacturing orders yet" body="An MO is created from a sales record after the SO is generated." /></div>;
  return <div className="card list">
    <div className="toolbar">
      <SearchBox value={q} onChange={setQ} placeholder="Search MO, client, SO, product…" />
      <Select aria-label="Filter by line" value={line} onChange={e => setLine(e.target.value)} style={{ width: 150 }}>
        <option value="">All lines</option><option value="queue">Unassigned</option><option>Line 1</option><option>Line 2</option></Select>
      <Select aria-label="Filter by material readiness" value={ready} onChange={e => setReady(e.target.value)} style={{ width: 190 }}>
        <option value="">Any material readiness</option><option value="Short">Short of material</option><option value="Reserved">Fully reserved</option><option value="Issued">Issued to line</option><option value="FG ready">Completed (FG ready)</option></Select>
    </div>
    {rows.length ? <><div className="table-scroll"><table className="tbl fixed">
      <Cols w={[118, undefined, 116, 170, 92, 84, 92, 130, 104]} />
      <thead><tr>{list.th('mo', 'MO')}{list.th('client', 'Client / project')}<th>SO</th>{list.th('product', 'Product')}{list.th('qty', 'Qty', 'num')}{list.th('planned', 'Planned')}{list.th('line', 'Line')}{list.th('stage', 'Stage')}<th>Materials</th></tr></thead>
      <tbody>{list.rows.map(({ m, lead, so, st, readiness, stage }) => <tr key={m.id} className="clickable" tabIndex={0} onClick={() => onOpen(m.id)} onKeyDown={e => e.key === 'Enter' && e.target === e.currentTarget && onOpen(m.id)}>
        <td className="mono strong small">{m.ref}</td>
        <td><div className="primary-cell">{lead?.company}</div>{lead?.project && <div className="sub">{lead.project}</div>}</td>
        <td className="small">{so ? <a className="link mono" href={`#/sales/${m.leadId}?step=so`} onClick={e => e.stopPropagation()}>{so.ref}</a> : '—'}</td>
        <td className="small">{m.productName}</td>
        <td className="num small">{fq(m.qty, m.unit)}</td>
        <td className="small">{fmtShort(m.plannedDate)}</td>
        <td className="small">{m.line ?? <span className="faint">Unassigned</span>}</td>
        <td className="small">{m.fgPosted ? 'FG ready' : m.line ? stage : <span className="faint">Not started</span>}</td>
        <td>{readiness === 'Short' ? <Badge tone="warning">{st.shortCount} short</Badge> : readiness === 'Reserved' ? <Badge tone="success">Reserved</Badge>
          : readiness === 'Issued' ? <Badge tone="info">Issued</Badge> : <Badge tone="success">FG ready</Badge>}</td>
      </tr>)}</tbody>
    </table></div>{list.pager}</> : <Empty icon={<Factory size={20} />} title="No MOs match these filters" body="Try a different search, line or readiness filter." />}
  </div>;
}

/** Issue events as recorded at the time of issue. Nothing is reconstructed for MOs issued before the register existed. */
function IssueRegister({ onOpen }: { onOpen: (id: string) => void }) {
  const db = useStore(s => s.db);
  const [q, setQ] = useState('');
  const [line, setLine] = useState('');
  const ql = q.trim().toLowerCase();
  const rows = db.materialIssues.map(i => ({ i, mo: db.mos.find(m => m.id === i.moId), mat: db.materials.find(m => m.id === i.materialId) }))
    .filter(r => (!line || r.i.line === line) && (!ql || [r.mo?.ref, r.mat?.name, r.mat?.code, r.i.issuedByName, leadById(db, r.mo?.leadId ?? '')?.company].some(x => x?.toLowerCase().includes(ql))))
    .sort((a, b) => b.i.at.localeCompare(a.i.at));
  const list = useList(rows, { resetKey: [q, line], sort: { at: r => r.i.at, mo: r => r.mo?.ref, client: r => leadById(db, r.mo?.leadId ?? '')?.company, line: r => r.i.line, material: r => r.mat?.name, qty: r => r.i.qty, by: r => r.i.issuedByName } });
  const recorded = new Set(db.materialIssues.map(i => i.moId));
  const unrecorded = db.mos.filter(m => m.materialsIssued && !recorded.has(m.id));
  return <>
    <div className="card list">
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search MO, material, client, user…" />
        <Select aria-label="Filter by line" value={line} onChange={e => setLine(e.target.value)} style={{ width: 150 }}>
          <option value="">All lines</option><option>Line 1</option><option>Line 2</option></Select>
        {unrecorded.length > 0 && <span className="muted small row" style={{ gap: 6, marginLeft: 'auto' }}>{unrecorded.length} earlier MO{unrecorded.length === 1 ? '' : 's'} not listed
          <InfoTip text={`${unrecorded.map(m => m.ref).join(', ')} ${unrecorded.length === 1 ? 'was' : 'were'} issued before this register was added. Their issue date and issuing user were not recorded, so they are not listed here.`} /></span>}
      </div>
      {!rows.length ? <Empty icon={<PackageOpen size={20} />} title={db.materialIssues.length ? 'No issues match these filters' : 'No materials issued yet'}
        body="Each time materials are issued against an MO, one line per material is recorded here with the date, line and issuing user." />
        : <><div className="table-scroll"><table className="tbl fixed">
          <Cols w={[160, 118, undefined, 80, 230, 110, 150]} />
          <thead><tr>{list.th('at', 'Issued on')}{list.th('mo', 'MO')}{list.th('client', 'Client')}{list.th('line', 'Line')}{list.th('material', 'Material')}{list.th('qty', 'Qty', 'num')}{list.th('by', 'Issued by')}</tr></thead>
          <tbody>{list.rows.map(({ i, mo, mat }) => <tr key={i.id} className="clickable" tabIndex={0} onClick={() => mo && onOpen(mo.id)} onKeyDown={e => e.key === 'Enter' && mo && onOpen(mo.id)}>
            <td className="small">{fmtDateTime(i.at)}</td>
            <td className="mono strong small">{mo?.ref ?? '—'}</td>
            <td className="small">{leadById(db, mo?.leadId ?? '')?.company ?? '—'}</td>
            <td className="small">{i.line}</td>
            <td><div className="primary-cell">{mat?.name ?? 'Removed material'}</div>{mat?.code && <div className="sub mono">{mat.code}</div>}</td>
            <td className="num small">{fq(i.qty, i.unit)}</td>
            <td className="small">{i.issuedByName}</td>
          </tr>)}</tbody>
        </table></div>{list.pager}</>}
    </div>
  </>;
}

function LineSelect({ mo }: { mo: ManufacturingOrder }) {
  const db = useStore(s => s.db);
  if (!isAdmin(db) || mo.fgPosted) return null;
  return <Select aria-label={`Production line for ${mo.ref}`} value={mo.line ?? ''}
    onClick={e => e.stopPropagation()}
    onChange={e => { const v = (e.target.value || null) as Line | null; tryToast(() => useStore.getState().assignLine(mo.id, v), v ? `${mo.ref} assigned to ${v}` : `${mo.ref} returned to queue`); }}>
    <option value="" disabled={mo.materialsIssued}>Unassigned queue</option><option>Line 1</option><option>Line 2</option>
  </Select>;
}

/** Material readiness, kept separate from assignment: Reserved, Issued or Short (FG ready once complete). */
function Readiness({ mo }: { mo: ManufacturingOrder }) {
  const db = useStore(s => s.db);
  const st = moMaterialStatus(db, mo);
  return mo.fgPosted ? <Badge tone="success">FG ready</Badge> : mo.materialsIssued ? <Badge tone="info">Issued</Badge>
    : st.ready ? <Badge tone="success">Reserved</Badge>
    : <span title={`${st.shortCount} material${st.shortCount === 1 ? '' : 's'} short — raise or chase the PR; assigning a line does not resolve this`}><Badge tone="warning">Short · {st.shortCount}</Badge></span>;
}

/** Board card: ref + readiness, client, product and qty, stage (or "Awaiting assignment"), planned date and the line action. */
function MOCard({ mo, admin, onOpen, dragging, flash, onDragStart, onDragEnd }: { mo: ManufacturingOrder; admin: boolean; onOpen: () => void; dragging?: boolean; flash?: boolean; onDragStart?: () => void; onDragEnd?: () => void }) {
  const db = useStore(s => s.db);
  const [picking, setPicking] = useState(false);
  const lead = leadById(db, mo.leadId);
  const st = moMaterialStatus(db, mo);
  const stage = db.stages.find(s => s.id === mo.stageId);
  const cur = stageIndex(db, mo.stageId);
  const short = !mo.fgPosted && !mo.materialsIssued && !st.ready;
  const assign = (line: Line | null) => {
    setPicking(false);
    tryToast(() => useStore.getState().assignLine(mo.id, line), line ? (mo.line ? `${mo.ref} moved to ${line}` : `${mo.ref} assigned to ${line}`) : `${mo.ref} returned to the queue`);
  };
  const choices: { v: Line | null; label: string }[] = (['Line 1', 'Line 2'] as Line[]).filter(l => l !== mo.line).map(l => ({ v: l, label: l }));
  if (mo.line && !mo.materialsIssued) choices.push({ v: null, label: 'Unassigned' });
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const movable = admin && !mo.fgPosted && !picking && !!onDragStart;
  return <article className={'mo-card' + (short ? ' short' : '') + (movable ? ' movable' : '') + (dragging ? ' dragging' : '') + (flash ? ' flash' : '')} tabIndex={0} role="button"
    aria-label={`Open ${mo.ref}, ${lead?.company ?? ''}`} aria-description={movable ? 'Drag to a lane, or use the line button' : undefined}
    draggable={movable}
    onDragStart={movable ? e => { e.dataTransfer.setData('text/plain', mo.id); e.dataTransfer.effectAllowed = 'move'; dragPreview(e, mo, lead?.company ?? ''); onDragStart!(); } : undefined}
    onDragEnd={movable ? onDragEnd : undefined}
    onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}>
    <div className="top">{movable && <span className="drag-handle" title="Drag to another lane" aria-hidden><GripVertical size={14} /></span>}<span className="mono strong small">{mo.ref}</span><div className="spacer" /><Readiness mo={mo} /></div>
    <div className="co clamp2" title={lead?.company}>{lead?.company}</div>
    <div className="prod"><span title={mo.productName}>{mo.productName}</span><span>{fq(mo.qty, mo.unit)}</span></div>
    <div className="stage">{mo.fgPosted ? <span className="muted">Finished goods ready</span>
      : mo.line ? <><span className="faint nowrap">Stage {cur + 1}/{db.stages.length}</span><b title={stage?.name}>{stage?.name}</b></>
      : <span className="muted">Awaiting assignment</span>}</div>
    <div className="foot">
      <span className="planned" title={mo.plannedDate ? `Planned ${fmtDate(mo.plannedDate)}` : 'No planned date'}><CalendarDays size={12} aria-hidden />{mo.plannedDate ? fmtShort(mo.plannedDate) : '—'}</span>
      <div className="spacer" />
      {mo.fgPosted ? null
        : !admin ? <span className="line-txt">{mo.line ?? 'Awaiting admin'}</span>
        : picking ? null
        : mo.line ? <button className="mo-act" onClick={e => { stop(e); setPicking(true); }} aria-label={`Move ${mo.ref} to another line`}><ArrowLeftRight size={12} />Move line</button>
        : <button className="mo-act assign" onClick={e => { stop(e); setPicking(true); }} aria-label={`Assign ${mo.ref} to a line`}><Factory size={12} />Assign line</button>}
    </div>
    {picking && <div className="line-pick" role="group" aria-label={`Choose a line for ${mo.ref}`} onClick={stop} onKeyDown={e => { stop(e); if (e.key === 'Escape') setPicking(false); }}>
      {choices.map(c => <button key={c.label} className={'lp' + (c.v ? '' : ' q')} onClick={() => assign(c.v)}>{c.label}</button>)}
      <button className="lp x" aria-label="Cancel" onClick={() => setPicking(false)}><X size={13} /></button>
      {short && !mo.line && <div className="lp-note">Materials are still short — assigning a line does not resolve this.</div>}
      {mo.line && <div className="lp-note">Stage and materials stay as they are.</div>}
    </div>}
  </article>;
}

function MODrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useStore(s => s.db);
  const mo = db.mos.find(m => m.id === id);
  const [err, setErr] = useState('');
  if (!mo) return null;
  const lead = leadById(db, mo.leadId);
  const st = moMaterialStatus(db, mo);
  const so = db.salesOrders.find(s => s.id === mo.soId);
  const prs = prsForMO(db, mo.id);
  const open = moOpenShortfall(db, mo);
  const pendingPR = prs.some(p => p.status === 'Pending');
  const cur = stageIndex(db, mo.stageId);
  const next = db.stages[cur + 1];
  const run = (fn: () => void, msg: string) => { setErr(''); const r = attempt(fn, msg); if (!r.ok) setErr(r.error); };
  const s = useStore.getState();
  let footer = null;
  if (!mo.fgPosted) {
    if (!mo.line) footer = <span className="muted small">{isAdmin(db) ? 'Assign a production line to start.' : 'An admin must assign a production line.'}</span>;
    else if (!mo.materialsIssued) footer = <Button variant="primary" icon={<PackageOpen size={15} />} disabled={!st.ready} title={st.ready ? '' : 'All materials must be reserved first'}
      onClick={() => run(() => s.issueMaterials(mo.id), `Materials issued for ${mo.ref}`)}>Issue materials</Button>;
    else footer = <Button variant={next?.id === FIXED_LAST_STAGE ? 'success' : 'primary'} icon={next?.id === FIXED_LAST_STAGE ? <Check size={15} /> : <ArrowRight size={15} />}
      onClick={() => run(() => s.advanceStage(mo.id), next?.id === FIXED_LAST_STAGE ? `${mo.ref} finished · added to FG and dispatch queue` : `${mo.ref} moved to ${next?.name}`)}>
      {next?.id === FIXED_LAST_STAGE ? 'Mark finished goods ready' : `Move to ${next?.name}`}</Button>;
  }
  const groups: StageGroup[] = ['Material issue', 'Production', 'Packaging', 'Finished goods'];
  return <Drawer wide title={mo.ref} subtitle={<span className="row">{lead?.company}<Badge>{mo.line ?? 'Unassigned'}</Badge>{mo.fgPosted && <Badge tone="success">FG ready</Badge>}</span>} onClose={onClose}
    footer={<><div style={{ marginRight: 'auto', width: 170 }}><LineSelect mo={mo} /></div>{footer}</>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    {!mo.materialsIssued && !st.ready && <div className="mb16"><Alert kind="warning">
      {st.shortCount} material(s) are short. Materials can be issued once everything is reserved.
      {open.length > 0 && <div className="mt8"><b>Not covered by any open PR/PO:</b> {open.map(o => `${o.material?.name} ${fq(o.uncovered, o.material?.unit)}`).join(', ')}{prs.some(p => p.status === 'Rejected') ? ' — a PR was rejected.' : ' — the PR was partly approved.'}</div>}
      <div className="mt8 row" style={{ gap: 8 }}><Button size="sm" icon={<RefreshCw size={13} />} onClick={() => { const r = attempt(() => s.allocateMO(mo.id)); if (r.ok) setErr(''); if (r.ok && r.value === 0) setErr('No additional stock is available to reserve yet.'); }}>Re-check stock</Button>
        {open.length > 0 && <Button size="sm" variant="primary" disabled={pendingPR} title={pendingPR ? 'A PR for this MO is still pending' : undefined}
          onClick={() => { const r = attempt(() => s.raiseShortfallPR(mo.id)); if (r.ok) toast(`${r.value.ref} raised for the remaining shortfall`); else setErr(r.error); }}>{prs.some(p => p.status === 'Approved') ? 'Request balance' : 'Raise new PR'}</Button>}</div>
    </Alert></div>}
    <KV items={[['Product', mo.productName], ['Quantity', fq(mo.qty, mo.unit)], ['Planned date', fmtDate(mo.plannedDate)], ['Sales order', so?.ref ?? ''],
      ['Purchase requests', prs.length ? <div className="col" style={{ gap: 2 }}>{prs.map(pr => { const po = db.supplierPOs.find(p => p.id === pr.poId);
        return <span key={pr.id} className="small"><a className="link mono" href={`#/procurement/prs?q=${pr.ref}`} onClick={onClose}>{pr.ref}</a> ({pr.status}){po ? <> → <a className="link mono" href={`#/procurement/pos?q=${po.ref}`} onClick={onClose}>{po.ref}</a> ({po.receiptStatus === 'Received' ? 'Received' : po.status})</> : ''}</span>; })}</div> : ''],
      ...(mo.reconciliation ? [['Qty reconciliation', `BOM ${fq(mo.reconciliation.bomOutput, mo.unit)} → ${fq(mo.qty, mo.unit)} · ${mo.reconciliation.note} (${mo.reconciliation.by})`] as [string, string]] : []),
      ['Sales record', <button className="link" onClick={() => { onClose(); nav(`sales/${mo.leadId}`); }}>Open in sales workspace</button>]]} />
    <div className="section-title mt24">Materials</div>
    <table className="tbl tbl-compact" style={{ border: '1px solid var(--border)' }}>
      <thead><tr><th>Material</th><th className="num">Required</th><th className="num">{mo.materialsIssued ? 'Issued' : 'Reserved'}</th><th className="num">Shortfall</th></tr></thead>
      <tbody>{st.rows.map(r => <tr key={r.materialId}><td>{r.material?.name}</td><td className="num">{fq(r.required, r.material?.unit)}</td>
        <td className="num">{fq(mo.materialsIssued ? r.issued : r.reserved, r.material?.unit)}</td>
        <td className="num" style={{ color: r.shortfall > 0 ? 'var(--danger)' : undefined }}>{r.shortfall > 0 ? fq(r.shortfall, r.material?.unit) : '—'}</td></tr>)}</tbody>
    </table>
    <div className="grid g2 mt24" style={{ alignItems: 'start' }}>
      <div>
        <div className="section-title">Stages</div>
        <div className="stage-list">{groups.map(g => {
          const ss = db.stages.filter(x => x.group === g);
          if (!ss.length) return null;
          return <div key={g}><div className="stage-group-label">{g}</div>{ss.map(x => {
            const i = stageIndex(db, x.id);
            const done = mo.fgPosted || i < cur, current = !mo.fgPosted && i === cur && !!mo.line;
            return <div key={x.id} className={'stage-row' + (done ? ' done' : current ? ' current' : '')}>
              <span className="ic">{done ? <Check size={12} /> : i + 1}</span>{x.name}</div>;
          })}</div>;
        })}</div>
      </div>
      <div>
        <div className="section-title">Log</div>
        <ul className="timeline">{mo.log.map((l, i) => <li key={i}><div><div className="small">{l.text}</div><div className="faint tiny">{fmtDateTime(l.at)}</div></div></li>)}</ul>
      </div>
    </div>
  </Drawer>;
}

function StagesModal({ onClose }: { onClose: () => void }) {
  const db = useStore(s => s.db);
  const [list, setList] = useState<StageDef[]>(db.stages);
  const [err, setErr] = useState('');
  const inUse = new Set(db.mos.filter(m => !m.fgPosted).map(m => m.stageId));
  const mid = list.slice(1, -1);
  const setMid = (m: StageDef[]) => setList([list[0], ...m, list[list.length - 1]]);
  const move = (i: number, d: number) => { const m = [...mid]; const j = i + d; if (j < 0 || j >= m.length) return; [m[i], m[j]] = [m[j], m[i]]; setMid(m); };
  const save = () => { const r = attempt(() => useStore.getState().saveStages(list), 'Production stages saved'); if (r.ok) onClose(); else setErr(r.error); };
  const Fixed = ({ s }: { s: StageDef }) => <div className="row" style={{ padding: '8px 10px', background: 'var(--bg)', borderRadius: 8 }}>
    <Lock size={14} className="faint" /><span className="strong small">{s.name}</span><span className="faint tiny">· fixed {s.id === FIXED_FIRST_STAGE ? 'first' : 'last'} stage</span></div>;
  return <Modal size="lg" title="Configure production stages" subtitle="Rename, reorder, add or remove the middle stages. Material issue and Finished goods ready stay fixed." onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save stages</Button></>}>
    {err && <div className="mb12"><Alert kind="error">{err}</Alert></div>}
    <div className="col" style={{ gap: 6 }}>
      <Fixed s={list[0]} />
      {mid.map((s, i) => <div key={s.id} className="row">
        <span className="faint tiny" style={{ width: 18, textAlign: 'right' }}>{i + 2}</span>
        <Input aria-label={`Stage ${i + 2} name`} value={s.name} onChange={e => setMid(mid.map(x => x.id === s.id ? { ...x, name: e.target.value } : x))} style={{ flex: 1 }} />
        <Select aria-label={`Stage ${i + 2} group`} value={s.group} style={{ width: 150 }} onChange={e => setMid(mid.map(x => x.id === s.id ? { ...x, group: e.target.value as StageGroup } : x))}>
          <option>Production</option><option>Packaging</option></Select>
        <Button size="sm" variant="ghost" iconOnly aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} icon={<ArrowUp size={14} />} />
        <Button size="sm" variant="ghost" iconOnly aria-label="Move down" disabled={i === mid.length - 1} onClick={() => move(i, 1)} icon={<ArrowDown size={14} />} />
        <Button size="sm" variant="ghost" iconOnly aria-label={`Remove ${s.name}`} disabled={inUse.has(s.id) || mid.length <= 1} title={inUse.has(s.id) ? 'An MO is currently at this stage' : ''}
          onClick={() => setMid(mid.filter(x => x.id !== s.id))} icon={<Trash2 size={14} />} />
      </div>)}
      <div><Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setMid([...mid, { id: 'st_' + uid(), name: '', group: 'Production' }])}>Add stage</Button></div>
      <Fixed s={list[list.length - 1]} />
    </div>
  </Modal>;
}
