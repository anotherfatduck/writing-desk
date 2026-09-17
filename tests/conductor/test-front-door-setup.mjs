// Front door boot + first-run init (M4e: no setup token — first claim wins).
// Boots dist/bin/front-door.js with test-scoped runtime/store dirs (env
// overrides), asserts unconfigured → init → configured, and the loud corrupt
// state.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'; // existsSync/readFileSync join in T3
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const ROOT = new URL('../../', import.meta.url).pathname;

const tmp = mkdtempSync(join(tmpdir(), 'pw-fd-'));
const rt = join(tmp, 'runtime'); const storeFile = join(tmp, 'var', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = rt;
process.env.WRITER_STORE = storeFile;

// HTTP: fresh install is unconfigured, /api/setup/state public
const port = 5191;
const child = spawn('node', ['dist/bin/front-door.js'], { cwd: ROOT,
  env: { ...process.env, OW_PORT: String(port), OW_HOST: '127.0.0.1', WRITER_WORKSPACES_BASE: join(tmp, 'workspaces') },
  stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[fd:${port}-out] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[fd:${port}-err] ${d}`));
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${base}/api/status`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
assert(up, 'front door boots and serves /api/status');
const state = await (await fetch(`${base}/api/setup/state`)).json();
assert(state.configured === false && state.corrupt === false, 'fresh install reports unconfigured');
const setupPage = await (await fetch(`${base}/`)).text();
assert(setupPage.includes('data-setup-form'), 'unconfigured / serves the setup page');
// corrupt store → LOUD state, distinct from unconfigured (spec §Error handling)
mkdirSync(dirname(storeFile), { recursive: true }); // T2-phase app never wrote the store — the dir doesn't exist yet
writeFileSync(storeFile, '{ not an envelope');
const corrupt = await (await fetch(`${base}/api/setup/state`)).json();
assert(corrupt.corrupt === true && corrupt.configured === false, 'corrupt store reported distinctly');
const corruptPage = await (await fetch(`${base}/`)).text();
assert(corruptPage.includes('data-setup-form') === false, 'corrupt / does NOT serve setup');
child.kill('SIGTERM');
await new Promise(r => setTimeout(r, 500));

// --- init flow: init -> admin session (no setup token — M4e dropped it) ---
const rt_init = join(tmp, 'runtime_init'); const store_init = join(tmp, 'var_init', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = rt_init; process.env.WRITER_STORE = store_init;
const appmod = await import('../../dist/server/front-door/app.js');
const app = appmod.createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const addr_init = server.address();
const port_init = typeof addr_init === 'string' ? addr_init : addr_init.port;
const base_init = `http://127.0.0.1:${port_init}`;
const init = await fetch(`${base_init}/api/setup/init`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'gitea-pass-9', vk: 'vk-admin-1' }) });
assert(init.status === 201, 'init succeeds with no setup token');
const initBody = await init.json();
assert(initBody.adminToken && initBody.url.endsWith('/login'), 'init returns adminToken + url once');
const cookie = init.headers.get('set-cookie') || '';
assert(cookie.includes('pw_session=') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'), 'session cookie set (HttpOnly, SameSite=Lax)');
const dup = await fetch(`${base_init}/api/setup/init`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'gitea-pass-9' }) });
assert(dup.status === 409, 'second init → 409 (already set up)');
assert(existsSync(join(rt_init, 'master.key')) && existsSync(store_init), 'master key + store exist on disk');
const st = await import('../../dist/shared/store.js');
const raw = readFileSync(store_init, 'utf-8');
assert(raw.includes('gitea-pass-9') === false && raw.includes('vk-admin-1') === false, 'store ciphertext on disk, no plaintext');
const state_init = await (await fetch(`${base_init}/api/setup/state`)).json();
assert(state_init.configured === true, 'configured after init');
server.close();
process.env.WRITER_RUNTIME_DIR = rt; process.env.WRITER_STORE = storeFile;

// --- chat-agent-config: persona captured at first-claim (seed picker payload) ---
const rt_p = join(tmp, 'runtime_p'); const store_p = join(tmp, 'var_p', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = rt_p; process.env.WRITER_STORE = store_p;
{
  const appmod2 = await import('../../dist/server/front-door/app.js');
  const app2 = appmod2.createApp();
  const server2 = app2.listen(0, '127.0.0.1');
  await new Promise(r => server2.on('listening', r));
  const base_p = `http://127.0.0.1:${server2.address().port}`;

  // Setup page carries the seed picker + persona textarea, prefilled with the default
  const setupHtml = await (await fetch(`${base_p}/`)).text();
  assert(setupHtml.includes('data-persona-seed'), 'setup page has the persona seed picker');
  assert(setupHtml.includes('data-persona-text'), 'setup page has the persona textarea');
  assert(setupHtml.includes('data-persona-text rows="9">the writing agent on this site'), 'persona textarea prefilled with the neutral default');

  const PERSONA = "the writing agent of a food magazine — a food writer and editor with a recipe tester's care";
  const initP = await fetch(`${base_p}/api/setup/init`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'pw', chatPersona: '  ' + PERSONA + '  ' }) });
  assert(initP.status === 201, 'init with chatPersona succeeds');
  server2.close();
}
const st2 = await import('../../dist/shared/store.js');
const backP = st2.readStore(store_p, st2.loadMasterKey(rt_p));
assert(backP?.chatPersona === "the writing agent of a food magazine — a food writer and editor with a recipe tester's care", 'chatPersona stored trimmed (verbatim after trim)');

// Init without the field (or whitespace-only) → field absent, default applies
const rt_q = join(tmp, 'runtime_q'); const store_q = join(tmp, 'var_q', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = rt_q; process.env.WRITER_STORE = store_q;
{
  const appmod3 = await import('../../dist/server/front-door/app.js');
  const app3 = appmod3.createApp();
  const server3 = app3.listen(0, '127.0.0.1');
  await new Promise(r => server3.on('listening', r));
  const base_q = `http://127.0.0.1:${server3.address().port}`;
  const initQ = await fetch(`${base_q}/api/setup/init`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'pw', chatPersona: '   ' }) });
  assert(initQ.status === 201, 'init with whitespace-only chatPersona succeeds');
  server3.close();
}
const backQ = st2.readStore(store_q, st2.loadMasterKey(rt_q));
assert(backQ && backQ.chatPersona === undefined, 'whitespace-only chatPersona not stored (field absent, default applies)');
process.env.WRITER_RUNTIME_DIR = rt; process.env.WRITER_STORE = storeFile;

rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
