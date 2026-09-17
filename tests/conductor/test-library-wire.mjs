// tests/conductor/test-library-wire.mjs — the Library wire the client consumes.
//
// Three contracts, in the order the client meets them:
//   1. the client hook maps the `library-changed` WS frame to its
//      `onLibraryChanged` option (and leaves unrelated frames alone);
//   2. `GET /api/library` returns exactly the shape `useLibraryData` renders
//      (`{ articles: [{docId,key,title,series,topics,publishedAt,checkedOut}],
//      categories: {series, topics} }`) — the server derives the taxonomy ∪,
//      the client only renders it;
//   3. `GET /api/library/:docId` (the row preview) returns `{ title, body }`,
//      and a shelf write pushes the `library-changed` frame name.
//
// The client half (§1) is driven through the real `src/ws/client.ts` module —
// bundled with esbuild and run against stub react + DOM globals, because this
// repo has no DOM test infra and the hook is the only place that mapping lives.
// Everything else follows tests/conductor/test-library-routes.mjs (built app via
// bootApp, tmpdir shelf fixtures, hand-rolled asserts).
// adr: adr/0007-git-orchestrator-dumb-host-side.md
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { bootApp, shutdown, api } from '../spike-a/lib/spike.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const assertDeep = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let ok = false;
    try { ok = fn(); } catch { ok = false; }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ============================================================================
// 1. The client hook maps library-changed → onLibraryChanged. Loaded from the
//    real source: esbuild bundles src/ws/client.ts with react + the toast
//    module stubbed, the effect runs against stub DOM globals, and a frame is
//    pushed through the fake socket — the same dispatch the browser performs.
// ============================================================================
const REACT_STUB = `
export const useRef = (v) => ({ current: v });
export const useState = (v) => [v, () => {}];
export const useEffect = (fn) => { fn(); };
export const useCallback = (fn) => fn;
export const useMemo = (fn) => fn();
`;
const TOAST_STUB = `export const showToast = () => {};`;

async function loadClientModule() {
  const result = await build({
    entryPoints: [join(REPO, 'src/ws/client.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{
      name: 'client-test-stubs',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\.\/utils\/toast$/ }, () => ({ path: 'toast', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path === 'react' ? REACT_STUB : TOAST_STUB,
          loader: 'js',
        }));
      },
    }],
  });
  const code = result.outputFiles[0].text;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; FakeWebSocket.instances.push(this); }
  send() {}
  close() {}
}

globalThis.WebSocket = FakeWebSocket;
globalThis.window = { location: { protocol: 'http:', host: 'localhost' } };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

const client = await loadClientModule();
let libraryFired = 0;
let documentsFired = 0;
client.useWebSocket({
  onLibraryChanged: () => { libraryFired++; },
  onDocumentsChanged: () => { documentsFired++; },
});
const sock = FakeWebSocket.instances[0];
assert(!!sock, 'client hook opened a socket from the real src/ws/client.ts module');

sock.onmessage({ data: JSON.stringify({ type: 'documents-changed' }) });
assert(documentsFired === 1 && libraryFired === 0,
  'client: documents-changed fires onDocumentsChanged only (library untouched)');

sock.onmessage({ data: JSON.stringify({ type: 'library-changed' }) });
assert(libraryFired === 1, 'client: library-changed fires onLibraryChanged');
assert(documentsFired === 1, 'client: library-changed leaves onDocumentsChanged alone');

sock.onmessage({ data: JSON.stringify({ type: 'library-changed' }) });
assert(libraryFired === 2, 'client: every library-changed frame fires onLibraryChanged');

// ============================================================================
// 2. GET /api/library — the payload useLibraryData renders (articles + the
//    server-derived categories). Boot the real app, seed a shelf.
// ============================================================================
const app = await bootApp({ port: await freePort() });
const libDir = join(app.home, 'library');

const DOC_A = 'cb12af51'; const KEY_A = '35845f18-1111-4222-8333-444455556666/cb12af51';
const DOC_B = 'aa11bb22'; const KEY_B = '35845f18-1111-4222-8333-444455556666/aa11bb22';
const rawA = `---\ndocId: ${DOC_A}\ntitle: First Article\nseries: HG\ntopics:\n  - nutrition\n  - sleep\nreview:\n  published:\n    at: "2026-02-03T00:00:00.000Z"\n---\n\nFirst article body.\n\nSecond paragraph.\n`;
const rawB = `---\ndocId: ${DOC_B}\ntitle: Second Article\npublishedOn: "2026-03-04"\n---\n\nSecond article body.\n`;

mkdirSync(libDir, { recursive: true });
writeFileSync(join(libDir, `${DOC_A}.md`), rawA);
writeFileSync(join(libDir, `${DOC_B}.md`), rawB);
writeFileSync(join(libDir, 'index.json'), JSON.stringify({ [DOC_A]: KEY_A, [DOC_B]: KEY_B }) + '\n');
writeFileSync(join(libDir, 'taxonomy.json'), JSON.stringify({ series: ['HG', 'WILD'], topics: ['nutrition', 'recovery'] }));

{
  const res = await api(app, 'GET', '/api/library');
  const body = await res.json();
  assert(res.status === 200, `GET /api/library → 200 (got ${res.status})`);
  assertDeep(Object.keys(body).sort(), ['articles', 'categories'],
    'library payload: exactly { articles, categories }');
  assert(Array.isArray(body.articles) && body.articles.length === 2,
    `library payload: one entry per mirror (got ${body.articles?.length})`);

  const a = body.articles.find((x) => x.docId === DOC_A);
  const b = body.articles.find((x) => x.docId === DOC_B);
  assertDeep(Object.keys(a ?? {}).sort(), ['checkedOut', 'docId', 'key', 'publishedAt', 'series', 'title', 'topics'],
    'library payload: article carries exactly the fields the client renders');
  assert(a?.title === 'First Article' && a?.series === 'HG', 'library payload: title + series as served');
  assertDeep(a?.topics, ['nutrition', 'sleep'], 'library payload: topics are the row tags');
  assert(a?.key === KEY_A && a?.publishedAt === '2026-02-03T00:00:00.000Z',
    'library payload: key + publishedAt as served');
  assert(b?.series === null && b?.key === KEY_B, 'library payload: unfiled article carries null series');

  assertDeep(Object.keys(body.categories).sort(), ['series', 'topics'],
    'library payload: categories is exactly { series, topics }');
  assertDeep(body.categories.series, ['HG', 'WILD'],
    'library payload: categories.series = manifest ∪ mirror values (server-derived — the client renders it)');
  assertDeep(body.categories.topics, ['nutrition', 'recovery', 'sleep'],
    'library payload: categories.topics = manifest ∪ mirror values');
}

// ============================================================================
// 3. GET /api/library/:docId — the row preview the client renders in a <pre>.
// ============================================================================
{
  const res = await api(app, 'GET', `/api/library/${DOC_A}`);
  const body = await res.json();
  assert(res.status === 200, `GET /api/library/:docId → 200 (got ${res.status})`);
  assertDeep(Object.keys(body).sort(), ['body', 'title'], 'preview payload: exactly { title, body }');
  assert(body.title === 'First Article', `preview payload: title from the mirror head (got ${body.title})`);
  assert(body.body.includes('First article body.') && !body.body.includes('docId:'),
    'preview payload: body is the matter-stripped markdown');
}

// ============================================================================
// 4. The shelf pushes `library-changed` — the name §1's mapping keys on.
// ============================================================================
{
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
  const msgs = [];
  ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
  });
  const before = msgs.length;
  writeFileSync(join(libDir, 'dd44ee55.md'), `---\ndocId: dd44ee55\ntitle: Watcher Article\n---\n\nWatcher body.\n`);
  assert(await waitFor(() => msgs.slice(before).some((m) => m.type === 'library-changed')),
    'shelf write pushes library-changed (the frame name the client dispatches on)');
  assert(!msgs.slice(before).some((m) => m.type === 'library_changed' || m.type === 'library-updated'),
    'shelf write pushes no near-miss frame name');
  ws.close();
}

await shutdown(app);
console.log(failed ? `test-library-wire: ${failed} FAIL(s)` : 'test-library-wire: PASS');
process.exit(failed ? 1 : 0);
