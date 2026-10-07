import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LayoutDashboard, Users, Briefcase, ShoppingCart, Boxes, Factory, Truck, Wallet, FolderOpen, ChevronRight, Settings2, PanelLeftClose, PanelLeftOpen, IdCard, LogOut, ChevronDown } from 'lucide-react';
import { useStore, currentUser, leadById } from './store';
import { useRoute, nav, routeQuery } from './ui/router';
import { Toasts, Button, useOverflowTitles } from './ui/kit';
import { ensureSampleData, needsSeed } from './seed';
import Dashboard from './pages/Dashboard';
import CRM from './pages/CRM';
import Sales, { isSalesTab } from './pages/Sales';
import Procurement from './pages/Procurement';
import Inventory from './pages/Inventory';
import Manufacturing from './pages/Manufacturing';
import Dispatch from './pages/Dispatch';
import Finance from './pages/Finance';
import Documents from './pages/Documents';
import { Logo } from './ui/logo';
import Settings from './pages/Settings';
import HRMS from './pages/HRMS';
import Login from './pages/Login';
import { useSession, endSession } from './lib/auth';
import type { User } from './lib/types';

/** Module-driven sidebar: CRM (pipeline/accounts boards) gets the full width; every other module opens with the sidebar expanded. */
const autoCollapsed = (page: string) => page === 'crm';

const NAV = [
  { group: 'Overview', items: [{ key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { group: 'Sales', items: [{ key: 'crm', label: 'CRM', icon: Users }, { key: 'sales', label: 'Sales', icon: Briefcase }] },
  { group: 'Operations', items: [
    { key: 'procurement', label: 'Procurement', icon: ShoppingCart }, { key: 'inventory', label: 'Inventory', icon: Boxes },
    { key: 'manufacturing', label: 'Manufacturing', icon: Factory }, { key: 'dispatch', label: 'Dispatch', icon: Truck },
  ] },
  { group: 'Finance & records', items: [{ key: 'finance', label: 'Finance', icon: Wallet }, { key: 'documents', label: 'Documents', icon: FolderOpen }] },
  { group: 'People & admin', items: [{ key: 'hrms', label: 'HRMS', icon: IdCard }, { key: 'settings', label: 'Settings', icon: Settings2 }] },
];
const LABEL: Record<string, string> = Object.fromEntries(NAV.flatMap(g => g.items.map(i => [i.key, i.label])));

/** Gate: sample records first, then the session. Nothing from the workspace renders without a session. */
export default function App() {
  const session = useSession();
  const db = useStore(s => s.db);
  // Sample records are prepared once, before anything renders (see src/seed.ts).
  const [preparing, setPreparing] = useState(() => needsSeed(useStore.getState().db));
  useEffect(() => { if (preparing) ensureSampleData().finally(() => setPreparing(false)); }, [preparing]);
  const known = !!session && db.users.some(u => u.id === session.userId);
  // The signed-in account is the acting user; keep the persisted current user in step with the session.
  const synced = known && db.currentUserId === session!.userId;
  useLayoutEffect(() => {
    if (preparing || !session) return;
    if (!known) endSession();
    else if (!synced) useStore.getState().setUser(session.userId);
  }, [preparing, session, known, synced]);

  if (preparing) return <div className="boot" role="status"><Logo /><span className="muted">Preparing records…</span></div>;
  if (!session || !known) return <><Login /><Toasts /></>;
  if (!synced) return null;
  return <Workspace />;
}

function logout() {
  endSession();
  // Replace (not push) so the page that was open is not the entry Back returns to.
  history.replaceState(null, '', '#/login');
}

function UserMenu({ me }: { me: User }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLButtonElement>('.um-btn')?.focus(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { if (open) ref.current?.querySelector<HTMLButtonElement>('.um-pop button')?.focus(); }, [open]);
  const role = me.role === 'admin' ? 'Admin' : 'User';
  const initials = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return <div className="user-menu" ref={ref}>
    <button className="um-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} title={`Signed in as ${me.name}`}>
      <span className="um-av" aria-hidden>{initials}</span>
      <span className="um-who"><span className="um-name">{me.name}</span><span className="um-role">{role}</span></span>
      <ChevronDown size={14} className="muted" />
    </button>
    {open && <div className="um-pop" role="menu" aria-label="Account">
      <div className="um-head">
        <span className="um-av lg" aria-hidden>{initials}</span>
        <div className="um-id"><div className="um-name">{me.name}</div>
          <div className="um-meta">{role}{me.title ? ` · ${me.title.replace(/^Admin\s*·\s*/, '')}` : ''}</div>
          {me.email && <div className="um-mail">{me.email}</div>}</div>
      </div>
      <button role="menuitem" className="um-item" onClick={logout}><LogOut size={15} />Log out</button>
    </div>}
  </div>;
}

function Workspace() {
  const route = useRoute();
  // Re-mount list pages when a deep link changes the ?q= search, so the new search applies.
  const qKey = routeQuery('q');
  const db = useStore(s => s.db);
  const page = LABEL[route[0]] ? route[0] : 'dashboard';
  const me = currentUser(db);
  // Starts from the route (direct links and refresh), then re-applies whenever the module changes.
  // Switching views inside a module, or re-rendering, never overrides a manual toggle.
  const [collapsed, setCollapsed] = useState(() => autoCollapsed(page));
  const [modulePage, setModulePage] = useState(page);
  if (modulePage !== page) { setModulePage(page); setCollapsed(autoCollapsed(page)); }
  // Each sidebar click on CRM re-enters it fresh (Pipeline · Kanban), even when CRM is already open.
  const [crmEntry, setCrmEntry] = useState(0);
  const openModule = (key: string) => { setCollapsed(autoCollapsed(key)); if (key === 'crm') setCrmEntry(n => n + 1); nav(key); };
  const toggleSidebar = () => setCollapsed(c => !c);
  useOverflowTitles();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => { contentRef.current?.scrollTo(0, 0); }, [page, route[1]]);
  useEffect(() => { document.title = `${LABEL[page]} · SunFrame ERP`; }, [page]);

  const counts: Record<string, number> = {
    procurement: db.prs.filter(p => p.status === 'Pending' && (me.role === 'admin' || p.raisedById === me.id)).length + db.supplierPOs.filter(p => p.status === 'Details required').length,
    manufacturing: db.mos.filter(m => !m.line && !m.fgPosted).length,
    dispatch: db.dispatches.filter(d => d.status === 'Ready').length,
  };

  const crumbLead = page === 'sales' && route[1] && !isSalesTab(route[1]) ? leadById(db, route[1]) : undefined;

  return <div className="app">
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')} aria-label="Main navigation">
      <div className="brand"><Logo /><div><div className="brand-name">SunFrame ERP</div><div className="brand-sub">Solar structures</div></div></div>
      <nav className="nav">
        {NAV.map(g => <div key={g.group}>
          <div className="nav-group">{g.group}</div>
          {g.items.map(i => <button key={i.key} className={'nav-item' + (page === i.key ? ' active' : '')} aria-current={page === i.key ? 'page' : undefined} onClick={() => openModule(i.key)}
            title={collapsed ? i.label : undefined} aria-label={collapsed ? i.label : undefined}>
            <i.icon size={16} strokeWidth={1.8} /><span className="nav-label">{i.label}</span>{counts[i.key] ? <span className="nav-count" aria-label={`${counts[i.key]} need attention`}>{counts[i.key]}</span> : null}
          </button>)}
        </div>)}
      </nav>
      <div className="sidebar-foot"><button onClick={toggleSidebar} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}>
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}<span>Collapse</span></button></div>
    </aside>

    <div className="main">
      <header className="topbar">
        <div className="crumbs">
          <span>SunFrame</span><ChevronRight size={14} />
          {crumbLead ? <><button className="link" onClick={() => nav('sales')}>Sales</button><ChevronRight size={14} /><b>{crumbLead.company}</b></> : <b>{LABEL[page]}</b>}
        </div>
        <div className="topbar-right">
          <Button icon={<Settings2 size={15} />} onClick={() => nav('settings')} title="Company details, users, roles and approval rules">Settings</Button>
          <UserMenu me={me} />
        </div>
      </header>
      <main className="content" ref={contentRef} id="main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'crm' && <CRM key={`${routeQuery('stage')}|${crmEntry}`} tab={route[1]} />}
        {page === 'sales' && <Sales leadId={route[1]} />}
        {page === 'procurement' && <Procurement key={qKey} tab={route[1]} />}
        {page === 'inventory' && <Inventory tab={route[1]} />}
        {page === 'manufacturing' && <Manufacturing key={qKey} tab={route[1]} />}
        {page === 'dispatch' && <Dispatch key={qKey} />}
        {page === 'finance' && <Finance key={qKey} tab={route[1]} />}
        {page === 'documents' && <Documents key={qKey} tab={route[1]} />}
        {page === 'hrms' && <HRMS tab={route[1]} />}
        {page === 'settings' && <Settings tab={route[1]} />}
      </main>
    </div>
    <Toasts />
  </div>;
}
