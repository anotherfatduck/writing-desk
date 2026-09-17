// Site name (tab title) — store field, init round-trip, front-door page
// titles, and the slot-server shell substitution. owner ruling 2026-09-15:
// the tab shows the project's own name; unset stores fall back to the
// default; the substitution touches only the <title> element.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const ROOT = new URL('../../', import.meta.url).pathname;
const titleOf = (html) => html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;

const pages = (await import('../../dist/server/front-door/pages.js')).pages;
const storemod = await import('../../dist/shared/store.js');
const DEFAULT_SITE_NAME = storemod.DEFAULT_SITE_NAME;

// --- pages: default and custom titles, title-only escaping ---
assert(titleOf(pages.login()) === `${DEFAULT_SITE_NAME} · Log in to your writing desk`, `login page defaults to "${DEFAULT_SITE_NAME}"`);
assert(titleOf(pages.login('ThereIsNoSpoon')) === 'ThereIsNoSpoon · Log in to your writing desk', 'login page carries the site name');
assert(titleOf(pages.setup('ThereIsNoSpoon')) === 'ThereIsNoSpoon · Set up your writing desk', 'setup page carries the site name');
assert(titleOf(pages.admin('ThereIsNoSpoon')) === 'ThereIsNoSpoon · Settings', 'admin page carries the site name');
assert(pages.setup('A<b').includes('<title>A&lt;b · Set up'), 'title markup is escaped');
assert(pages.setup('A<b').includes('value="A&lt;b"'), 'setup form prefill is escaped');

// --- init round-trip through the front door app (in-process) ---
const appmod = await import('../../dist/server/front-door/app.js');
async function bootFrontDoor() {
  const app = appmod.createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
function freshEnv(tag) {
  const tmp = mkdtempSync(join(tmpdir(), `pw-site-${tag}-`));
  const rt = join(tmp, 'runtime'); const storeFile = join(tmp, 'var', 'settings.enc');
  process.env.WRITER_RUNTIME_DIR = rt;
  process.env.WRITER_STORE = storeFile;
  return { tmp, rt, storeFile };
}
function mintStoreKey(rt) {
  mkdirSync(rt, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(rt, 'master.key'), `${key.toString('base64')}\n`, { mode: 0o640 });
  return key;
}
async function initSite(base, body) {
  return fetch(`${base}/api/setup/init`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// init WITH a site name → stored, and the front-door pages title with it
{
  const { tmp, rt, storeFile } = freshEnv('named');
  const key = mintStoreKey(rt);
  const { server, base } = await bootFrontDoor();
  const init = await initSite(base, { name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'pw', siteName: 'ThereIsNoSpoon' });
  assert(init.status === 201, 'init with siteName succeeds');
  const loginHtml = await (await fetch(`${base}/login`)).text();
  assert(titleOf(loginHtml) === 'ThereIsNoSpoon · Log in to your writing desk', 'login title carries the init siteName');
  const stored = storemod.readStore(storeFile, key);
  assert(stored?.siteName === 'ThereIsNoSpoon', 'store carries the siteName');
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(tmp, { recursive: true, force: true });
}

// init WITHOUT a siteName → field absent, titles fall back to the default
{
  const { tmp, rt, storeFile } = freshEnv('unnamed');
  const key = mintStoreKey(rt);
  const { server, base } = await bootFrontDoor();
  const init = await initSite(base, { name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'pw' });
  assert(init.status === 201, 'init without siteName succeeds');
  const loginHtml = await (await fetch(`${base}/login`)).text();
  assert(titleOf(loginHtml)?.startsWith(`${DEFAULT_SITE_NAME} · `), 'no siteName → default title');
  const stored = storemod.readStore(storeFile, key);
  assert(stored?.siteName === undefined, 'no siteName → field absent in store');
  server.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(tmp, { recursive: true, force: true });
}

// --- slot server: shell <title> substitution, byte-exact elsewhere ---
async function serveShell(env, port) {
  const child = spawn('node', ['dist/bin/server.js', '--port', String(port), '--no-open'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const html = await (await fetch(base)).text();
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  return html;
}

const shell = readFileSync(join(ROOT, 'dist', 'client', 'index.html'), 'utf-8');
const shellTitle = titleOf(shell);

// no store → the built shell title passes through
{
  const tmp = mkdtempSync(join(tmpdir(), 'pw-shell-default-'));
  const html = await serveShell({ ...process.env, OW_HOME: tmp, OW_HEADLESS: '1' }, 5192);
  assert(titleOf(html) === shellTitle, 'slot server serves the built shell title when no store exists');
  rmSync(tmp, { recursive: true, force: true });
}

// store with siteName → substituted, and ONLY the title element changes
{
  const tmp = mkdtempSync(join(tmpdir(), 'pw-shell-named-'));
  const rt = join(tmp, 'runtime'); const storeFile = join(tmp, 'var', 'settings.enc');
  const key = mintStoreKey(rt);
  storemod.writeStore(storeFile, key, { v: 1, createdAt: new Date().toISOString(), siteName: 'ThereIsNoSpoon', users: [], gitea: { repoUrl: '', username: '', password: '' }, sessions: [] });
  const env = { ...process.env, OW_HOME: tmp, OW_HEADLESS: '1', WRITER_RUNTIME_DIR: rt, WRITER_STORE: storeFile };
  const html = await serveShell(env, 5193);
  assert(titleOf(html) === 'ThereIsNoSpoon', 'slot server tab title carries the store siteName');
  const expected = shell.replace(/<title>[\s\S]*?<\/title>/, '<title>ThereIsNoSpoon</title>');
  assert(html === expected, 'substitution changes only the title element (byte-exact)');
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed === 0 ? 'test-site-name: PASS' : `test-site-name: ${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);