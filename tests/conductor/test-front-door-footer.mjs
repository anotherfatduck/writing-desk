// Front door login-page footer — the main-site pattern: © line + byline +
// quiet stack credit (openwriter upstream, ollama models). No credits page.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const tmp = mkdtempSync(join(tmpdir(), 'pw-footer-'));
process.env.WRITER_RUNTIME_DIR = join(tmp, 'runtime');
process.env.WRITER_STORE = join(tmp, 'var', 'settings.enc');

try {
  const appmod = await import('../../dist/server/front-door/app.js');
  const app = appmod.createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const addr = server.address();
  const port = typeof addr === 'string' ? addr : addr.port;
  const base = `http://127.0.0.1:${port}`;

  // Set the store up first — an unconfigured app redirects /login to the
  // setup page, and the deployed app this page ships for is configured.
  const init = await fetch(`${base}/api/setup/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', repoUrl: 'https://gitea.example/owner/content-repo.git', giteaUser: 'owner', giteaPass: 'gitea-pass-9' })
  });
  if (!init.ok) { console.error('setup/init failed:', init.status); process.exit(1); }

  const login = await fetch(`${base}/login`);
  assert(login.status === 200, 'GET /login -> 200');
  const body = await login.text();
  assert(body.includes('© Writing Desk 2026'), 'footer carries the © line');
  assert(body.includes('© Writing Desk 2026. All rights reserved.<br>A writing desk by'), '© line stands alone; byline leads line two');
  assert(body.includes('thereisnospoon.dev'), 'footer carries the byline');
  assert(body.includes('openwriter'), 'footer credits openwriter');
  assert(!body.includes('ollama'), 'no ollama credit — not our sponsor');

  // The about page is gone — one quiet line, not a page.
  const about = await fetch(`${base}/about`);
  assert(about.status !== 200, 'GET /about no longer exists');

  server.close();
} catch (e) {
  console.error('Unexpected error:', e);
  failed++;
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);