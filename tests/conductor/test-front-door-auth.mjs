// Front door session and auth lifecycle (T4).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const ROOT = new URL('../../', import.meta.url).pathname;

const tmp = mkdtempSync(join(tmpdir(), 'pw-auth-'));
const rt = join(tmp, 'runtime');
const storeFile = join(tmp, 'var', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = rt;
process.env.WRITER_STORE = storeFile;

async function setupFixture() {
  const appmod = await import('../../dist/server/front-door/app.js');
  const app = appmod.createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'string' ? addr : addr.port;
  const base = `http://127.0.0.1:${port}`;

  const init = await fetch(`${base}/api/setup/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'gitea-pass-9', vk: 'vk-admin-1' })
  });
  const initBody = await init.json();

  return { base, adminToken: initBody.adminToken, server };
}

try {
  const { base, adminToken, server } = await setupFixture();

  // 1. Login with wrong token -> 403
  const badLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' })
  });
  assert(badLogin.status === 403, 'login with wrong token -> 403');

  // 2. Login with adminToken -> cookie
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: adminToken })
  });
  assert(login.ok, 'login with adminToken succeeds');
  const cookie = login.headers.get('set-cookie') || '';
  assert(cookie.includes('pw_session='), 'login returns session cookie');
  const sessionId = cookie.split('pw_session=')[1].split(';')[0];

  // 3. GET /api/session with cookie -> {isAdmin:true}
  const sess = await fetch(`${base}/api/session`, {
    headers: { 'cookie': `pw_session=${sessionId}` }
  });
  assert(sess.ok, 'session request succeeds with cookie');
  const sessBody = await sess.json();
  assert(sessBody.user && sessBody.user.isAdmin === true, 'session reports isAdmin:true');

  // 4. Without cookie -> 401
  const sessNoCookie = await fetch(`${base}/api/session`);
  assert(sessNoCookie.status === 401, 'session request without cookie -> 401');

  // 5. / with cookie -> not redirected to /login (asserts 502 stub)
  const rootRes = await fetch(`${base}/`, {
    headers: { 'cookie': `pw_session=${sessionId}` }
  });
  assert(rootRes.url.endsWith('/'), 'authenticated / not redirected');
  const rootBody = await rootRes.text();
  assert(rootBody.includes('Editor proxy lands in T7'), 'authenticated / lands in 502 stub');

  // 6. Logout -> session invalid
  const logout = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { 'cookie': `pw_session=${sessionId}` }
  });
  assert(logout.ok, 'logout succeeds');
  const sessAfterLogout = await fetch(`${base}/api/session`, {
    headers: { 'cookie': `pw_session=${sessionId}` }
  });
  assert(sessAfterLogout.status === 401, 'session invalid after logout');

  server.close();
} catch (e) {
  console.error('Unexpected error:', e);
  failed++;
}

// 7. Session expiry: write a store with an already-expired session
try {
  const { hashToken, writeStore, mintMasterKey } = await import('../../dist/shared/store.js');
  const rt_exp = join(tmp, 'runtime_exp');
  const store_exp = join(tmp, 'var_exp', 'settings.enc');
  mkdirSync(dirname(store_exp), { recursive: true });

  const key_exp = mintMasterKey(rt_exp);
  const store_exp_obj = {
    v: 1,
    createdAt: new Date().toISOString(),
    users: [{ id: 'u1', name: 'U1', isAdmin: true, vk: null, loginTokenHash: hashToken('tk'), createdAt: new Date().toISOString() }],
    sessions: [{
      idHash: hashToken('expired-sess'),
      userId: 'u1',
      createdAt: new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    }],
  };
  writeStore(store_exp, key_exp, store_exp_obj);

  process.env.WRITER_RUNTIME_DIR = rt_exp;
  process.env.WRITER_STORE = store_exp;

  const appmod = await import('../../dist/server/front-door/app.js');
  const app = appmod.createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'string' ? addr : addr.port;
  const base = `http://127.0.0.1:${port}`;

  const expSess = await fetch(`${base}/api/session`, {
    headers: { 'cookie': `pw_session=expired-sess` }
  });
  assert(expSess.status === 401, 'expired session -> 401');

  server.close();
} catch (e) {
  console.error('Session expiry test error:', e);
  failed++;
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
