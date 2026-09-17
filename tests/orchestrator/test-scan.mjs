// Workspace scan: flat docs under profiles/<p>/, machinery skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;
execFileSync('npx', ['tsc', '-p', 'tsconfig.orchestrator.json'], { cwd: REPO, stdio: 'inherit' });
const mod = (name) => import(new URL(`../../dist-orchestrator/orchestrator/${name}.js`, import.meta.url).href);
const { scanWriterRoot } = await mod('scan');

// The app-minted adoption stamp (spec §1/§2) that rides in a desk doc's
// frontmatter once it has been checked out of the library.
const LIB_KEY = '35845f18-1111-4222-8333-444455556666/cb12af51';
// The same stamped doc as a raw string — also planted under <root>/library/
// below, where a pristine mirror must still never surface as a desk doc.
const stampedDocRaw = `---\ndocId: cb12af51\ntitle: Adopted\nlibrary:\n  key: ${LIB_KEY}\n---\n\nBody.\n`;

function makeTree(root) {
  const mk = (rel, content) => {
    const p = join(root, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const doc = (id, title, extra = '') => `---\ndocId: ${id}\ntitle: ${title}\n${extra}---\n\nBody.\n`;
  mk('profiles/p1/Hypertension.md', doc('doc-1', 'Hypertension',
    'review:\n  submitted:\n    at: "2026-09-08T10:00:00.000Z"\n    sessionId: s1\n    model: glm\n'));
  mk('profiles/p1/Scratch.md', doc('doc-2', 'Scratch'));
  mk('profiles/p2/NoId.md', '---\ntitle: NoId\n---\n\nno docId\n');
  mk('profiles/p1/_chats/doc-1/s1.jsonl', '{"line":1}\n');   // machinery — skipped
  mk('profiles/p1/_commits/doc-1.jsonl', '{"ts":1}\n');          // machinery — skipped
  mk('profiles/.hidden/X.md', doc('doc-x', 'X'));                   // dot profile — skipped
  mk('profiles/p1/notes.json', '{}');                               // not .md — skipped
  // _untitled-*.md: a fresh doc's temp filename (title lives in frontmatter).
  // A REAL writer doc — the live "no PR" bug was the scan skipping these.
  mk('profiles/p1/_untitled-f5a899d8-0b7b-498e-9abd-8a583a51bde8.md', doc('doc-3', 'test article 2',
    'review:\n  submitted:\n    at: "2026-09-10T14:54:40.534Z"\n    sessionId: user\n    model: user\n'));
  // An adopted desk doc: stamped library.key rides along in the scan.
  mk('profiles/p1/cb12af51.md', doc('cb12af51', 'Adopted', `library:\n  key: ${LIB_KEY}\n`));
  // A plain desk doc: no stamp → libraryKey null.
  mk('profiles/p1/otherdoc.md', doc('otherdoc', 'Other'));
}

test('scan finds docs with docId, skips machinery and non-docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-scan-'));
  makeTree(root);
  const docs = scanWriterRoot(root);
  const byId = Object.fromEntries(docs.map((d) => [d.docId, d]));
  assert.deepEqual(Object.keys(byId).sort(), ['cb12af51', 'doc-1', 'doc-2', 'doc-3', 'otherdoc']);
  assert.equal(byId['doc-1'].title, 'Hypertension');
  assert.equal(byId['doc-1'].submittedAt, '2026-09-08T10:00:00.000Z');
  assert.equal(byId['doc-1'].sessionId, 's1');
  assert.match(byId['doc-1'].profileDir, /profiles[\\/]p1$/);
  assert.equal(byId['doc-2'].submittedAt, null);
  assert.match(byId['doc-2'].filePath, /Scratch\.md$/);
  // Untitled temp files are writer docs: scanned with their frontmatter title.
  assert.equal(byId['doc-3'].title, 'test article 2');
  assert.equal(byId['doc-3'].submittedAt, '2026-09-10T14:54:40.534Z');
  assert.match(byId['doc-3'].filePath, /_untitled-f5a899d8.*\.md$/);
});

test('scan of a root with no profiles dir returns empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-scan-empty-'));
  assert.deepEqual(scanWriterRoot(root), []);
});

test('scan surfaces libraryKey; plain docs get null; library dir is never scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-scan-lib-'));
  makeTree(root);
  const docs = scanWriterRoot(root);
  const adopted = docs.find(d => d.docId === 'cb12af51');
  assert.equal(adopted.libraryKey, '35845f18-1111-4222-8333-444455556666/cb12af51');
  assert.equal(docs.find(d => d.docId === 'otherdoc').libraryKey, null);
  // invariant pin (spec §1: mirrors live outside the scan machinery):
  // a stamped mirror under <root>/library/ never surfaces as a desk doc
  // (scanWriterRoot walks profiles/ only) — so mirrors can't self-register
  // as checked out
  mkdirSync(join(root, 'library'), { recursive: true });
  writeFileSync(join(root, 'library', 'x.md'), stampedDocRaw);
  assert.equal(scanWriterRoot(root).find(d => d.docId === 'cb12af51').filePath.includes('library'), false);
});
