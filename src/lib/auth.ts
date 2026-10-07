import { useSyncExternalStore } from 'react';
import type { ID } from './types';

/*
 * Prototype sign-in. There is no backend, so this is a SIMULATED session, not secure authentication:
 * the test accounts below live in the client bundle and anyone can read them.
 *
 * - Only the signed-in user id is kept, in sessionStorage (per tab; cleared when the browser session ends).
 * - The entered password is compared in memory and never stored or logged.
 * - Business records stay in localStorage ('sunframe-erp-v1') and files in IndexedDB; this key is separate.
 */

export interface TestAccount { userId: ID; email: string; password: string; label: string }

/** Fictional test accounts, mapped to existing user ids (roles come from the user record). */
export const TEST_ACCOUNTS: TestAccount[] = [
  { userId: 'u_admin', email: 'abhineet@sunframe.example', password: 'SunFrame@admin', label: 'Admin' },
  { userId: 'u_meera', email: 'meera@sunframe.example', password: 'SunFrame@meera', label: 'Purchase executive' },
  { userId: 'u_dinesh', email: 'dinesh@sunframe.example', password: 'SunFrame@dinesh', label: 'Production supervisor' },
];

const KEY = 'sunframe-session';
const EVT = 'sunframe-session-change';

export interface Session { userId: ID; at: string }

function read(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

/** Current session, or null when signed out. */
export function getSession(): Session | null {
  const raw = read();
  if (!raw) return null;
  try { const s = JSON.parse(raw) as Session; return s && typeof s.userId === 'string' ? s : null; } catch { return null; }
}

const sub = (cb: () => void) => { window.addEventListener(EVT, cb); return () => window.removeEventListener(EVT, cb); };
/** Re-renders on sign-in/out. Returns the raw stored string so the snapshot is stable between reads. */
export function useSession(): Session | null {
  const raw = useSyncExternalStore(sub, read);
  return raw ? getSession() : null;
}

/** Returns the matching account, or null. Email is case-insensitive; the password must match exactly. */
export function checkCredentials(email: string, password: string): TestAccount | null {
  const e = email.trim().toLowerCase();
  return TEST_ACCOUNTS.find(a => a.email === e && a.password === password) ?? null;
}

export function startSession(userId: ID) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ userId, at: new Date().toISOString() } satisfies Session)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVT));
}

export function endSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVT));
}
