/**
 * Front door — the multi-user entry point (ADR-0008). Owns: encrypted store
 * access, sessions, admin, and per-user slot proxying.
 * The editor core is untouched; slots are this repo's app process with a
 * per-user OW_HOME (spawned by slots.ts, T6).
 * First-run init is a first-claim page (M4e dropped the setup token: the only
 * audience was the installer, and the install output is the better carrier —
 * secrets are disposable, work lives in git).
 */
import express, { type Express } from 'express';
import type { Socket } from 'net';
import http from 'node:http';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { mintMasterKey, writeStore, hashToken, newSecret, readStore, loadMasterKey,
         resolveRuntimeDir, resolveStoreFile, pruneSessions, DEFAULT_SITE_NAME, type SettingsStore, type StoreUser } from '../../shared/store.js';
import { isAllowedHost, isAllowedOrigin, shouldTrustProxy } from '../site-gate.js';
import { resolveListenHost, resolveSiteOrigin } from '../deploy-env.js';
import { SESSION_COOKIE, SESSION_TTL_MS, serializeCookie, sessionFromReq, userForSession } from './auth.js';
import { pages } from './pages.js';
import { SlotManager, type Slot } from './slots.js';
import { proxyToSlot } from './proxy.js';
import { createLoginThrottle } from './throttle.js';

/** Store health is a tri-state (spec §Error handling): corrupt must be a LOUD
 * state distinct from unconfigured — never silently serve setup again. */
export type StoreHealth = 'unconfigured' | 'ok' | 'corrupt';

export function storeHealth(): StoreHealth {
  const storeFile = resolveStoreFile();
  if (!existsSync(storeFile)) return 'unconfigured';
  try {
    readStore(storeFile, loadMasterKey(resolveRuntimeDir()));
    return 'ok';
  } catch {
    return 'corrupt';
  }
}

function openStore(): { store: SettingsStore; key: Buffer } {
  const key = loadMasterKey(resolveRuntimeDir());
  if (!key) throw new Error('master key missing');
  const store = readStore(resolveStoreFile(), key);
  if (!store) throw new Error('not configured');
  return { store, key };
}

function saveStore(key: Buffer, store: SettingsStore): void {
  writeStore(resolveStoreFile(), key, pruneSessions(store));
}

/** The deployment's tab-title name (store.siteName). Absent store, pre-init,
 *  or a corrupt/unreadable store all degrade to the default — a name must
 *  never 500 a page. */
function siteName(): string {
  try {
    return readStore(resolveStoreFile(), loadMasterKey(resolveRuntimeDir()))?.siteName || DEFAULT_SITE_NAME;
  } catch {
    return DEFAULT_SITE_NAME;
  }
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const sess = sessionFromReq(req);
  const user = sess && userForSession(sess);
  if (!user?.isAdmin) { res.status(403).json({ error: 'Admin only.' }); return; }
  (req as any).adminUser = user;
  next();
}

const userUrl = () => `${resolveSiteOrigin() || ''}/login`;

export function createApp(opts?: { proxy?: express.RequestHandler }): Express {
  const app = express();
  if (shouldTrustProxy()) app.set('trust proxy', true);
  app.use((req, res, next) => {
    const port = (req.socket as Socket).localPort || parseInt(process.env.OW_PORT ?? '5051', 10);
    if (!isAllowedHost(req.headers.host, port) || (req.headers.origin && !isAllowedOrigin(req.headers.origin, port))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });

  const json = express.json({ limit: '1mb' });
  const loginThrottle = createLoginThrottle();

  app.get('/api/status', (_req, res) => res.json({ ok: true, configured: storeHealth() === 'ok' }));
  app.get('/api/setup/state', (_req, res) => {
    const h = storeHealth();
    res.json({ configured: h === 'ok', corrupt: h === 'corrupt' });
  });

  app.post('/api/login', json, (req, res) => {
    const verdict = loginThrottle.hit(req.ip ?? 'unknown');
    if (!verdict.allowed) return res.status(429).set('Retry-After', String(verdict.retryAfterSec)).json({ error: 'Too many tries from this network — rest a few minutes, then paste your token again.' });
    const { token } = req.body ?? {};
    if (!token) return res.status(400).json({ error: 'Paste your writer token.' });
    try {
      const { store, key } = openStore();
      const user = store.users.find((u) => u.loginTokenHash === hashToken(String(token)));
      if (!user) return res.status(403).json({ error: 'That token does not match a writer. Ask the admin for yours.' });
      const sessionId = newSecret(24);
      store.sessions.push({ idHash: hashToken(sessionId), userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
      saveStore(key, store);
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, sessionId, SESSION_TTL_MS));
      // Everyone lands on the desk; admins reach /admin from the sidebar gear.
      res.json({ redirect: '/' });
    } catch (e) {
      if (e instanceof Error && e.message === 'not configured') return res.status(409).json({ error: 'Not set up yet — the admin must set the app up first.' });
      if (e instanceof Error && e.message.startsWith('store corrupt')) return res.status(503).json({ error: 'The settings store is corrupt — restore a backup or delete it and re-init.' });
      throw e;
    }
  });

  app.post('/api/logout', (req, res) => {
    const sess = sessionFromReq(req);
    if (sess) { const { store, key } = openStore(); saveStore(key, { ...store, sessions: store.sessions.filter((x) => x.idHash !== sess.idHash) }); }
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', 0));
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    const sess = sessionFromReq(req);
    const user = sess && userForSession(sess);
    if (!user) return res.status(401).json({ error: 'Log in again.' });
    res.json({ user: { id: user.id, name: user.name, isAdmin: user.isAdmin } });
  });

  app.post('/api/setup/init', json, (req, res) => {
    const health = storeHealth();
    if (health === 'corrupt') return res.status(503).json({ error: 'The settings store is corrupt — restore a backup or delete it and re-init.' });
    if (health !== 'unconfigured') return res.status(409).json({ error: 'Already set up — log in.' });
    const { name, repoUrl, giteaUser, giteaPass, vk, siteName: site, chatPersona: persona } = req.body ?? {};
    if (!name?.trim() || !repoUrl?.trim() || !giteaUser?.trim() || !giteaPass) {
      return res.status(400).json({ error: 'Name, library URL, and library credentials are required.' });
    }
    const key = loadMasterKey(resolveRuntimeDir()) ?? mintMasterKey(resolveRuntimeDir());
    const adminToken = newSecret(24);
    const sessionId = newSecret(24);
    const now = new Date().toISOString();
    const adminUser = {
      id: randomUUID(),
      name: String(name).trim(),
      isAdmin: true,
      vk: vk ? String(vk) : null,
      loginTokenHash: hashToken(adminToken),
      createdAt: now
    };
    const store: SettingsStore = {
      v: 1, createdAt: now,
      ...(site?.trim() ? { siteName: String(site).trim() } : {}),
      ...(persona?.trim() ? { chatPersona: String(persona).trim() } : {}),
      users: [adminUser],
      gitea: { repoUrl: String(repoUrl).trim(), username: String(giteaUser).trim(), password: String(giteaPass) },
      sessions: [{ idHash: hashToken(sessionId), userId: adminUser.id, createdAt: now, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }],
    };
    saveStore(key, store);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, sessionId, SESSION_TTL_MS));
    const origin = resolveSiteOrigin() || '';
    res.status(201).json({ adminToken, url: `${origin}/login` });
  });

  app.get('/login', (req, res) => {
    const h = storeHealth();
    if (h === 'corrupt') return res.status(500).type('html').send(pages.corrupt(siteName()));
    if (h === 'unconfigured') return res.redirect('/');
    res.type('html').send(pages.login(siteName()));
  });

  app.get('/admin', (req, res) => {
    const sess = sessionFromReq(req);
    const user = sess && userForSession(sess);
    if (!user) return res.redirect('/login');
    if (!user.isAdmin) return res.status(403).type('html').send(pages.adminOnly(siteName()));
    res.type('html').send(pages.admin(siteName()));
  });

  app.get('/', (req, res, next) => {
    const h = storeHealth();
    if (h === 'corrupt') return res.status(500).type('html').send(pages.corrupt(siteName()));
    if (h === 'unconfigured') return res.type('html').send(pages.setup(siteName()));
    if (!sessionFromReq(req)) return res.redirect('/login');
    return next(); // T7 proxy mounts after this
  });

  app.use('/api', (req, res, next) => {
    if (!sessionFromReq(req)) return res.status(401).json({ error: 'Log in again.' });
    return next();
  });

  app.get('/api/admin/users', requireAdmin, (_req, res) => {
    const { store } = openStore();
    res.json(store.users.map((u) => ({ id: u.id, name: u.name, hasVk: u.vk != null, createdAt: u.createdAt })));
  });
  app.post('/api/admin/users', json, requireAdmin, (req, res) => {
    const { name, vk } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });
    const { store, key } = openStore();
    const loginToken = newSecret(24);
    const user: StoreUser = { id: randomUUID(), name: String(name).trim(), isAdmin: false, vk: vk ? String(vk) : null, loginTokenHash: hashToken(loginToken), createdAt: new Date().toISOString() };
    store.users.push(user);
    saveStore(key, store);
    res.status(201).json({ loginToken, url: userUrl() });
  });
  app.post('/api/admin/users/:id/reset-token', json, requireAdmin, (req, res) => {
    const { store, key } = openStore();
    const user = store.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'No such writer.' });
    const loginToken = newSecret(24);
    user.loginTokenHash = hashToken(loginToken);
    store.sessions = store.sessions.filter((s) => s.userId !== user.id);
    saveStore(key, store);
    res.json({ loginToken, url: userUrl() });
  });
  app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    const me = (req as any).adminUser as StoreUser;
    const { store, key } = openStore();
    const user = store.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'No such writer.' });
    if (user.id === me.id || user.isAdmin) return res.status(403).json({ error: 'The admin cannot be removed.' });
    store.users = store.users.filter((u) => u.id !== user.id);
    store.sessions = store.sessions.filter((s) => s.userId !== user.id);
    saveStore(key, store);
    res.json({ ok: true });
  });
  app.put('/api/admin/users/:id/vk', json, requireAdmin, (req, res) => {
    const { store, key } = openStore();
    const user = store.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'No such writer.' });
    user.vk = req.body?.vk ? String(req.body.vk) : null;
    saveStore(key, store);
    res.json({ hasVk: user.vk != null });
  });
  app.get('/api/admin/gitea', requireAdmin, (_req, res) => {
    const { store } = openStore();
    res.json({ repoUrl: store.gitea.repoUrl, username: store.gitea.username });
  });
  app.put('/api/admin/gitea', json, requireAdmin, (req, res) => {
    const { store, key } = openStore();
    if (req.body?.username) store.gitea.username = String(req.body.username);
    if (req.body?.password) store.gitea.password = String(req.body.password);
    saveStore(key, store);
    res.json({ ok: true });
  });
  app.get('/api/admin/persona', requireAdmin, (_req, res) => {
    const { store } = openStore();
    res.json({ chatPersona: store.chatPersona ?? '' });
  });
  app.put('/api/admin/persona', json, requireAdmin, (req, res) => {
    const { store, key } = openStore();
    const persona = String(req.body?.persona ?? '').trim();
    if (persona) store.chatPersona = persona; else delete store.chatPersona;
    saveStore(key, store);
    res.json({ ok: true });
  });

  if (!opts?.proxy) app.use((_req, res) => res.status(502).json({ error: 'Editor proxy lands in T7.' }));
  else app.use(opts.proxy);

  return app;
}

// --- front-door wiring (T7) ---
export function createFrontDoor(): {
  app: express.Express;
  resolveUpgrade: (req: http.IncomingMessage) => Slot | null;
  slotManager: SlotManager;
} {
  const slotManager = new SlotManager({
    workspacesBase: process.env.WRITER_WORKSPACES_BASE ?? '/srv/writer-app/workspaces',
    portBase: parseInt(process.env.WRITER_SLOT_PORT_BASE ?? '5100', 10),
    idleMs: parseInt(process.env.WRITER_SLOT_IDLE_MS ?? '900000', 10), // ~15 min, spec
  });
  const sessionToSlot = new Map<string, Slot>();
  const catchAll: express.RequestHandler = (req, res) => {
    const sess = sessionFromReq(req);
    if (!sess) return res.status(401).json({ error: 'Log in again.' }); // terminal catch-all — nothing follows to next() into
    slotManager.getSlot(sess.userId)
      .then((slot) => {
        sessionToSlot.set(sess.idHash, slot); // refresh every hit — respawn may move the port
        proxyToSlot(req, res, slot);
      })
      .catch(() => res.status(502).json({ error: 'Editor not available — try again in a moment.' }));
    return undefined;
  };
  const app = createApp({ proxy: catchAll }); // mounts INSTEAD of T4's TEMP stub — stub itself never edited
  return {
    app,
    slotManager,
    // Sync on purpose: getSlot is async, but sessionToSlot is warmed by the
    // proxy middleware on every HTTP hit (a browser opens WS only after a
    // page load, so the map is hot); on miss, destroy.
    resolveUpgrade(req) {
      const sess = sessionFromReq(req as express.Request);
      return sess ? sessionToSlot.get(sess.idHash) ?? null : null;
    },
  };
}

