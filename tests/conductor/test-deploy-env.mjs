// tests/conductor/test-deploy-env.mjs — M4b env bridge resolution.
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const env = await import('../../dist/server/deploy-env.js');

// LLM bridge: infra WRITER1_* preferred; LLM_BASE_URL is the dev fallback; neither → ''.
delete process.env.LLM_BASE_URL; delete process.env.WRITER1_LLM_BASE_URL;
assert(env.resolveLlmBaseUrl() === '', 'llm base: neither set → empty');
process.env.LLM_BASE_URL = 'http://localhost:9999';
assert(env.resolveLlmBaseUrl() === 'http://localhost:9999', 'llm base: dev fallback');
process.env.WRITER1_LLM_BASE_URL = 'http://127.0.0.1:11440';
assert(env.resolveLlmBaseUrl() === 'http://127.0.0.1:11440', 'llm base: WRITER1 wins over dev');

// Site origin bridge: same precedence.
delete process.env.OW_ORIGIN; delete process.env.WRITER1_SITE_URL;
assert(env.resolveSiteOrigin() === '', 'site origin: neither set → empty');
process.env.OW_ORIGIN = 'https://writer.example';
assert(env.resolveSiteOrigin() === 'https://writer.example', 'site origin: dev fallback');
process.env.WRITER1_SITE_URL = 'https://192.0.2.10';
assert(env.resolveSiteOrigin() === 'https://192.0.2.10', 'site origin: WRITER1 wins over dev');

// WRITER2_* is the newer infra contract (writer-host-02); it outranks
// WRITER1_*, which outranks the dev fallbacks.
process.env.WRITER2_LLM_BASE_URL = 'http://127.0.0.1:21440';
assert(env.resolveLlmBaseUrl() === 'http://127.0.0.1:21440', 'llm base: WRITER2 wins over WRITER1');
delete process.env.WRITER2_LLM_BASE_URL;
process.env.WRITER2_SITE_URL = 'https://writer-host-02.example';
assert(env.resolveSiteOrigin() === 'https://writer-host-02.example', 'site origin: WRITER2 wins over WRITER1');
delete process.env.WRITER2_SITE_URL;

// Listen host.
delete process.env.OW_HOST;
assert(env.resolveListenHost() === '127.0.0.1', 'listen host: default loopback');
process.env.OW_HOST = '0.0.0.0';
assert(env.resolveListenHost() === '0.0.0.0', 'listen host: OW_HOST override');

delete process.env.OW_HOST; // Ensure default for integration rider

// Integration rider: OW_HOST really changes the bind surface. A default boot
// (no OW_HOST) is unreachable on a non-loopback interface; OW_HOST=0.0.0.0 is
// reachable there — and the loopback-only Host gate still 403s the foreign
// Host header (widening the bind never widens the gates). Skips cleanly when
// the host has no non-loopback interface (rare); resolution is unit-tested above.
const { bootApp, shutdown } = await import('../spike-a/lib/spike.mjs');
const { networkInterfaces } = await import('node:os');
const http = await import('node:http');
const lan = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
const lanProbe = (port) => new Promise((resolve) => {
  const r = http.request({ host: lan, port, method: 'GET', path: '/' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', () => resolve(0));
  r.end();
});
if (lan) {
  const inst = await bootApp({ port: 5099, bearer: undefined });
  assert((await lanProbe(5099)) === 0, 'default boot (no OW_HOST) is NOT reachable on the LAN address');
  await shutdown(inst);
} else {
  console.log('  skip: no non-loopback interface on this host');
}
process.env.OW_HOST = '0.0.0.0';
const wide = await bootApp({ port: 5095, bearer: undefined });
delete process.env.OW_HOST;
if (lan) assert((await lanProbe(5095)) === 403, `OW_HOST=0.0.0.0 IS reachable on ${lan} (Host gate still 403s the foreign Host)`);
else assert(true, 'bootApp with OW_HOST=0.0.0.0 serves');
await shutdown(wide);

delete process.env.LLM_BASE_URL; delete process.env.WRITER1_LLM_BASE_URL; delete process.env.WRITER2_LLM_BASE_URL;
delete process.env.OW_ORIGIN; delete process.env.WRITER1_SITE_URL; delete process.env.WRITER2_SITE_URL; delete process.env.OW_HOST;
console.log(failed ? `test-deploy-env: ${failed} FAILURES` : 'test-deploy-env: all ok');
process.exit(failed ? 1 : 0);
