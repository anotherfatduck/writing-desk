// tests/regression/test-docid-resolution.mjs — undefined docIds resolve to
// nothing. Undefined-equality used to match docless-frontmatter files (the
// _untitled-<uuid>.md seeds on fresh homes).
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `docid-res-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const created = documents.createDocument('Real Doc', 'article');
// A docless-frontmatter file in the data dir (the fresh-home seed shape).
const dataDir = join(HOME, 'profiles', 'Default');
writeFileSync(join(dataDir, '_untitled-test.md'), '# Docless\n\nNo frontmatter here.\n');

assert(documents.filenameByDocId(undefined) === null, 'filenameByDocId(undefined) returns null');
assert(documents.filenameByDocId('') === null, 'filenameByDocId(empty) returns null');
const real = documents.listDocuments().find((d) => d.filename === created.filename);
assert(!!real?.docId && documents.filenameByDocId(real.docId) === created.filename, 'a real docId still resolves');

console.log(failed ? `docid-resolution: ${failed} FAIL(s)` : 'docid-resolution: PASS');
process.exit(failed ? 1 : 0);
