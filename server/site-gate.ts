/**
 * Shared Host/Origin gate primitives — the HTTP security gate (index.ts) and
 * the WS verifyClient (ws.ts) consume the same rules. Loopback rules are the
 * dev baseline and stay additive; the site URL (infra WRITER1_SITE_URL or
 * dev OW_ORIGIN — a single exact origin) adds the site entries (M4b patch #2).
 * Env read at call time so tests and ops can vary it per process.
 */
import { resolveSiteOrigin } from './deploy-env.js';

export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** The single site origin — one exact value, no list syntax. Empty in dev. */
export function siteOrigins(): string[] {
  const raw = resolveSiteOrigin().trim();
  return raw ? [raw] : [];
}

/** Hostnames of the site origins (bare values tolerated as hostnames). */
export function siteHostnames(): Set<string> {
  const out = new Set<string>();
  for (const raw of siteOrigins()) {
    try { out.add(new URL(raw).hostname.toLowerCase()); } catch { out.add(raw.toLowerCase()); }
  }
  return out;
}

/** Split a Host header into hostname + optional port, handling [::1]:port. */
export function splitHostHeader(hostHeader: string): { host: string; port?: string } {
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    if (close === -1) return { host: hostHeader };
    const host = hostHeader.slice(1, close);
    const rest = hostHeader.slice(close + 1);
    return { host, port: rest.startsWith(':') ? rest.slice(1) : undefined };
  }
  const colon = hostHeader.lastIndexOf(':');
  if (colon === -1) return { host: hostHeader };
  return { host: hostHeader.slice(0, colon), port: hostHeader.slice(colon + 1) };
}

/** True when the Host header names the site host (port ignored — nginx fronts
 *  :443 while the app serves the per-writer port) or loopback on our port. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const { host, port: p } = splitHostHeader(hostHeader.trim());
  if (siteHostnames().has(host.toLowerCase())) return true;
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) return false;
  if (p !== undefined && p !== String(port)) return false;
  return true;
}

/** True when an Origin/Referer URL is an exact site origin (when allowlisted)
 *  or same-origin loopback on our port. */
export function isAllowedOrigin(value: string | undefined, port: number): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    for (const e of siteOrigins()) {
      try { if (new URL(e).origin === u.origin) return true; } catch { /* skip */ }
    }
    if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return false;
    if (u.port && u.port !== String(port)) return false;
    return true;
  } catch {
    return false;
  }
}

/** WS-layer origin check — same rules without a serving port (the WS upgrade
 *  rides the HTTP server; loopback is hostname-only, as before M4b). */
export function isWsOriginAllowed(value: string): boolean {
  try {
    const u = new URL(value);
    for (const e of siteOrigins()) {
      try { if (new URL(e).origin === u.origin) return true; } catch { /* skip */ }
    }
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function shouldTrustProxy(): boolean {
  return resolveSiteOrigin() !== '';
}
