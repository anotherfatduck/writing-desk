// The librarian (Task 3): pure fs reconciliation of a clone's library tree
// onto each desk's read-only shelf, plus the derived identity index. The pure
// parts need no git — the clone tree is built by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { syncDeskMirror, readLibraryFromClone } = await mod('desk-mirror');
const { bodyHashHex } = await mod('util');
const { readLibraryKey } = await mod('frontmatter');

// Fixture identities. A key is "<writerId>/<docId>" — the original-writer
// component lives ONLY in the derived index (a mirror file is just <docId>.md).
const aDocId = 'aaa11111';
const bDocId = 'bbbb2222';
const aKey = 'w-a/aaa11111';
const bKey = 'w-b/bbbb2222';

const articleRaw = (docId, body) => `---\ndocId: ${docId}\ntitle: T-${docId}\n---\n\n${body}\n`;

const aV1content = articleRaw(aDocId, 'alpha v1');
const aV2content = articleRaw(aDocId, 'alpha v2');
const bV1content = articleRaw(bDocId, 'beta v1');
const bV2content = articleRaw(bDocId, 'beta v2');
const aV1 = { key: aKey, docId: aDocId, content: aV1content };
const aV2 = { key: aKey, docId: aDocId, content: aV2content };
const bV1 = { key: bKey, docId: bDocId, content: bV1content };
const bV2 = { key: bKey, docId: bDocId, content: bV2content };
// A desk-side edit of the read-only copy: same docId, different body.
const modifiedBody = articleRaw(aDocId, 'dirtied on the desk');

/** A fresh desk root with shelf helpers (`mirror`/`read`/`write`). */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'orch-desk-'));
  const libDir = join(root, 'library');
  const mirror = (which) => join(libDir, (which === 'a' ? aDocId : bDocId) + '.md');
  const read = (p) => readFileSync(p, 'utf-8');
  const write = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
  return { root, libDir, mirror, read, write };
}

test('seed → update → checked-out row stays → delete → idempotent', () => {
  const { root, libDir, mirror, read } = fixtureRoot();
  const indexFile = join(libDir, 'index.json');

  // seed: two articles land on the shelf, pristine (no adoption stamp).
  let r = syncDeskMirror(root, [aV1, bV1], null, new Set());
  assert.deepEqual(r, { seeded: [aDocId, bDocId], updated: [], deleted: [] });
  assert.equal(read(mirror('a')), aV1content);        // byte-for-byte the repo content
  assert.equal(read(mirror('b')), bV1content);
  assert.equal(readLibraryKey(read(mirror('a'))), null);   // pristine — never stamped
  // index.json is the identity map only: docId → key
  assert.deepEqual(JSON.parse(read(indexFile)), { [aDocId]: aKey, [bDocId]: bKey });

  // checked-out catalog row: checkedOut = {a's key}. The mirror is NOT skipped —
  // the shelf row is the catalog entry: it exists while the book is out and
  // always shows the last-merged corpus version (never the desk draft).
  rmSync(mirror('a'));
  r = syncDeskMirror(root, [aV2, bV2], null, new Set([aKey]));
  assert.deepEqual(r.seeded, [aDocId]);               // a re-seeds even though checked out
  assert.equal(read(mirror('a')), aV2content);        // byte-for-byte the repo content
  assert.deepEqual(r.updated, [bDocId]);

  // the hold continues: both mirrors current → nothing to write.
  r = syncDeskMirror(root, [aV2, bV2], null, new Set([aKey]));
  assert.deepEqual(r, { seeded: [], updated: [], deleted: [] });

  // delete: b leaves the library → its mirror is retired, its identity dropped.
  r = syncDeskMirror(root, [aV2], null, new Set([aKey]));
  assert.deepEqual(r.deleted, [bDocId]);
  assert.deepEqual(JSON.parse(read(indexFile)), { [aDocId]: aKey });

  // idempotent: a converged shelf writes nothing (index byte-stable too).
  r = syncDeskMirror(root, [aV2], null, new Set());
  assert.deepEqual(r, { seeded: [], updated: [], deleted: [] });

  // taxonomy mirrored verbatim when present
  syncDeskMirror(root, [aV2], '{"series":["HG"]}', new Set());
  assert.equal(read(join(libDir, 'taxonomy.json')), '{"series":["HG"]}');
});

test('sweep exempts a checked-out docId whose article left the corpus', () => {
  const { root, mirror, read } = fixtureRoot();
  syncDeskMirror(root, [aV1], null, new Set());        // seed
  // a leaves the corpus while a desk doc still holds its key: the row stays
  // until the book comes back.
  let r = syncDeskMirror(root, [], null, new Set([aKey]));
  assert.deepEqual(r.deleted, []);
  assert.equal(existsSync(mirror('a')), true);
  // the hold ends → the sweep retires it on the next pass.
  r = syncDeskMirror(root, [], null, new Set());
  assert.deepEqual(r.deleted, [aDocId]);
  assert.equal(existsSync(mirror('a')), false);
});

test('repair: dirty mirror restores automatically; index follows the article set', () => {
  const { root, libDir, mirror, read, write } = fixtureRoot();
  syncDeskMirror(root, [aV1], null, new Set());        // seed
  write(mirror('a'), modifiedBody);                    // desk-side dirt on the read-only copy
  let r = syncDeskMirror(root, [aV1], null, new Set());
  assert.deepEqual(r.updated, [aDocId]);               // overwrite-from-library fires
  assert.equal(read(mirror('a')), aV1content);         // restored, byte-for-byte
  r = syncDeskMirror(root, [aV2], null, new Set());    // library-side change converges the mirror
  assert.deepEqual(r.updated, [aDocId]);
  // index drops a deleted article's identity
  r = syncDeskMirror(root, [], null, new Set());
  assert.deepEqual(r.deleted, [aDocId]);
  assert.deepEqual(JSON.parse(read(join(libDir, 'index.json'))), {});
});

test('frontmatter-only library edit converges the mirror (whole-file byte compare)', () => {
  const { root, mirror, read } = fixtureRoot();
  // Same body, different frontmatter — e.g. a gate edit to series/topics, or
  // merge-back's own frontmatter stamps landing on the merged article. A
  // body-hash compare would call this a no-op and leave the shelf stale, while
  // spec §3 renders folders/tags/publishedAt FROM the mirror's frontmatter and
  // the Global Constraint says a mirror is byte-for-byte the repo's article.md.
  const stampedV1 = `---\ndocId: ${aDocId}\ntitle: T-${aDocId}\nseries:\n  - HG\n---\n\nalpha v1\n`;
  assert.equal(bodyHashHex(stampedV1), bodyHashHex(aV1content));   // same body…
  syncDeskMirror(root, [aV1], null, new Set());                   // seed at v1
  const r = syncDeskMirror(root, [{ key: aKey, docId: aDocId, content: stampedV1 }], null, new Set());
  assert.deepEqual(r.updated, [aDocId]);                          // …the bytes moved → mirror follows
  assert.equal(read(mirror('a')), stampedV1);                     // byte-for-byte the repo content
});

test('readLibraryFromClone walks the clone mergeDir tree (articles + taxonomy)', async () => {
  const cloneDir = mkdtempSync(join(tmpdir(), 'orch-clone-'));
  const write = (rel, content) => {
    const p = join(cloneDir, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  write('articles/w-a/aaa11111/article.md', aV1content);
  write('articles/w-b/bbbb2222/article.md', bV1content);
  write('articles/README.md', 'not an article\n');   // a file, not <writer>/<doc>/article.md
  write('articles/taxonomy.json', '{"series":["HG"]}');

  const { articles, taxonomy } = await readLibraryFromClone(cloneDir, 'articles');
  const byId = Object.fromEntries(articles.map((a) => [a.docId, a]));
  assert.deepEqual(Object.keys(byId).sort(), [aDocId, bDocId]);
  assert.equal(byId[aDocId].key, aKey);
  assert.equal(byId[aDocId].content, aV1content);
  assert.equal(byId[bDocId].key, bKey);
  assert.equal(byId[bDocId].content, bV1content);
  assert.equal(taxonomy, '{"series":["HG"]}');

  // no taxonomy on the clone → null (nothing to mirror)
  const bare = mkdtempSync(join(tmpdir(), 'orch-clone-bare-'));
  mkdirSync(join(bare, 'articles'), { recursive: true });
  assert.deepEqual(await readLibraryFromClone(bare, 'articles'), { articles: [], taxonomy: null });
});
