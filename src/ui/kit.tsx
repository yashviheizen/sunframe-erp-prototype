import { Fragment, useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X, Search, AlertCircle, Info, CheckCircle2, AlertTriangle, Paperclip, Upload, FileText, ExternalLink, Download, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';
import type { FileMeta } from '../lib/types';
import { openFile, downloadFile } from '../lib/files';
import { fileSize } from '../lib/format';
import { isSampleFile } from '../lib/sampleTag';

/* ---------------- Toasts */
interface ToastS { items: { id: number; text: string; error?: boolean }[]; push: (t: string, error?: boolean) => void }
export const useToasts = create<ToastS>((set) => ({
  items: [],
  push: (text, error) => {
    const id = Date.now() + Math.random();
    set(s => ({ items: [...s.items.slice(-2), { id, text, error }] }));
    setTimeout(() => set(s => ({ items: s.items.filter(i => i.id !== id) })), 3600);
  },
}));
export const toast = (t: string) => useToasts.getState().push(t);
export const toastError = (t: string) => useToasts.getState().push(t, true);
export function Toasts() {
  const items = useToasts(s => s.items);
  return <div className="toasts" role="status" aria-live="polite">{items.map(i =>
    <div key={i.id} className={'toast' + (i.error ? ' error' : '')}>{i.error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}{i.text}</div>)}</div>;
}

/** Run a store action; on error return the message (for inline display) and optionally toast. */
export function attempt<T>(fn: () => T, okMsg?: string): { ok: true; value: T } | { ok: false; error: string } {
  try { const value = fn(); if (okMsg) toast(okMsg); return { ok: true, value }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
export function tryToast(fn: () => unknown, okMsg?: string) {
  const r = attempt(fn, okMsg);
  if (!r.ok) toastError(r.error);
  return r.ok;
}

/* ---------------- Buttons */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'; size?: 'sm' | 'md'; icon?: ReactNode; iconOnly?: boolean };
export function Button({ variant = 'secondary', size = 'md', icon, iconOnly, className = '', children, type = 'button', ...rest }: BtnProps) {
  return <button type={type} className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${iconOnly ? 'btn-icon' : ''} ${className}`} {...rest}>{icon}{children}</button>;
}

/* ---------------- Badges */
const TONES: Record<string, string> = {
  New: 'neutral', Warm: 'warning', Hot: 'danger', 'Quote sent': 'info', Negotiation: 'accent', Closed: 'success', Won: 'success', Lost: 'lost',
  Draft: 'neutral', Pending: 'warning', Approved: 'success', Rejected: 'danger', 'Details required': 'warning',
  'Not received': 'neutral', Received: 'success', Reserved: 'info', Issued: 'success',
  Ready: 'info', 'Ready to dispatch': 'info', Dispatched: 'success', 'POD pending': 'warning', 'POD received': 'success',
  'Partially paid': 'warning', Paid: 'success', Overdue: 'danger', Active: 'success', Inactive: 'neutral',
  Short: 'danger', 'Fully reserved': 'success', 'Materials issued': 'success', Unassigned: 'neutral',
  Manual: 'neutral', 'Material shortfall': 'accent', Generated: 'info', Upload: 'neutral', Completed: 'success',
  'On notice': 'warning', Valid: 'success', 'Expiring soon': 'warning', Expired: 'danger', 'No expiry': 'neutral', Admin: 'accent', User: 'neutral',
};
export function Badge({ children, tone, plain }: { children: ReactNode; tone?: string; plain?: boolean }) {
  const t = tone ?? TONES[String(children)] ?? 'neutral';
  return <span className={`badge t-${t} ${plain ? 'plain' : ''}`}>{children}</span>;
}

/* ---------------- Overlays */
// Only the top-most overlay reacts to Escape, so closing a nested modal keeps its parent (and its unsaved form) open.
const escStack: symbol[] = [];
function useEscape(onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    const me = Symbol('overlay');
    escStack.push(me);
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && escStack[escStack.length - 1] === me) cb.current(); };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); const k = escStack.indexOf(me); if (k >= 0) escStack.splice(k, 1); };
  }, []);
}
function useInitialFocus(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=file]):not(:disabled), select, textarea, button:not(.close-x)');
    (el ?? ref.current)?.focus();
    return () => prev?.focus?.();
  }, [ref]);
}
function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Tab') return;
  const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'));
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function Drawer({ title, subtitle, onClose, children, footer, wide }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const id = useId();
  useEscape(onClose); useInitialFocus(ref);
  return createPortal(<>
    <div className="overlay" onClick={onClose} />
    <div ref={ref} className={'drawer' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onKeyDown={trapTab}>
      <div className="drawer-head">
        <div style={{ flex: 1, minWidth: 0 }}><h2 id={id}>{title}</h2>{subtitle && <div className="muted small mt8" style={{ marginTop: 3 }}>{subtitle}</div>}</div>
        <Button variant="ghost" iconOnly size="sm" className="close-x" aria-label="Close" onClick={onClose} icon={<X size={18} />} />
      </div>
      <div className="drawer-body">{children}</div>
      {footer && <div className="drawer-foot">{footer}</div>}
    </div>
  </>, document.body);
}

export function Modal({ title, subtitle, onClose, children, footer, size }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'lg' }) {
  const ref = useRef<HTMLDivElement>(null); const id = useId();
  useEscape(onClose); useInitialFocus(ref);
  return createPortal(<>
    <div className="overlay" onClick={onClose} />
    <div ref={ref} className={'modal ' + (size ?? '')} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} onKeyDown={trapTab}>
      <div className="modal-head">
        <div style={{ flex: 1 }}><h2 id={id}>{title}</h2>{subtitle && <div className="muted small" style={{ marginTop: 3 }}>{subtitle}</div>}</div>
        <Button variant="ghost" iconOnly size="sm" className="close-x" aria-label="Close" onClick={onClose} icon={<X size={18} />} />
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </>, document.body);
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Modal size="sm" title={title} onClose={onClose} footer={<>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
  </>}><div className="muted">{body}</div></Modal>;
}

/* ---------------- Form controls */
export function Field({ label, required, error, hint, children, full, htmlFor }: { label: string; required?: boolean; error?: string; hint?: ReactNode; children: ReactNode; full?: boolean; htmlFor?: string }) {
  return <div className={'field' + (full ? ' full' : '')}>
    <label htmlFor={htmlFor}>{label}{required && <span className="req" aria-hidden>*</span>}</label>
    {children}
    {error ? <span className="err-text" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
  </div>;
}
export function Input(p: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className = '', ...rest } = p;
  return <input className={'input ' + className} aria-invalid={invalid || undefined} {...rest} />;
}
/** `blankZero`: a zero value shows as an empty field (for amounts the user still has to enter). */
export function NumInput({ value, onChange, blankZero, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | null | undefined; onChange: (n: number) => void; invalid?: boolean; blankZero?: boolean }) {
  const [txt, setTxt] = useState(value === null || value === undefined || Number.isNaN(value) || value === 0 ? (value === 0 && !blankZero ? '0' : '') : String(value));
  useEffect(() => { if ((parseFloat(txt) || 0) !== (value ?? 0)) setTxt(value ? String(value) : ''); }, [value]); // eslint-disable-line
  return <Input inputMode="decimal" value={txt} onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); setTxt(v); onChange(parseFloat(v) || 0); }} {...rest} />;
}
export function Select({ invalid, className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return <select className={'select ' + className} aria-invalid={invalid || undefined} {...rest}>{children}</select>;
}
export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={'textarea ' + className} {...rest} />;
}
export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string }) {
  return <div className="search"><Search size={15} /><input aria-label={label ?? placeholder} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></div>;
}

/** File picker that holds a File in local state; caller stores it on submit. */
/**
 * File chooser. `sample` (demo prefill) offers a generated, clearly fictional PDF: it is held in form state like a
 * chosen file and only stored when the form is saved. A sample is labelled as such and can be previewed or replaced.
 */
export function FilePick({ file, onChange, accept, label = 'Choose file', existing, sample }: { file: File | null; onChange: (f: File | null) => void; accept?: string; label?: string; existing?: FileMeta; sample?: () => File }) {
  const ref = useRef<HTMLInputElement>(null);
  const isSample = isSampleFile(file);
  const preview = () => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return <div className="file-drop">
    <Paperclip size={16} className="faint" />
    <div style={{ flex: 1, minWidth: 0 }}>
      {file ? <div className="name">{file.name} <span className="faint small">· {fileSize(file.size)}</span>
          {isSample && <span className="badge t-warning plain sample-file" style={{ marginLeft: 6 }} title="Generated fictional sample — replace it with the real document when you have one">Sample · fictional</span>}</div>
        : existing ? <div className="name">{existing.name} <span className="faint small">· attached</span></div>
        : <span className="muted small">No file selected</span>}
    </div>
    <input ref={ref} type="file" className="sr-only" accept={accept} aria-label={label} tabIndex={-1} onChange={e => onChange(e.target.files?.[0] ?? null)} />
    {isSample && <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={preview} title="Open the sample file in a new tab">Preview</Button>}
    {file && <Button size="sm" variant="ghost" onClick={() => { onChange(null); if (ref.current) ref.current.value = ''; }}>Remove</Button>}
    {!file && !existing && sample && <Button size="sm" variant="ghost" onClick={() => onChange(sample())} title="Attach a generated, clearly marked fictional sample file">Use sample file</Button>}
    <Button size="sm" icon={<Upload size={14} />} onClick={() => ref.current?.click()}>{file || existing ? 'Replace' : label}</Button>
  </div>;
}

export function FileLink({ meta, compact }: { meta: FileMeta; compact?: boolean }) {
  const open = () => openFile(meta).catch(e => toastError(e.message));
  const dl = () => downloadFile(meta).catch(e => toastError(e.message));
  return <span className="row" style={{ gap: 4, minWidth: 0 }}>
    <FileText size={14} className="faint" style={{ flex: 'none' }} />
    <button className="link small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: compact ? 160 : 260 }} onClick={open} title={`Open ${meta.name}`}>{meta.name}</button>
    <Button size="sm" variant="ghost" iconOnly aria-label={`Open ${meta.name} in new tab`} onClick={open} icon={<ExternalLink size={13} />} />
    <Button size="sm" variant="ghost" iconOnly aria-label={`Download ${meta.name}`} onClick={dl} icon={<Download size={13} />} />
  </span>;
}

/* ---------------- Misc */
export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  const Icon = kind === 'error' ? AlertCircle : kind === 'warning' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : undefined}><Icon size={16} /><div>{children}</div></div>;
}
export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="icon">{icon}</div><h3>{title}</h3>{body && <p>{body}</p>}{action && <div className="mt8">{action}</div>}</div>;
}
/** Tab strip. `count` is the total number of records; `attention` (with its `attentionLabel`) is shown separately. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number; attention?: number; attentionLabel?: string }[]; value: T; onChange: (k: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(t =>
    <button key={t.key} role="tab" className="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
      {t.label}{t.count !== undefined && <span className="count" title={`${t.count} total`} aria-label={`${t.count} total`}>{t.count}</span>}
      {!!t.attention && <span className="count attn" title={`${t.attention} ${t.attentionLabel ?? 'need attention'}`}>{t.attention} {t.attentionLabel ?? 'open'}</span>}
    </button>)}</div>;
}
/** Small info icon with a native tooltip — used instead of repeated explanatory paragraphs. */
export function InfoTip({ text }: { text: string }) {
  return <span className="info-tip" title={text} aria-label={text} role="img" tabIndex={0}><Info size={14} /></span>;
}
export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return <div className="page-head"><div className="row" style={{ gap: 6 }}><h1>{title}</h1>{sub && <InfoTip text={sub} />}</div>{actions && <div className="page-actions">{actions}</div>}</div>;
}
export function KV({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v || v === 0 ? v : <span className="faint">—</span>}</dd></Fragment>)}</dl>;
}

/* ---------------- List tables: column sizing, sorting, pagination */

/** Explicit column widths for a fixed-layout table. `undefined` takes the remaining width. */
export function Cols({ w }: { w: (number | string | undefined)[] }) {
  return <colgroup>{w.map((x, i) => <col key={i} style={x === undefined ? undefined : { width: x }} />)}</colgroup>;
}

type SortVal = string | number | null | undefined;
export const PAGE_SIZES = [10, 20, 50];

/**
 * Sorting + pagination for a list table. Rows keep their incoming order until a header is clicked.
 * The page resets to 1 whenever `resetKey` (search/filter values) or the sort changes.
 */
export function useList<T>(rows: T[], { sort: getters = {}, resetKey = [] }: { sort?: Record<string, (r: T) => SortVal>; resetKey?: unknown[] } = {}) {
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(PAGE_SIZES[0]);
  const rk = JSON.stringify([resetKey, sort]);
  const [prevRk, setPrevRk] = useState(rk);
  if (prevRk !== rk) { setPrevRk(rk); setPage(0); }
  let sorted = rows;
  const get = sort ? getters[sort.k] : undefined;
  if (sort && get) {
    sorted = rows.map((r, i) => ({ r, i, v: get(r) })).sort((a, b) => {
      const av = a.v, bv = b.v;
      const ae = av === null || av === undefined || av === '', be = bv === null || bv === undefined || bv === '';
      if (ae !== be) return ae ? 1 : -1; // blanks last in either direction
      const c = ae ? 0 : typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'en', { numeric: true, sensitivity: 'base' });
      return c * sort.dir || a.i - b.i;
    }).map(x => x.r);
  }
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const cur = Math.min(page, pages - 1);
  const pageRows = sorted.slice(cur * size, cur * size + size);
  /** Sortable header cell. */
  const th = (k: string, label: ReactNode, className?: string, tip?: string) => {
    const on = sort?.k === k;
    const Icon = !on ? ChevronsUpDown : sort!.dir === 1 ? ArrowUp : ArrowDown;
    return <th key={k} className={className} aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sort" onClick={() => setSort(on ? (sort!.dir === 1 ? { k, dir: -1 } : null) : { k, dir: 1 })}
        title={on ? (sort!.dir === 1 ? 'Sorted ascending — click for descending' : 'Sorted descending — click to clear') : 'Sort'}>
        {label}<Icon size={12} style={{ opacity: on ? 1 : .45, flex: 'none' }} aria-hidden /></button>{tip && <span className="th-tip"><InfoTip text={tip} /></span>}</th>;
  };
  const pager = <Pager total={sorted.length} page={cur} size={size} onPage={setPage} onSize={n => { setSize(n); setPage(0); }} />;
  return { rows: pageRows, th, pager, total: sorted.length };
}

export function Pager({ total, page, size, onPage, onSize }: { total: number; page: number; size: number; onPage: (p: number) => void; onSize: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? page * size + 1 : 0, to = Math.min(total, (page + 1) * size);
  return <div className="pager" role="navigation" aria-label="Pagination">
    <span className="range" aria-live="polite"><b>{from}–{to}</b> of <b>{total}</b></span>
    <label>Rows per page<select value={size} onChange={e => onSize(Number(e.target.value))} aria-label="Rows per page">{PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    <span className="pg">
      <Button size="sm" variant="ghost" iconOnly aria-label="Previous page" title="Previous page" disabled={page <= 0} onClick={() => onPage(page - 1)} icon={<ChevronLeft size={15} />} />
      <span>Page {page + 1} of {pages}</span>
      <Button size="sm" variant="ghost" iconOnly aria-label="Next page" title="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} icon={<ChevronRight size={15} />} />
    </span>
  </div>;
}

/** Icon-only row action with an accessible name and tooltip. Stops the row's own click handler. */
export function IconAction({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <Button size="sm" variant="ghost" iconOnly aria-label={label} title={label} disabled={disabled} icon={icon}
    onClick={e => { e.stopPropagation(); onClick(); }} onKeyDown={e => e.stopPropagation()} />;
}

/** "Priya Raman" → "PR". */
export const initials = (name?: string) => (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/**
 * Truncated text gets its full value as a tooltip on hover/focus, so ellipsised table cells
 * and clamped card lines stay readable without widening the layout.
 */
export function useOverflowTitles() {
  useEffect(() => {
    const h = (e: Event) => {
      let el = e.target as HTMLElement | null;
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        if (el.hasAttribute('title') || el.dataset.autoTitle === '0') return;
        if (el.matches('td, td > *, .clamp2, .deal-card *, .mo-card *, .lane-head .sub') && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
          const t = el.innerText.trim().replace(/\s*\n\s*/g, ' · ');
          if (t) el.setAttribute('title', t);
          return;
        }
      }
    };
    document.addEventListener('mouseover', h);
    document.addEventListener('focusin', h);
    return () => { document.removeEventListener('mouseover', h); document.removeEventListener('focusin', h); };
  }, []);
}

/* ---------------- Board views ask for room: below 1366px the sidebar collapses while one is shown. */
export const useLayout = create<{ boards: number; add: (d: number) => void }>((set) => ({ boards: 0, add: d => set(s => ({ boards: s.boards + d })) }));
export function useBoardLayout(active = true) {
  useEffect(() => {
    if (!active) return;
    useLayout.getState().add(1);
    return () => useLayout.getState().add(-1);
  }, [active]);
}
export function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query); const h = () => setOn(m.matches);
    h(); m.addEventListener('change', h); return () => m.removeEventListener('change', h);
  }, [query]);
  return on;
}
