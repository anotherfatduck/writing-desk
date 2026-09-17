// tests/conductor/test-site-gate.mjs — M4b patch #2: site allowlist on the
// HTTP Host gate + Origin/Referer CSRF gate; trust proxy resolution.
import http from 'node:http';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const gate = await import('../../dist/server/site-gate.js');

// --- unit: resolution + predicates ---
delete process.env.OW_ORIGIN; delete process.env.WRITER1_SITE_URL;
assert(gate.siteOrigins().length === 0, 'no allowlist by default');
assert(gate.shouldTrustProxy() === false, 'no trust proxy without site origin');
assert(gate.isAllowedHost('localhost:5051', 5051) === true, 'host gate: loopback unchanged');
assert(gate.isAllowedHost('evil.example', 5051) === false, 'host gate: non-loopback rejected (dev)');
assert(gate.isAllowedOrigin('http://localhost:5051', 5051) === true, 'origin gate: loopback (dev)');
assert(gate.isAllowedOrigin('https://192.0.2.10', 5051) === false, 'origin gate: site origin rejected (dev)');

process.env.WRITER1_SITE_URL = 'https://192.0.2.10';
assert(gate.siteOrigins()[0] === 'https://192.0.2.10', 'allowlist resolved from WRITER1_SITE_URL');
assert(gate.shouldTrustProxy() === true, 'trust proxy with site origin');
assert(gate.isAllowedHost('192.0.2.10', 5051) === true, 'host gate: site hostname allowed (port ignored)');
assert(gate.isAllowedHost('192.0.2.10:443', 5051) === true, 'host gate: site hostname with foreign port allowed');
assert(gate.isAllowedHost('evil.example', 5051) === false, 'host gate: other host still rejected');
assert(gate.isAllowedOrigin('https://192.0.2.10', 5051) === true, 'origin gate: exact site origin');
assert(gate.isAllowedOrigin('https://192.0.2.10:8443', 5051) === false, 'origin gate: exact match only (wrong port)');
assert(gate.isAllowedOrigin('https://evil.example', 5051) === false, 'origin gate: other origin rejected');

// HTTP integration: Host + Origin behind the real security gate.
process.env.WRITER1_SITE_URL = 'https://192.0.2.10';
const { bootApp, shutdown } = await import('../spike-a/lib/spike.mjs');
const inst = await bootApp({ port: 5098, bearer: undefined });
function req(method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 5098, method, path: '/api/profiles', headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    if (body) r.write(body); r.end();
  });
}
// Host gate: browser-style Host header names the site host.
{
  const code = await req('GET', { Host: '192.0.2.10' });
  assert(code !== 403, `Host gate allows site hostname (got ${code})`);
  const bad = await req('GET', { Host: 'evil.example' });
  assert(bad === 403, `Host gate rejects other hostnames (got ${bad})`);
}
// Origin gate on state-changing method: exact site origin allowed, others 403.
{
  const ok = await req('POST', { Host: '192.0.2.10', Origin: 'https://192.0.2.10', 'content-type': 'application/json' }, JSON.stringify({ name: 'gated' }));
  assert(ok !== 403, `origin gate allows exact site origin (got ${ok})`);
  const no = await req('POST', { Host: '192.0.2.10', Origin: 'https://evil.example', 'content-type': 'application/json' }, '{}');
  assert(no === 403, `origin gate rejects foreign origin (got ${no})`);
}
delete process.env.WRITER1_SITE_URL;
await shutdown(inst);
console.log(failed ? `test-site-gate: ${failed} FAILURES` : 'test-site-gate: all ok');
process.exit(failed ? 1 : 0);
