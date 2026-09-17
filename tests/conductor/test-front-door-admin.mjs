// Admin API and Page (Task 5).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const ROOT = new URL('../../', import.meta.url).pathname;

const tmp = mkdtempSync(join(tmpdir(), 'pw-admin-'));
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

  // 1. Get admin cookie
  const adminLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: adminToken })
  });
  const adminCookie = adminLogin.headers.get('set-cookie') || '';
  const adminSessId = adminCookie.split('pw_session=')[1].split(';')[0];
  const adminHeaders = { 'cookie': `pw_session=${adminSessId}` };

  // 2. Create user w1
  const createRes = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ name: 'Doc B' })
  });
  assert(createRes.status === 201, 'create user w1 -> 201');
  const createBody = await createRes.json();
  assert(createBody.loginToken && createBody.url, 'create user returns token and url');
  const w1Token = createBody.loginToken;

  // 3. Login as w1
  const w1Login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: w1Token })
  });
  assert(w1Login.ok, 'login as w1 succeeds');
  const w1Cookie = w1Login.headers.get('set-cookie') || '';
  const w1SessId = w1Cookie.split('pw_session=')[1].split(';')[0];
  const w1Headers = { 'cookie': `pw_session=${w1SessId}` };

  // 4. As w1: GET /api/admin/users -> 403
  const w1AdminUsers = await fetch(`${base}/api/admin/users`, { headers: w1Headers });
  assert(w1AdminUsers.status === 403, 'writer GET /api/admin/users -> 403');

  // 5. As admin: GET /api/admin/users -> 200 list containing Doc B
  const adminUsers = await fetch(`${base}/api/admin/users`, { headers: adminHeaders });
  assert(adminUsers.ok, 'admin GET /api/admin/users -> 200');
  const usersList = await adminUsers.json();
  const w1User = usersList.find(u => u.name === 'Doc B');
  assert(w1User && w1User.hasVk === false && w1User.vk === undefined, 'Doc B in list, hasVk:false, no vk field');
  const w1Id = w1User.id;

  // 6. As admin: PUT /api/admin/users/<id>/vk -> hasVk:true, no key material
  const putVk = await fetch(`${base}/api/admin/users/${w1Id}/vk`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ vk: 'vk-doc-b' })
  });
  assert(putVk.ok, 'PUT vk succeeds');
  const putVkBody = await putVk.json();
  assert(putVkBody.hasVk === true && putVkBody.vk === undefined, 'response hasVk:true, no vk material');

  // 7. As w1: DELETE /api/admin/users/<self> -> 403
  const delSelf = await fetch(`${base}/api/admin/users/${w1Id}`, {
    method: 'DELETE',
    headers: w1Headers
  });
  assert(delSelf.status === 403, 'writer DELETE self -> 403');

  // 7b. As admin: DELETE self -> 403
  const adminUserList = await fetch(`${base}/api/admin/users`, { headers: adminHeaders });
  const adminUser = (await adminUserList.json())[0];
  const delAdminSelf = await fetch(`${base}/api/admin/users/${adminUser.id}`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert(delAdminSelf.status === 403, 'admin DELETE self -> 403');

  // 7c. As admin: DELETE user #1 (admin) -> 403
  // In our fixture, the first user is the admin.
  const delUser1 = await fetch(`${base}/api/admin/users/${adminUser.id}`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert(delUser1.status === 403, 'admin DELETE user #1 -> 403');

  // 8. As admin: reset-token on Doc B
  const resetRes = await fetch(`${base}/api/admin/users/${w1Id}/reset-token`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert(resetRes.ok, 'reset-token succeeds');
  const resetBody = await resetRes.json();
  assert(resetBody.loginToken && resetBody.url, 'reset-token returns new token and url');
  const w1NewToken = resetBody.loginToken;

  // 9. Verify OLD token stops working
  const oldLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: w1Token })
  });
  assert(oldLogin.status === 403, 'old token -> 403');

  // 10. Verify w1's pre-reset session is dead
  const oldSess = await fetch(`${base}/api/session`, { headers: w1Headers });
  assert(oldSess.status === 401, 'pre-reset session -> 401');

  // 11. Login as w1 with NEW token
  const w1NewLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: w1NewToken })
  });
  assert(w1NewLogin.ok, 'login with new token succeeds');
  const w1NewCookie = w1NewLogin.headers.get('set-cookie') || '';
  const w1NewSessId = w1NewCookie.split('pw_session=')[1].split(';')[0];
  const w1NewHeaders = { 'cookie': `pw_session=${w1NewSessId}` };

  // 12. As admin: delete Doc B -> 200
  const delUser = await fetch(`${base}/api/admin/users/${w1Id}`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert(delUser.ok, 'delete user w1 -> 200');

  // 13. Verify w1's new session is dead
  const newSess = await fetch(`${base}/api/session`, { headers: w1NewHeaders });
  assert(newSess.status === 401, 'session dead after delete -> 401');

  // 14. As admin: PUT /api/admin/gitea {username: 'newu'}
  const putGitea = await fetch(`${base}/api/admin/gitea`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ username: 'newu' })
  });
  assert(putGitea.ok, 'PUT gitea succeeds');

  // 15. As admin: GET /api/admin/gitea -> new username, no password
  const getGitea = await fetch(`${base}/api/admin/gitea`, { headers: adminHeaders });
  assert(getGitea.ok, 'GET gitea succeeds');
  const giteaBody = await getGitea.json();
  assert(giteaBody.username === 'newu' && giteaBody.password === undefined, 'gitea response has new username, no password');

  // --- Page Routing ---

  // Unauthenticated /admin -> 302 /login
  const pageUnauth = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert(pageUnauth.status === 302 && pageUnauth.headers.get('location') === '/login', '/admin unauth -> 302 /login');

  // Writer /admin -> 403 HTML
  // Need a live writer session
  const w2Create = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ name: 'Writer 2' })
  });
  const w2Body = await w2Create.json();
  const w2Login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: w2Body.loginToken })
  });
  const w2Cookie = w2Login.headers.get('set-cookie') || '';
  const w2SessId = w2Cookie.split('pw_session=')[1].split(';')[0];
  const w2Headers = { 'cookie': `pw_session=${w2SessId}` };

  const pageWriter = await fetch(`${base}/admin`, { headers: w2Headers });
  assert(pageWriter.status === 403, '/admin writer -> 403');
  const pageWriterBody = await pageWriter.text();
  assert(pageWriterBody.includes('Admin only'), '/admin writer response contains "Admin only"');

  // Admin /admin -> 200 HTML
  const pageAdmin = await fetch(`${base}/admin`, { headers: adminHeaders });
  assert(pageAdmin.ok, '/admin admin -> 200');

  // Persona: GET default empty, PUT stores, PUT whitespace clears, non-admin 403
  const getPersona = await fetch(`${base}/api/admin/persona`, { headers: adminHeaders });
  assert(getPersona.status === 200, 'GET persona 200 for admin');
  assert((await getPersona.json()).chatPersona === '', 'persona reads empty when the default applies');
  const TECH_PERSONA = "the writing agent of a tech publication — a staff writer with a magazine copy editor's eye";
  const putPersona = await fetch(`${base}/api/admin/persona`, { method: 'PUT', headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ persona: TECH_PERSONA }) });
  assert(putPersona.ok, 'PUT persona saves');
  assert((await (await fetch(`${base}/api/admin/persona`, { headers: adminHeaders })).json()).chatPersona === TECH_PERSONA, 'PUT persona round-trips verbatim');
  const putClear = await fetch(`${base}/api/admin/persona`, { method: 'PUT', headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ persona: '   ' }) });
  assert(putClear.ok, 'PUT whitespace persona accepted');
  assert((await (await fetch(`${base}/api/admin/persona`, { headers: adminHeaders })).json()).chatPersona === '', 'whitespace persona clears to the default');
  // w1's session is dead by now (token reset + user deleted) — the /api guard
  // answers 401 for it, never 403. Use the live non-admin session (w2, created
  // for the page-routing block) to exercise requireAdmin's 403.
  const w2PersonaGet = await fetch(`${base}/api/admin/persona`, { headers: w2Headers });
  assert(w2PersonaGet.status === 403, 'non-admin GET persona -> 403');
  const w2PersonaPut = await fetch(`${base}/api/admin/persona`, { method: 'PUT', headers: { 'content-type': 'application/json', ...w2Headers },
    body: JSON.stringify({ persona: 'nope' }) });
  assert(w2PersonaPut.status === 403, 'non-admin PUT persona -> 403');

  // The admin page script wires the persona editor
  const adminPageBody = await (await fetch(`${base}/admin`, { headers: adminHeaders })).text();
  assert(adminPageBody.includes('/api/admin/persona'), 'admin page script fetches the persona route');

  server.close();
} catch (e) {
  console.error('Unexpected error:', e);
  failed++;
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
