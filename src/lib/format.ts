import type { ISODate, PriceLine } from './types';

// The seed replays business actions on a historical clock with stable ids; everything else uses the real clock.
let idGen: (() => string) | null = null;
let clock: (() => Date) | null = null;
export const setIdGenerator = (fn: (() => string) | null) => { idGen = fn; };
export const setClock = (fn: (() => Date) | null) => { clock = fn; };
export const nowDate = () => (clock ? clock() : new Date());

export const uid = () => (idGen ? idGen() : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4));

export function inr(n: number | null | undefined, opts: { decimals?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const d = opts.decimals ? 2 : 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Compact Indian notation for headline figures: ₹12.4 L, ₹1.25 Cr */
export function inrShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
  return inr(n);
}

export function qty(n: number, unit?: string): string {
  const s = n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${s} ${unit}` : s;
}

const localISO = (d: Date): ISODate => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export function todayISO(): ISODate { return localISO(nowDate()); }

export function addDays(iso: ISODate, days: number): ISODate {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  // Full timestamps are UTC; show them in the viewer's local date.
  if (iso.length > 10 && iso.includes('T')) { const t = new Date(iso); if (!isNaN(+t)) iso = localISO(t); }
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[+m - 1]} ${y}`;
}
/** Compact date for cards and narrow cells: "12 Oct", with the year only when it isn't the current one. */
export function fmtShort(iso?: string | null): string {
  const f = fmtDate(iso);
  if (f === '—' || !iso) return f;
  return iso.slice(0, 4) === todayISO().slice(0, 4) ? f.slice(0, -5) : f.slice(0, -5) + " '" + iso.slice(2, 4);
}
export function fmtDateTime(iso?: string): string {
  if (!iso) return '—';
  const t = new Date(iso);
  return `${fmtDate(localISO(t))}, ${t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000);
}

/**
 * Interpret free-text payment terms as a credit period in days.
 * "30 days", "Net 45", "45 days from dispatch" → number; "Advance", "Immediate", "On delivery" → 0.
 * Anything else returns null so the user is asked for an explicit due date.
 */
export function parseTermsDays(terms: string): number | null {
  const t = terms.trim().toLowerCase();
  if (!t) return null;
  if (/^(100%\s*)?(advance|immediate|on delivery|cash on delivery|cod|against delivery)\b/.test(t)) return 0;
  const m = t.match(/(\d{1,3})\s*(days?|d\b)/) || t.match(/net\s*(\d{1,3})/);
  if (m) return +m[1];
  return null;
}

export const lineTotal = (l: PriceLine) => (+l.qty || 0) * (+l.rate || 0);
export const linesSubtotal = (ls: PriceLine[]) => ls.reduce((a, l) => a + lineTotal(l), 0);

export function quoteTotals(q: { lines: PriceLine[]; discountPct: number; freight: number; gstPct: number }) {
  const subtotal = linesSubtotal(q.lines);
  const discount = (subtotal * (+q.discountPct || 0)) / 100;
  const taxable = subtotal - discount + (+q.freight || 0);
  const gst = (taxable * (+q.gstPct || 0)) / 100;
  return { subtotal, discount, taxable, gst, total: taxable + gst };
}

export function fileSize(b: number) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
