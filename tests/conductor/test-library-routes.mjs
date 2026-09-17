// Task 4 — the library shelf: list/read/adopt/restore routes, the app-side
// check-out stamp, the read-only write guard, and the library watcher.
// Real HTTP against the built app (bootApp child) + a parent-side dist import
// for the no-shelf shape. Style: tests/conductor/test-review-gate.mjs /
// test-submit-gate.mjs (tmpdir OW_HOME, hand-rolled asserts).
// adr: adr/0004-active-doc-watcher.md, adr/0007-git-orchestrator-dumb-host-side.md
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import matter from 'gray-matter';
import WebSocket from 'ws';
import { bootApp, shutdown, api } from '../spike-a/lib/spike.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// Parent-side home (no library dir ever created here) for the direct
// dist/server import — the "librarian has not run yet" unit shape.
const PARENT_HOME = join(tmpdir(), `lib-routes-nodir-${Date.now()}`);
process.env.OW_HOME = PARENT_HOME;
mkdirSync(PARENT_HOME, { recursive: true });

const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const assertDeep = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
const getJson = (res) => res.json().catch(() => ({}));

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

/** The librarian's pure fs reconciliation, built on demand. Reused to simulate
 *  the re-seed after a restore (the shelf is repopulated from the library). */
async function loadSyncDeskMirror() {
  const distPath = fileURLToPath(new URL('../../dist-orchestrator/orchestrator/desk-mirror.js', import.meta.url));
  if (!existsSync(distPath)) {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'ignore' });
  }
  return (await import(pathToFileURL(distPath).href)).syncDeskMirror;
}

// ============================================================================
// 0. No shelf yet (librarian has not run) — the derivation is empty, never throws.
// ============================================================================
assertDeep(documents.listLibraryDocs(), { articles: [], categories: { series: [], topics: [] } },
  'listLibraryDocs: no library dir → empty shape (never throws)');
assert(documents.readLibraryKey('---\ntitle: x\n---\n\nbody\n') === null,
  'readLibraryKey: null when there is no library stamp');
assert(documents.readLibraryKey('---\nlibrary:\n  key: no-slash\n---\n\nbody\n') === null,
  'readLibraryKey: null when the key carries no "/"');
assert(documents.readLibraryKey('---\nlibrary:\n  key: ""\n---\n\nbody\n') === null,
  'readLibraryKey: null when the key is empty');
assert(documents.readLibraryKey('---\nlibrary:\n  key: w-1/abc12345\n---\n\nbody\n') === 'w-1/abc12345',
  'readLibraryKey: reads owner/docId key off a desk doc');

// ============================================================================
// Boot the real app (its own isolated home), then seed the shelf.
// ============================================================================
const app = await bootApp({ port: await freePort() });
const libDir = join(app.home, 'library');

const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
const wsMsgs = [];
ws.on('message', (raw) => { try { wsMsgs.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
  ws.once('open', () => { clearTimeout(t); resolve(); });
});

// Empty shape over HTTP before anything is seeded (librarian has not run).
{
  const res = await api(app, 'GET', '/api/library');
  const body = await getJson(res);
  assert(res.status === 200, `GET /api/library → 200 (got ${res.status})`);
  assertDeep(body, { articles: [], categories: { series: [], topics: [] } },
    'GET /api/library on a fresh home → empty shape (librarian has not run)');
}

// A realistic desk holds other docs besides the adopted one — restore's delete
// refuses to empty the desk (deleteDocument's "only document" guard), so give
// the desk a starter doc before adopting.
{
  const res = await api(app, 'POST', '/api/documents', { title: 'Starter Notes' });
  assert(res.status === 200, `desk seeded with a starter doc (got ${res.status})`);
}

// ---- Shelf fixtures: two merged articles (one filed, one unfiled), one mirror
// ---- absent from the identity index, plus the taxonomy manifest.
const DOC_A = 'cb12af51'; const KEY_A = '35845f18-1111-4222-8333-444455556666/cb12af51';
const DOC_B = 'aa11bb22'; const KEY_B = '35845f18-1111-4222-8333-444455556666/aa11bb22';
const DOC_C = 'cc33dd44';   // mirror present, absent from index.json
const DOC_MISSING = 'ffffffff';

const rawA = `---\ndocId: ${DOC_A}\ntitle: First Article\nseries: HG\ntopics:\n  - nutrition\n  - sleep\npublishedOn: "2026-01-02"\nupdatedOn: "2026-02-03"\nreview:\n  published:\n    at: "2026-02-03T00:00:00.000Z"\n    pr: null\n    sha: abc123\nprovenance:\n  - agentSessionId: seed-session\n    model: seed-model\n---\n\nFirst article body.\n\nSecond paragraph.\n`;
const rawB = `---\ndocId: ${DOC_B}\ntitle: Second Article\npublishedOn: "2026-03-04"\n---\n\nSecond article body.\n`;
const rawC = `---\ndocId: ${DOC_C}\ntitle: Third Article\n---\n\nThird article body.\n`;
const taxonomyRaw = JSON.stringify({ series: ['HG', 'WILD'], topics: ['nutrition', 'recovery'] });

mkdirSync(libDir, { recursive: true });
writeFileSync(join(libDir, `${DOC_A}.md`), rawA);
writeFileSync(join(libDir, `${DOC_B}.md`), rawB);
writeFileSync(join(libDir, `${DOC_C}.md`), rawC);
writeFileSync(join(libDir, 'index.json'), JSON.stringify({ [DOC_A]: KEY_A, [DOC_B]: KEY_B }) + '\n');
writeFileSync(join(libDir, 'taxonomy.json'), taxonomyRaw);

// ============================================================================
// 1. GET /api/library — articles derived from mirror frontmatter, keys from
//    the index, categories = taxonomy manifest ∪ observed frontmatter values.
// ============================================================================
{
  const res = await api(app, 'GET', '/api/library');
  const body = await getJson(res);
  assert(res.status === 200, `GET /api/library (seeded) → 200 (got ${res.status})`);
  assert(Array.isArray(body.articles) && body.articles.length === 3,
    `GET /api/library lists every mirror (got ${body.articles?.length})`);

  const a = body.articles.find((x) => x.docId === DOC_A);
  const b = body.articles.find((x) => x.docId === DOC_B);
  const c = body.articles.find((x) => x.docId === DOC_C);
  assert(a?.title === 'First Article' && a?.series === 'HG', 'library: filed article carries title + series');
  assertDeep(a?.topics, ['nutrition', 'sleep'], 'library: filed article carries topics');
  assert(a?.publishedAt === '2026-02-03T00:00:00.000Z', `library: publishedAt from review.published.at (got ${a?.publishedAt})`);
  assert(a?.key === KEY_A, `library: key resolved from index.json (got ${a?.key})`);
  assert(b?.series === null, `library: unfiled article has null series (got ${b?.series})`);
  assertDeep(b?.topics, [], 'library: unfiled article has no topics');
  assert(b?.publishedAt === '2026-03-04', `library: publishedAt falls back to publishedOn (got ${b?.publishedAt})`);
  assert(c?.key === null, `library: mirror absent from the index → null key (got ${c?.key})`);
  assertDeep(body.categories.series, ['HG', 'WILD'], 'library: categories.series = manifest ∪ frontmatter values');
  assertDeep(body.categories.topics, ['nutrition', 'recovery', 'sleep'], 'library: categories.topics = manifest ∪ frontmatter values');
}

// ============================================================================
// 2. GET /api/library/:docId — mirror head title + matter-stripped body.
// ============================================================================
{
  const res = await api(app, 'GET', `/api/library/${DOC_A}`);
  const body = await getJson(res);
  assert(res.status === 200, `GET /api/library/:docId → 200 (got ${res.status})`);
  assert(body.title === 'First Article', `library read: title from mirror frontmatter (got ${body.title})`);
  assert(typeof body.body === 'string' && body.body.includes('First article body.') && body.body.includes('Second paragraph.'),
    'library read: body is the matter-stripped markdown');
  assert(!body.body.includes('docId:'), 'library read: body carries no frontmatter');

  const missing = await api(app, 'GET', `/api/library/${DOC_MISSING}`);
  assert(missing.status === 404, `GET /api/library/:docId (missing) → 404 (got ${missing.status})`);

  // A docId is one shelf filename segment — a traversal spelling is refused
  // outright (it becomes a file path server-side), never read.
  const traversal = await api(app, 'GET', '/api/library/..%2f..%2fetc%2fpasswd');
  assert(traversal.status === 400, `GET /api/library/:docId (traversal) → 400 (got ${traversal.status})`);
}

// ============================================================================
// 3. Adopt — the check-out: mirror → desk doc, stamped with the library key.
// ============================================================================
const mirrorAPath = join(libDir, `${DOC_A}.md`);
const mirrorAContent = matter(readFileSync(mirrorAPath, 'utf-8')).content;
{
  const res = await api(app, 'POST', '/api/library/adopt', { docId: DOC_A });
  const body = await getJson(res);
  assert(res.status === 200, `POST /api/library/adopt → 200 (got ${res.status} ${JSON.stringify(body)})`);
  assert(body.docId === DOC_A && body.libraryKey === KEY_A, 'adopt: response carries the library docId + key');

  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  const adopted = docs.find((d) => d.docId === DOC_A);
  assert(!!adopted, 'adopt: doc appears in /api/documents');
  assert(adopted?.libraryKey === KEY_A, `adopt: DocumentInfo.libraryKey is the index key (got ${adopted?.libraryKey})`);
  assert(existsSync(mirrorAPath), 'adopt: shelf mirror stays (the catalog row remains)');
  assert(readFileSync(mirrorAPath, 'utf-8') === rawA, 'adopt: shelf mirror byte-pristine (desk copy cleaned, not the shelf)');
  const libAfterAdopt = await getJson(await api(app, 'GET', '/api/library'));
  const rowA = libAfterAdopt.articles.find((a) => a.docId === DOC_A);
  assert(!!rowA, 'adopt: the catalog row is still listed');
  assert(rowA?.checkedOut === true, 'adopt: row chipped checked-out (the book is out)');

  const deskPath = join(app.home, 'profiles', 'Default', adopted.filename);
  const deskRaw = readFileSync(deskPath, 'utf-8');
  const desk = matter(deskRaw);
  assert(desk.data.docId === DOC_A, `adopt: desk doc reuses the library docId (got ${desk.data.docId})`);
  assert(desk.data.library?.key === KEY_A, `adopt: frontmatter stamped library.key (got ${JSON.stringify(desk.data.library)})`);
  assert(desk.data.review?.published?.at === '2026-02-03T00:00:00.000Z', 'adopt: review.published preserved');
  assert(desk.data.review?.published?.sha === 'abc123', 'adopt: review.published.sha preserved (ship-time base check)');
  assert(Array.isArray(desk.data.provenance) && desk.data.provenance.length === 1,
    'adopt: provenance records preserved');
  assert(desk.data.title === 'First Article' && desk.data.series === 'HG', 'adopt: other frontmatter spread-preserved');
  assert(desk.content === mirrorAContent, 'adopt: body byte-exact vs the mirror');
}

// ============================================================================
// 3b. Adopt cleans writer-session gate stamps off the desk copy (live leak,
//     2026-09-15): a re-adopted copy inherited the corpus-carried
//     review.submitted and showed a phantom "Sent for review". Cycle stamps
//     (submitted/pr/returned/conflict) and any foreign library block are
//     stripped; review.published rides through (the ship-time base check's
//     convergence sha); the adopter's own library stamp is applied.
// ============================================================================
{
  const DOC_D = 'dd44ee55'; const KEY_D = '35845f18-1111-4222-8333-444455556666/dd44ee55';
  const rawD = `---\ndocId: ${DOC_D}\ntitle: Fourth Article\nreview:\n  submitted:\n    at: "2026-09-15T06:52:54.084Z"\n    sessionId: user\n    model: user\n  pr:\n    at: "2026-09-15T06:53:00.000Z"\n    url: "https://g/11"\n    cycle: 1\n  returned:\n    at: "2026-09-12T00:00:00.000Z"\n    pr: 9\n  conflict:\n    at: "2026-09-13T00:00:00.000Z"\n    pr: 9\n  published:\n    at: "2026-02-03T00:00:00.000Z"\n    pr: null\n    sha: abc123\nlibrary:\n  key: someone-else/dd44ee55\n  adoptedAt: "2026-09-01T00:00:00.000Z"\npublishedOn: "2026-01-02"\n---\n\nFourth article body.\n`;
  const mirrorD = join(libDir, `${DOC_D}.md`);
  writeFileSync(mirrorD, rawD);
  const indexPath = join(libDir, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  index[DOC_D] = KEY_D;
  writeFileSync(indexPath, JSON.stringify(index) + '\n');

  const res = await api(app, 'POST', '/api/library/adopt', { docId: DOC_D });
  const body = await getJson(res);
  assert(res.status === 200, `adopt dirty mirror → 200 (got ${res.status} ${JSON.stringify(body)})`);
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  const adoptedD = docs.find((d) => d.docId === DOC_D);
  assert(!!adoptedD, 'adopt D: doc appears in /api/documents');
  const deskDPath = join(app.home, 'profiles', 'Default', adoptedD.filename);
  const deskD = matter(readFileSync(deskDPath, 'utf-8'));
  assert(deskD.data.review?.submitted === undefined, 'adopt: review.submitted stripped (the phantom "Sent for review")');
  assert(deskD.data.review?.pr === undefined, 'adopt: review.pr stripped');
  assert(deskD.data.review?.returned === undefined, 'adopt: review.returned stripped');
  assert(deskD.data.review?.conflict === undefined, 'adopt: review.conflict stripped');
  assert(deskD.data.review?.published?.sha === 'abc123', 'adopt: review.published rides through (base-check sha)');
  assert(deskD.data.library?.key === KEY_D, `adopt: library re-stamped with the index key (got ${JSON.stringify(deskD.data.library)})`);
  assert(deskD.content === matter(rawD).content, 'adopt (dirty mirror): body byte-exact vs the mirror');
  assert(existsSync(mirrorD), 'adopt D: shelf mirror stays (adopt cleans the desk copy, never the shelf)');
}

// ============================================================================
// 4. Adopt refusals — twice (already checked out), missing, and no index entry.
// ============================================================================
{
  const twice = await api(app, 'POST', '/api/library/adopt', { docId: DOC_A });
  assert(twice.status === 409, `adopt twice → 409 (got ${twice.status})`);
  const missing = await api(app, 'POST', '/api/library/adopt', { docId: DOC_MISSING });
  assert(missing.status === 404, `adopt missing → 404 (got ${missing.status})`);
  const noIndex = await api(app, 'POST', '/api/library/adopt', { docId: DOC_C });
  const noIndexBody = await getJson(noIndex);
  assert(noIndex.status === 409, `adopt without an index entry → 409 (got ${noIndex.status} ${JSON.stringify(noIndexBody)})`);
  assert(existsSync(join(libDir, `${DOC_C}.md`)), 'refused adopt leaves the mirror on the shelf');
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  assert(!docs.some((d) => d.docId === DOC_C), 'refused adopt creates no desk doc');
}

// ============================================================================
// 4b. Adopting your OWN merged article → 409, shelf untouched. The author's
//     original desk doc carries no library.key stamp, so the librarian's skip
//     rule never applies to it and the merged article is ALWAYS mirrored back
//     onto the author's own shelf — the mirror is present exactly when the
//     already-adopted 409 used to be skipped (it sat inside the mirror-absent
//     branch). A second desk doc with the same docId would make first-match-
//     wins filenameByDocId able to delete the writer's ORIGINAL working doc on
//     restore, and both docs would resolve to one key → ship-time conflict.
// ============================================================================
{
  const DOC_SELF = 'bb00cc99'; const KEY_SELF = '35845f18-1111-4222-8333-444455556666/bb00cc99';
  const mirrorSelf = join(libDir, `${DOC_SELF}.md`);
  writeFileSync(mirrorSelf, `---\ndocId: ${DOC_SELF}\ntitle: My Own Article\n---\n\nMy own merged body.\n`);
  const indexPath = join(libDir, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  index[DOC_SELF] = KEY_SELF;
  writeFileSync(indexPath, JSON.stringify(index) + '\n');

  // The author's own working doc: same docId as the mirror, no library.key
  // stamp (a merged original never carries one), on the desk next to the shelf.
  writeFileSync(join(app.home, 'profiles', 'Default', 'My Own Article.md'),
    `---\ndocId: ${DOC_SELF}\ntitle: My Own Article\n---\n\nMy own merged body.\n`);

  const res = await api(app, 'POST', '/api/library/adopt', { docId: DOC_SELF });
  const body = await getJson(res);
  assert(res.status === 409, `adopt of one's own merged article (mirror present) → 409 (got ${res.status} ${JSON.stringify(body)})`);
  assert(/already adopted/.test(body.error ?? ''), `refusal names the real reason (got ${JSON.stringify(body.error)})`);
  assert(existsSync(mirrorSelf), 'refused adopt leaves the shelf mirror untouched');
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  assert(docs.filter((d) => d.docId === DOC_SELF).length === 1, `no duplicate desk doc with the docId (got ${docs.filter((d) => d.docId === DOC_SELF).length})`);
  assert(!docs.some((d) => d.libraryKey === KEY_SELF), 'refused adopt stamps no library key on the original');
}

// ============================================================================
// 5. Restore — the desk doc is discarded (guarded delete path) and the key is
//    released; the shelf mirror never left, so the row just un-chips.
// ============================================================================
{
  // Let any watcher burst settle so the snapshot below is not satisfied by a
  // stale library-changed.
  await new Promise((r) => setTimeout(r, 250));
  const before = wsMsgs.length;
  const res = await api(app, 'POST', `/api/library/${DOC_A}/restore`);
  const body = await getJson(res);
  assert(res.status === 200, `restore → 200 (got ${res.status} ${JSON.stringify(body)})`);
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  assert(!docs.some((d) => d.docId === DOC_A), 'restore: desk doc removed');
  assert(await waitFor(() => wsMsgs.slice(before).some((m) => m.type === 'library-changed')),
    'restore: library-changed broadcast fired');
  assert(await waitFor(() => wsMsgs.slice(before).some((m) => m.type === 'documents-changed')),
    'restore: documents-changed broadcast fired');

  assert(existsSync(mirrorAPath), 'restore: shelf mirror never left (no re-seed needed)');
  const syncDeskMirror = await loadSyncDeskMirror();
  const result = syncDeskMirror(app.home, [
    { key: KEY_A, docId: DOC_A, content: rawA },
    { key: KEY_B, docId: DOC_B, content: rawB },
  ], taxonomyRaw, new Set());
  assert(!result.seeded.includes(DOC_A), 'restore: mirror already current — the sync re-seeds nothing');
  const lib = await getJson(await api(app, 'GET', '/api/library'));
  const rowBack = lib.articles.find((a) => a.docId === DOC_A);
  assert(!!rowBack, 'restore: article still listed (the catalog row un-chips, not disappears)');
  assert(rowBack?.checkedOut === false, 'restore: row un-chipped (key released)');
  // The released key is adoptable again: a fresh check-out works off the live mirror.
  const reAdopt = await api(app, 'POST', '/api/library/adopt', { docId: DOC_A });
  assert(reAdopt.status === 200, `restore: released key adopts again (got ${reAdopt.status})`);
}

// ============================================================================
// 6. Restore refused while the desk copy's review is in flight (the same guard
//    the delete route uses).
// ============================================================================
{
  const adoptB = await api(app, 'POST', '/api/library/adopt', { docId: DOC_B });
  assert(adoptB.status === 200, `adopt B → 200 (got ${adoptB.status})`);
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  const adoptedB = docs.find((d) => d.docId === DOC_B);
  const deskBPath = join(app.home, 'profiles', 'Default', adoptedB.filename);
  const bm = matter(readFileSync(deskBPath, 'utf-8'));
  bm.data.review = { submitted: { at: '2026-09-11T09:00:00.000Z' } };
  writeFileSync(deskBPath, matter.stringify(bm.content, bm.data));

  const res = await api(app, 'POST', `/api/library/${DOC_B}/restore`);
  const body = await getJson(res);
  assert(res.status === 409, `restore refused while review-in-flight → 409 (got ${res.status} ${JSON.stringify(body)})`);
  assert(existsSync(deskBPath), 'restore refusal: desk doc untouched');
}

// ============================================================================
// 7. Library watcher — a mirror write on the shelf broadcasts library-changed.
// ============================================================================
{
  const before = wsMsgs.length;
  writeFileSync(join(libDir, 'dd44ee55.md'), '---\ndocId: dd44ee55\ntitle: Watcher Article\n---\n\nWatcher body.\n');
  assert(await waitFor(() => wsMsgs.slice(before).some((m) => m.type === 'library-changed'), 5000),
    'library watcher: library-changed broadcast on a mirror write');
}

// ============================================================================
// 8. Write guard — a path trick into the shelf is refused and nothing is
//    written. Every app-side write route is covered by the one chokepoint.
// ============================================================================
{
  const libTarget = join(libDir, 'dd44ee55.md');
  const before = readFileSync(libTarget, 'utf-8');
  const open = await api(app, 'POST', '/api/documents/open', { path: libTarget });
  assert(open.status === 200, `write guard: a library file can be opened as an external doc (got ${open.status})`);
  const res = await api(app, 'POST', '/api/save');
  const body = await getJson(res);
  assert(res.status >= 400 && res.status < 500,
    `write guard: POST /api/save into the library area → 4xx (got ${res.status} ${JSON.stringify(body)})`);
  assert(/read-only/.test(body.error ?? ''), `write guard: refusal names the read-only area (got ${JSON.stringify(body.error)})`);
  await new Promise((r) => setTimeout(r, 250));
  assert(readFileSync(libTarget, 'utf-8') === before, 'write guard: library file bytes unchanged (no write landed)');

  // The other doc-write entry points refuse the shelf too — rename, archive,
  // delete, and create-at-a-caller-supplied-path.
  const rename = await api(app, 'PUT', `/api/documents/${encodeURIComponent(libTarget)}`, { title: 'Hijacked' });
  assert(rename.status >= 400, `write guard: rename into the shelf → 4xx (got ${rename.status})`);
  const archive = await api(app, 'POST', `/api/documents/${encodeURIComponent(libTarget)}/archive`);
  assert(archive.status >= 400, `write guard: archive into the shelf → 4xx (got ${archive.status})`);
  const del = await api(app, 'DELETE', `/api/documents/${encodeURIComponent(libTarget)}`);
  assert(del.status >= 400, `write guard: delete from the shelf → 4xx (got ${del.status})`);
  const create = await api(app, 'POST', '/api/documents', { title: 'Sneak', path: join(libDir, 'sneak.md') });
  assert(create.status >= 400, `write guard: create at a shelf path → 4xx (got ${create.status})`);
  assert(!existsSync(join(libDir, 'sneak.md')), 'write guard: no file created in the shelf');
  assert(readFileSync(libTarget, 'utf-8') === before, 'write guard: library file bytes still unchanged');
}

// ============================================================================
// 9. The remaining shelf-write routes are guarded too: the WS `pending-resolved`
//    race path (client-supplied filename → stripPendingAttrsFromFile) and
//    batchResolve's absolute-path branch. Both target a NON-active mirror —
//    the active doc after section 8 is dd44ee55.md.
// ============================================================================
{
  const raced = join(libDir, 'ee55ff66.md');
  writeFileSync(raced, '---\ndocId: ee55ff66\ntitle: Race Article\n---\n\nRace body.\n');
  await new Promise((r) => setTimeout(r, 200)); // let the shelf watcher settle
  const before = readFileSync(raced, 'utf-8');

  ws.send(JSON.stringify({ type: 'pending-resolved', filename: raced, action: 'accept' }));
  await new Promise((r) => setTimeout(r, 400));
  assert(readFileSync(raced, 'utf-8') === before, 'write guard: WS pending-resolved left the shelf mirror untouched');
  assert(app.child.exitCode === null, 'write guard: server survived the pending-resolved shelf write');

  const batch = await api(app, 'POST', '/api/documents/batch-resolve', { filenames: [raced], action: 'accept' });
  const batchBody = await getJson(batch);
  assert(batch.status >= 400 && batch.status < 500,
    `write guard: batchResolve with a shelf path → 4xx (got ${batch.status} ${JSON.stringify(batchBody)})`);
  assert(/read-only/.test(batchBody.error ?? ''), 'write guard: batchResolve refusal names the read-only area');
  await new Promise((r) => setTimeout(r, 250));
  assert(readFileSync(raced, 'utf-8') === before, 'write guard: batchResolve left the shelf mirror untouched');
  assert(app.child.exitCode === null, 'write guard: server survived the batchResolve shelf write');
}

// ============================================================================
// 10. Crash-safety (the debounced-save timer). The shelf mirror is the ACTIVE
//     doc here; the editor's doc-update → debouncedSave → timer → save() chain
//     would throw out of the timer callback — an uncaughtException, and
//     bin/server.ts answers those with process.exit(1), so systemd would
//     crashloop. The refusal must be contained and surfaced instead.
// ============================================================================
{
  const libTarget = join(libDir, 'dd44ee55.md');
  assert(app.child.exitCode === null, 'crash-safety: server alive before the edit');
  const before = readFileSync(libTarget, 'utf-8');

  const open = await api(app, 'POST', '/api/documents/open', { path: libTarget });
  assert(open.status === 200 || open.status === 400,
    `crash-safety: re-opening the shelf mirror is a no-op or a refusal, never a crash (got ${open.status})`);
  const docs = await getJson(await api(app, 'GET', '/api/documents'));
  const activeDoc = docs.find((d) => d.isActive);
  assert(activeDoc?.path === libTarget,
    `crash-safety: the shelf mirror is the active doc (got ${activeDoc?.path})`);

  const msgsBefore = wsMsgs.length;
  // 1) Exactly what the editor sends on a keystroke (unversioned, no filename
  //    → the active-doc branch → updateDocument + debouncedSave).
  ws.send(JSON.stringify({
    type: 'doc-update',
    document: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'aaaa0001' }, content: [{ type: 'text', text: 'typed into a shelf file' }] }] },
  }));
  // 2) The title bar's path, which reaches debouncedSave unconditionally —
  //    so the timer is exercised even if the agent-lock gate ate the first.
  ws.send(JSON.stringify({ type: 'title-update', title: 'Shelf Article' }));
  await new Promise((r) => setTimeout(r, 1500)); // > SAVE_DEBOUNCE_MS (500)

  assert(app.child.exitCode === null,
    `crash-safety: the debounced save did NOT exit the process (exitCode=${app.child.exitCode})`);
  let alive = null;
  try { alive = await api(app, 'GET', '/api/library'); } catch { /* crashed */ }
  assert(alive !== null && alive.status === 200,
    `crash-safety: the server is still serving (got ${alive ? alive.status : 'connection refused'})`);
  assert(readFileSync(libTarget, 'utf-8') === before, 'crash-safety: the shelf mirror was not written');
  assert(wsMsgs.slice(msgsBefore).some((m) => m.type === 'toast' && m.kind === 'error'),
    'crash-safety: the refusal was surfaced to the client (error toast)');
}

// ============================================================================
// 11. The two remaining write-by-explicit-path entry points, guarded at the
//     same chokepoint. Parent-side dist imports (their own empty OW_HOME), so
//     no app state is touched: createDocumentFile's explicit-`path` branch
//     (reachable from MCP create_document) and resolveOverlayEntry's
//     non-active branch (a shelf file opened once is a docId → shelf path, so
//     a per-node resolve would rewrite the mirror).
// ============================================================================
{
  const hijack = join(PARENT_HOME, 'library', 'aaaa1111.md');
  let createRefused = null;
  try { documents.createDocumentFile('Shelf Hijack', hijack); } catch (err) { createRefused = err; }
  assert(createRefused?.code === 'ELIBRARYREADONLY',
    'write guard: createDocumentFile refuses an explicit shelf path');
  assert(!existsSync(hijack), 'write guard: createDocumentFile wrote nothing into the shelf');

  const mirror = join(PARENT_HOME, 'library', 'ffffffff.md');
  mkdirSync(join(PARENT_HOME, 'library'), { recursive: true });
  writeFileSync(mirror, '---\ndocId: ffffffff\ntitle: Guarded Mirror\n---\n\nGuarded body.\n');
  const stateMod = await import('../../dist/server/state.js');
  stateMod.registerExternalDoc(mirror); // an opened shelf file IS a registered doc
  const mirrorBefore = readFileSync(mirror, 'utf-8');
  let overlayRefused = null;
  try { documents.resolveOverlayEntry('ffffffff', 'abcd1234', 'accept'); } catch (err) { overlayRefused = err; }
  assert(overlayRefused?.code === 'ELIBRARYREADONLY',
    'write guard: resolveOverlayEntry refuses a shelf docId (non-active branch)');
  assert(readFileSync(mirror, 'utf-8') === mirrorBefore, 'write guard: resolveOverlayEntry left the shelf mirror untouched');
}

ws.close();
await shutdown(app);
rmSync(PARENT_HOME, { recursive: true, force: true });
console.log(failed ? `test-library-routes: ${failed} FAIL(s)` : 'test-library-routes: PASS');
process.exit(failed ? 1 : 0);
