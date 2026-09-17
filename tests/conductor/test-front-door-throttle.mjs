// Front door login throttle — attempt cap per IP before the internet move.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const tmp = mkdtempSync(join(tmpdir(), 'pw-throttle-'));
process.env.WRITER_RUNTIME_DIR = join(tmp, 'runtime');
process.env.WRITER_STORE = join(tmp, 'var', 'settings.enc');

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
  const attempt = (token) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });

  // Attempts 1..20 (wrong tokens) -> the cap is 20/15min, all still 403.
  let underCapOk = true;
  for (let i = 1; i <= 20; i++) {
    const res = await attempt(`wrong-${i}`);
    if (res.status !== 403) underCapOk = false;
  }
  assert(underCapOk, '20 attempts under the cap all pass through (403)');

  // Attempt 21 -> 429, writer vocabulary, Retry-After.
  const capped = await attempt('wrong-21');
  assert(capped.status === 429, '21st attempt -> 429');
  assert(!!capped.headers.get('retry-after'), '429 carries Retry-After');
  const cappedBody = await capped.json();
  assert(typeof cappedBody.error === 'string' && cappedBody.error.includes('token'), '429 message speaks writer vocabulary (token)');

  // Even a valid token is pre-empted at the cap.
  const validAtCap = await attempt(adminToken);
  assert(validAtCap.status === 429, 'valid token also 429s at the cap (throttle preempts token check)');

  server.close();
} catch (e) {
  console.error('Unexpected error:', e);
  failed++;
}

// Unit layer — the throttle itself with an injected clock.
try {
  const mod = await import('../../dist/server/front-door/throttle.js');
  const now = { t: 1000 };
  const t = mod.createLoginThrottle({ max: 2, windowMs: 1000, now: () => now.t });

  assert(t.hit('a').allowed === true, 'first attempt allowed');
  assert(t.hit('a').allowed === true, 'second attempt allowed');
  const capped = t.hit('a');
  assert(capped.allowed === false && capped.retryAfterSec > 0, 'third attempt blocked with retryAfterSec');
  assert(t.hit('b').allowed === true, 'other IP unaffected (per-key isolation)');

  now.t = 1500;
  assert(t.hit('a').allowed === false, 'still blocked inside the window');
  now.t = 2100;
  assert(t.hit('a').allowed === true, 'window expiry restores access');
  assert(t.hit('a').allowed === true, 'fresh window counts from zero');
  assert(t.hit('a').allowed === false, 'fresh window caps again');
} catch (e) {
  console.error('Throttle unit error:', e.message);
  failed++;
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);