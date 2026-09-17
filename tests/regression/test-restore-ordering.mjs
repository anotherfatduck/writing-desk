// tests/regression/test-restore-ordering.mjs — the membership-after-success
// invariant (packaging lane 2026-09-13, spec §restore-ordering): a failed
// delete must leave the desk doc's workspace membership AND its bytes intact.
// Pre-fix behavior: restoreLibraryDoc removed the doc from every workspace
// BEFORE deleteDocument, so a 409 (review in flight) left the doc unlisted
// but still on disk — the exact UAT residue failure.
//
// Run: node tests/regression/test-restore-ordering.mjs   (dist must be current)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { restoreLibraryDoc } from '../../dist/server/documents.js';
import { createWorkspace, addDoc, listWorkspaces } from '../../dist/server/workspaces.js';
import { setActiveProfile, ensureDataDir } from '../../dist/server/helpers.js';
import { setActiveDocument } from '../../dist/server/state.js';
import { markdownToTiptap } from '../../dist/server/markdown.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-restore-ordering-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() { try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function seedMd(filename, frontmatter, body = 'Body text.') {
  const path = join(TEST_PROFILE_DIR, filename);
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  return path;
}

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

// Occupied singleton with a non-target doc (mirrors test-lifecycle-overlay's fixture).
const placeholderPath = seedMd('placeholder.md', 'title: Placeholder\ndocId: plc00001');
{
  const parsed = markdownToTiptap(readFileSync(placeholderPath, 'utf-8'));
  setActiveDocument(parsed.document, parsed.title, placeholderPath, false, undefined, parsed.metadata);
}

async function main() {
  // ---- Case A: review in flight → 409, membership AND bytes intact ----
  const inFlight = seedMd('adopted-a.md', [
    'title: Adopted In Flight',
    'docId: libartida',
    'library:',
    '  key: w1/libartida',
    'review:',
    '  submitted:',
    '    at: "2026-09-13T00:00:00.000Z"',
  ].join('\n'));
  const wsA = createWorkspace({ title: 'Ordering A' });
  addDoc(wsA.filename, null, 'adopted-a.md', 'Adopted In Flight');

  let threwA = null;
  try { await restoreLibraryDoc('libartida'); } catch (e) { threwA = e; }
  assert(threwA && threwA.status === 409 && /review in flight/.test(threwA.message ?? ''),
    `restore refuses a review-in-flight doc with 409 (got: status=${threwA?.status}, ${threwA?.message ?? 'no throw'})`);
  assert(existsSync(inFlight), 'desk copy bytes survive the refusal');
  const countA = listWorkspaces().find(w => w.filename === wsA.filename)?.docCount;
  assert(countA === 1, 'workspace membership intact after the 409 (the invariant)');

  // Case B — no review in flight: restore succeeds, membership follows the delete.
  seedMd('adopted-b.md', [
    'title: Adopted Published',
    'docId: libartidb',
    'library:',
    '  key: w1/libartidb',
    'review:',
    '  published:',
    '    at: "2026-09-13T00:00:00.000Z"',
  ].join('\n'));
  const wsB = createWorkspace({ title: 'Ordering B' });
  addDoc(wsB.filename, null, 'adopted-b.md', 'Adopted Published');

  let resultB = null, threwB = null;
  try { resultB = await restoreLibraryDoc('libartidb'); } catch (e) { threwB = e; }
  assert(!threwB && resultB?.filename === 'adopted-b.md',
    `restore succeeds on a published adopted doc (got: ${threwB?.message ?? 'ok'})`);
  assert(!existsSync(join(TEST_PROFILE_DIR, 'adopted-b.md')), 'desk copy deleted on success');
  const countB = listWorkspaces().find(w => w.filename === wsB.filename)?.docCount;
  assert(countB === 0, 'membership removed only after the successful delete');

  console.log(failed ? `test-restore-ordering: ${failed} FAILURES` : 'test-restore-ordering: all ok');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); cleanup(); process.exit(1); });
