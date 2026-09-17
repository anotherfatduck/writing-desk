// tests/conductor/test-store.mjs — store crypto + schema (adr: 0009).
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const tmp = mkdtempSync(join(tmpdir(), 'pw-store-'));
try {
  const store = await import('../../dist/shared/store.js');
  const rt = join(tmp, 'runtime'); const sf = join(tmp, 'var', 'settings.enc');

  assert(store.resolveRuntimeDir() === '/etc/writing-desk/runtime', 'runtime dir default');
  process.env.WRITER_RUNTIME_DIR = rt;
  assert(store.resolveRuntimeDir() === rt, 'runtime dir env override (read at call time)');

  const key = store.mintMasterKey(rt);
  assert(key.length === 32, 'master key is 32 bytes');
  assert(existsSync(join(rt, 'master.key')), 'master.key written');
  let threw = false;
  try { store.mintMasterKey(rt); } catch { threw = true; }
  assert(threw, 'mintMasterKey refuses to overwrite');
  assert(store.loadMasterKey(rt).equals(key), 'loadMasterKey round-trips');

  const mk = () => ({ v: 1, createdAt: '2026-09-09T00:00:00Z',
    users: [{ id: 'u1', name: 'Admin', isAdmin: true, vk: 'vk-1234', loginTokenHash: 'deadbeef', createdAt: '2026-09-09T00:00:00Z' }],
    gitea: { repoUrl: 'https://gitea.example/owner/content-repo.git', username: 'collab', password: 'hunter2' },
    sessions: [{ idHash: 'abc', userId: 'u1', createdAt: '2026-09-09T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z' }] });

  store.writeStore(sf, key, mk());
  assert(readFileSync(sf, 'utf-8').includes('hunter2') === false, 'plaintext secret not on disk');
  assert((readFileSync(sf, 'utf-8').match(/"ct"/g) || []).length === 1, 'envelope carries ciphertext');

  const back = store.readStore(sf, key);
  assert(back && back.users[0].vk === 'vk-1234' && back.gitea.password === 'hunter2', 'readStore round-trips');

  // wrong key → loud throw, not null
  const key2 = store.mintMasterKey(join(tmp, 'rt2'));
  let corrupt = null;
  try { store.readStore(sf, key2); } catch (e) { corrupt = e.message; }
  assert(corrupt && corrupt.startsWith('store corrupt'), `wrong key throws loudly (${corrupt})`);

  // future schema version → loud throw (GCM-VALID payload, wrong v — reaches the version guard)
  const { createCipheriv: cc, randomBytes: rb } = await import('node:crypto');
  const iv2 = rb(12); const c2 = cc('aes-256-gcm', key, iv2);
  const ct2 = Buffer.concat([c2.update(JSON.stringify({ ...mk(), v: 2 }), 'utf-8'), c2.final()]);
  writeFileSync(sf, JSON.stringify({ v: 2, iv: iv2.toString('base64'), tag: c2.getAuthTag().toString('base64'), ct: ct2.toString('base64') }));
  let verr = null;
  try { store.readStore(sf, key); } catch (e) { verr = e.message; }
  assert(verr && verr.includes('schema'), `future schema version throws loudly (${verr})`);

  // atomic write leaves no residue
  assert(!existsSync(`${sf}.tmp`), 'no .tmp residue after write');

  // absent file → null (unconfigured)
  assert(store.readStore(join(tmp, 'nope.enc'), key) === null, 'absent store = null');

  // pruned sessions
  const pruned = store.pruneSessions(mk(), Date.parse('2026-09-09T00:00:01Z'));
  assert(pruned.sessions.length === 0, 'expired sessions pruned');
  assert(store.pruneSessions({ ...mk(), sessions: [{ idHash: 'x', userId: 'u1', createdAt: '', expiresAt: '2099-01-01T00:00:00Z' }] }, 0).sessions.length === 1, 'live sessions kept');

  assert(store.hashToken('tok') === store.hashToken('tok') && store.hashToken('a') !== store.hashToken('b'), 'hashToken stable + distinct');
  assert(/^[A-Za-z0-9_-]+$/.test(store.newSecret()), 'newSecret is urlsafe');
} finally { rmSync(tmp, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
