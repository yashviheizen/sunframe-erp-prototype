import { useSyncExternalStore } from 'react';

// Minimal hash router: "#/sales/abc" → ['sales', 'abc']. Survives refresh.
const sub = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
const snap = () => window.location.hash;

export function useRoute(): string[] {
  const h = useSyncExternalStore(sub, snap);
  const parts = h.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  return parts.length ? parts : ['dashboard'];
}
export function nav(path: string) {
  const next = '#/' + path.replace(/^\/+/, '');
  if (window.location.hash !== next) window.location.hash = next;
}
/** "?q=PR-0001" part of the hash — used to deep-link a search into a list page. */
export function routeQuery(key: string): string {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(key) ?? '';
}
