// Delete refuses while a review lifecycle is in flight (spec §6 server change).
// Pattern follows tests/conductor/test-review-gate.mjs: tmpdir OW_HOME, dist imports.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `delete-guard-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const documents = await import('../../dist/server/documents.js');
const { getDataDir, ensureDataDir } = await import('../../dist/server/helpers.js');
ensureDataDir();

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const writeDoc = (filename, fm) => writeFileSync(join(getDataDir(), filename), `---\n${fm}---\n\n# t\n`);
writeDoc('plain-a.md', 'title: A\n');
writeDoc('plain-b.md', 'title: B\n');
writeDoc('inflight.md', 'title: Inflight\nreview:\n  submitted:\n    at: "2026-09-09T10:00:00.000Z"\n');
writeDoc('published.md', 'title: Published\nreview:\n  published:\n    at: "2026-09-09T10:00:00.000Z"\n');

// (1) listing emits reviewGate for gated docs, omits for plain docs
const rows = documents.listDocuments();
const inflight = rows.find(r => r.filename === 'inflight.md');
const plain = rows.find(r => r.filename === 'plain-a.md');
assert(inflight?.reviewGate?.phase === 'submitted', 'listDocuments: reviewGate.submitted on inflight doc');
assert(plain.reviewGate === undefined, 'listDocuments: no reviewGate on plain doc');

// (2) delete refuses in-flight (submitted)
let refused = null;
try { await documents.deleteDocument('inflight.md'); } catch (e) { refused = e.message; }
assert(refused && /review in flight/.test(refused) && /submitted/.test(refused), `deleteDocument: refused in-flight (${refused})`);

// (3) delete succeeds for published and plain docs
let publishedOk = false;
try { await documents.deleteDocument('published.md'); publishedOk = true; } catch { publishedOk = false; }
assert(publishedOk, 'deleteDocument: published doc deletable');
let plainOk = false;
try { await documents.deleteDocument('plain-a.md'); plainOk = true; } catch { plainOk = false; }
assert(plainOk, 'deleteDocument: plain doc deletable');

// ---- last-doc-starter (spec 2026-09-14-last-doc-starter) ----
const { markdownToTiptap } = await import('../../dist/server/markdown-parse.js');
const state = await import('../../dist/server/state.js');
const matterMod = await import('gray-matter');
const matter = matterMod.default ?? matterMod;
const dataDir = getDataDir();
const readDocId = (f) => matter(readFileSync(join(dataDir, f), 'utf8')).data.docId;
const activate = (filename) => {
  const p = join(dataDir, filename);
  const parsed = markdownToTiptap(readFileSync(p, 'utf8'));
  state.setActiveDocument(parsed.document, parsed.title, p, false, new Date(statSync(p).mtimeMs), parsed.metadata, undefined);
};

// inflight.md is undeletable by design (review guard); drop it via the
// fixture so the later cases see exactly the doc set they need.
rmSync(join(dataDir, 'inflight.md'), { force: true });

// (4) deleting the last doc seeds a pristine starter; writer lands on it
activate('plain-b.md');
const oldDocId = readDocId('plain-b.md');
const result = await documents.deleteDocument('plain-b.md');
assert(result.switched === true, 'last-doc delete returns switched: true');
assert(result.newDoc?.title === 'Untitled' && result.newDoc?.filename === 'Untitled.md', `starter shape (${result.newDoc?.title} / ${result.newDoc?.filename})`);
assert(!existsSync(join(dataDir, 'plain-b.md')), 'deleted doc file gone');
assert(existsSync(join(dataDir, 'Untitled.md')), 'starter file exists');
const starterRaw = readFileSync(join(dataDir, 'Untitled.md'), 'utf8');
const starterParsed = matter(starterRaw);
const fmKeys = Object.keys(starterParsed.data).sort();
// Standard create shape: tiptapToMarkdownChecked adds the node-id map
// (nodes) to {title, docId} — the exact frontmatter a UI-created doc gets.
assert(JSON.stringify(fmKeys) === JSON.stringify(['docId', 'nodes', 'title']), `starter frontmatter is the standard create set (got ${fmKeys.join(', ')})`);
assert(!fmKeys.some((k) => /review|provenance|agent|accepted/i.test(k)), 'no ghost keys in frontmatter');
const starterDoc = markdownToTiptap(starterRaw);
const firstBlock = starterDoc.document.content[0];
assert(starterDoc.document.content.length === 1 && firstBlock.type === 'paragraph' && (!firstBlock.content || firstBlock.content.length === 0), 'starter body is one empty paragraph');
assert(starterParsed.data.docId !== oldDocId, 'starter docId is fresh (no inheritance)');
assert(state.isAgentStub('Untitled.md') === false, 'starter is not an agent stub');
assert(state.getFilePath().endsWith('Untitled.md'), 'active doc switched to the starter');

// (5) review guard refuses even when the gated doc is the ONLY doc
writeDoc('inflight-last.md', 'title: Inflight Last\nreview:\n  submitted:\n    at: "2026-09-09T10:00:00.000Z"\n');
rmSync(join(dataDir, 'Untitled.md'), { force: true }); // isolate: inflight-last becomes the only data-dir doc
let refusedLast = null;
try { await documents.deleteDocument('inflight-last.md'); } catch (e) { refusedLast = e.message; }
assert(refusedLast && /review in flight/.test(refusedLast), `last-doc review guard still refuses (${refusedLast})`);
assert(existsSync(join(dataDir, 'inflight-last.md')), 'refused last doc still on disk');
assert(!existsSync(join(dataDir, 'Untitled.md')), 'refusal does not seed a starter (guard fires first)');

// (6) not-active edge: active doc is external — seed file, do NOT switch
rmSync(join(dataDir, 'inflight-last.md'), { force: true });
writeDoc('plain-c.md', 'title: C\n');
const extDir = join(HOME, 'ext');
mkdirSync(extDir, { recursive: true });
const extPath = join(extDir, 'external.md');
writeFileSync(extPath, '---\ntitle: Ext\n---\n\n# ext\n');
const extParsed = markdownToTiptap(readFileSync(extPath, 'utf8'));
state.setActiveDocument(extParsed.document, 'Ext', extPath, false, new Date(statSync(extPath).mtimeMs), extParsed.metadata, undefined);
const resultD = await documents.deleteDocument('plain-c.md');
assert(resultD.switched === false, 'not-active last-doc delete does not switch');
assert(existsSync(join(dataDir, 'Untitled.md')), 'starter re-seeded for the not-active edge');
assert(state.getFilePath() === extPath, 'editor stays on the external doc');
assert(state.isAgentStub('Untitled.md') === false, 're-seeded starter is not an agent stub');
const reseeded = matter(readFileSync(join(dataDir, 'Untitled.md'), 'utf8'));
assert(Object.keys(reseeded.data).sort().join(',') === 'docId,nodes,title', 're-seeded frontmatter clean');

rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
