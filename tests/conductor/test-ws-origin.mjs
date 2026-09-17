// tests/conductor/test-ws-origin.mjs — WS upgrade origin allowlist (M4b).
import WebSocket from 'ws';
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

async function wsProbe(port, origin, bearer) {
  return new Promise((resolve) => {
    const opts = { headers: {} };
    if (origin) opts.headers.origin = origin;
    if (bearer) opts.headers.authorization = `Bearer ${bearer}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
    const done = (ok) => { try { ws.close(); } catch { /* ignore */ } resolve(ok); };
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    setTimeout(() => done(false), 3000);
  });
}

// Boot A: no site origin (dev) — localhost origin opens, site origin refused.
delete process.env.WRITER1_SITE_URL; delete process.env.OW_ORIGIN;
const { bootApp, shutdown } = await import('../spike-a/lib/spike.mjs');
const a = await bootApp({ port: 5097, bearer: undefined });
assert((await wsProbe(5097, 'http://localhost:5097')) === true, 'dev: localhost origin opens');
assert((await wsProbe(5097, 'https://192.0.2.10')) === false, 'dev: site origin rejected');

// Boot B: site origin configured — exact origin opens, foreign still closed.
process.env.WRITER1_SITE_URL = 'https://192.0.2.10';
const b = await bootApp({ port: 5096, bearer: undefined });
assert((await wsProbe(5096, 'https://192.0.2.10')) === true, 'prod: exact site origin opens');
assert((await wsProbe(5096, 'https://evil.example')) === false, 'prod: foreign origin rejected');
assert((await wsProbe(5096, 'http://localhost:5096')) === true, 'prod: loopback origin still opens');
delete process.env.WRITER1_SITE_URL;
await shutdown(a); await shutdown(b);
console.log(failed ? `test-ws-origin: ${failed} FAILURES` : 'test-ws-origin: all ok');
process.exit(failed ? 1 : 0);
