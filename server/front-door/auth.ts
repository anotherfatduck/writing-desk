/** Cookie/session primitives (spec §Auth). Session lookup joins in T4. */
import { resolveSiteOrigin } from '../deploy-env.js';
import { hashToken, readStore, loadMasterKey, resolveRuntimeDir, resolveStoreFile,
         type StoreSession, type StoreUser } from '../../shared/store.js';
import type { Request } from 'express';

export const SESSION_COOKIE = 'pw_session';
export const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;

export function serializeCookie(name: string, value: string, maxAgeMs: number): string {
  const secure = (resolveSiteOrigin() || '').startsWith('https://');
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function sessionFromReq(req: Request): StoreSession | null {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  if (!m) return null;
  const idHash = hashToken(decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)));
  try {
    const store = readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()));
    if (!store) return null;
    const sess = store.sessions.find((x) => x.idHash === idHash);
    if (!sess || Date.parse(sess.expiresAt) <= Date.now()) return null;
    return sess;
  } catch { return null; }
}

export function userForSession(sess: StoreSession): StoreUser | null {
  try {
    const store = readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()));
    return store?.users.find((u) => u.id === sess.userId) ?? null;
  } catch { return null; }
}
