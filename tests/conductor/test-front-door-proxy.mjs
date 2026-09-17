import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { bootApp, shutdown } from '../spike-a/lib/spike.mjs';

const { createFrontDoor } = await import('../../dist/server/front-door/app.js');
const { wireUpgrade } = await import('../../dist/server/front-door/proxy.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

async function run() {
  const tmp = mkdtempSync(join(tmpdir(), 'pw-proxy-'));
  const rt = join(tmp, 'runtime');
  const storeFile = join(tmp, 'var', 'settings.enc');
  mkdirSync(join(tmp, 'var'), { recursive: true });

  process.env.WRITER_RUNTIME_DIR = rt;
  process.env.WRITER_STORE = storeFile;
  process.env.WRITER_SLOT_PORT_BASE = '5200';
  process.env.WRITER_WORKSPACES_BASE = join(tmp, 'workspaces');
  process.env.WRITER_SLOT_IDLE_MS = '600000';

  const fd = createFrontDoor();
  const server = createServer(fd.app);
  wireUpgrade(server, fd.resolveUpgrade, () => {});

  let slotApp;
  const fdPort = 5191;
  await new Promise(r => server.listen(fdPort, '127.0.0.1', r));
  const fdBase = `http://127.0.0.1:${fdPort}`;

  try {
    // 1. Setup Front Door
    const initRes = await fetch(`${fdBase}/api/setup/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'owner', repoUrl: 'https://g/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'p' })
    });
    assert(initRes.status === 201, 'front door init succeeds');

    // 2. Create writer user
    const adminCookie = initRes.headers.get('set-cookie') || '';
    const userRes = await fetch(`${fdBase}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'Writer', vk: 'vk-writer' })
    });
    const { loginToken } = await userRes.json();
    assert(loginToken, 'created writer user');

    // 3. Resolve real writer id and register static fixture slot
    const writerUsersList = await (await fetch(`${fdBase}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
    const writerUser = writerUsersList.find((u) => u.name === 'Writer');
    const writerId = writerUser.id;
    fd.slotManager.registerStaticSlot(writerId, 5255, 'slotbearer');
    slotApp = await bootApp({ port: 5255, bearer: 'slotbearer' });

    // 4. Login as writer
    const loginRes = await fetch(`${fdBase}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: loginToken })
    });
    const writerCookie = loginRes.headers.get('set-cookie') || '';
    assert(writerCookie.includes('pw_session'), 'writer logged in');

    // 5. Basic Auth Gates
    const unauthPage = await fetch(`${fdBase}/`, { redirect: 'manual' });
    assert(unauthPage.status === 302, 'unauth / -> 302 /login');

    const authPage = await fetch(`${fdBase}/`, { headers: { cookie: writerCookie } });
    assert(authPage.status === 200, 'auth / -> 200');

    // 6. Proxy + Bearer Injection
    const docsRes = await fetch(`${fdBase}/api/documents`, { headers: { cookie: writerCookie } });
    assert(docsRes.status === 200, 'GET /api/documents via proxy -> 200');

    // Proxy Body Delivery
    const postRes = await fetch(`${fdBase}/api/documents`, {
      method: 'POST',
      headers: { cookie: writerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ test: 'body-delivery' })
    });
    // The slot's /api/documents POST probably isn't implemented to echo, but it shouldn't 400/500 due to empty body
    assert(postRes.status !== 400 && postRes.status !== 500, 'POST through proxy delivers body (no server error)');

    // 7. Bearer Controls (Spec §Testing)
    const directNoBearer = await fetch(`http://127.0.0.1:5255/api/documents`);
    assert(directNoBearer.status === 401, 'direct slot without bearer -> 401');
    const directBearer = await fetch(`http://127.0.0.1:5255/api/documents`, {
      headers: { authorization: 'Bearer slotbearer' }
    });
    assert(directBearer.status === 200, 'direct slot with bearer -> 200');

    // 8. WS Upgrade
    const ws = new WebSocket(`ws://127.0.0.1:${fdPort}/ws`, { headers: { cookie: writerCookie } });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS timeout')), 30000);
    });
    assert(ws.readyState === WebSocket.OPEN, 'WS upgrade with cookie -> OPEN');
    ws.close();

    const wsUnauth = new WebSocket(`ws://127.0.0.1:${fdPort}/ws`);
    await new Promise((resolve) => {
      wsUnauth.on('open', () => { assert(false, 'WS without cookie should NOT open'); resolve(); });
      wsUnauth.on('error', () => { assert(true, 'WS without cookie -> error/closed'); resolve(); });
      setTimeout(() => { assert(true, 'WS without cookie -> timeout/closed'); resolve(); }, 2000);
    });

    // 9. Isolation Leg
    // Create another user for u-ghost
    const ghostUserRes = await fetch(`${fdBase}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'Ghost' })
    });
    const { loginToken: ghostToken } = await ghostUserRes.json();

    const usersList = await (await fetch(`${fdBase}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
    const ghostUser = usersList.find((u) => u.name === 'Ghost');
    const ghostId = ghostUser.id;
    fd.slotManager.registerStaticSlot(ghostId, 5299, 'ghostbearer');

    const ghostLoginRes = await fetch(`${fdBase}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ghostToken })
    });
    const ghostCookie = ghostLoginRes.headers.get('set-cookie') || '';

    const ghostDocs = await fetch(`${fdBase}/api/documents`, { headers: { cookie: ghostCookie } });
    const ghostDocsBody = await ghostDocs.json();
    assert(ghostDocs.status === 502 && ghostDocsBody.error?.includes('Editor not available'), 'isolation: dead slot -> 502');

  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    await fd.slotManager.stopAll();
    await shutdown(slotApp);
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

run().then(() => {
  process.exit(failed ? 1 : 0);
});
