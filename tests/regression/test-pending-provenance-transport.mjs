// tests/regression/test-pending-provenance-transport.mjs
// pendingProvenance rides the attr transport: sidecar entry, state.overlay sync,
// markdown overlay map, parse re-arm. Reject clears it; canonical body never sees it.
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `prov-transport-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

state.load();
const created = documents.createDocument('Transport Doc');
const filename = created.filename;
const docId = documents.listDocuments().find((d) => d.filename === filename).docId;

// 1. Hand-stamp a rewrite-shaped pending attr on the created doc's first node
//    (createDocument leaves it active), then save. This is what propose_edits
//    does for real in Task 2 — hand-rolled here so the transport is testable
//    before a producer exists.
const node = state.getDocument().content[0];
const nodeId = node.attrs.id;
node.attrs.pendingStatus = 'rewrite';
node.attrs.pendingOriginalContent = {
  type: 'paragraph', attrs: { id: nodeId }, content: [{ type: 'text', text: 'original text' }],
};
node.attrs.pendingProvenance = {
  agentSessionId: 'sesstr1', model: 'test-model', promptVersion: 't1',
  sourceSet: [], reviewerStatus: null, proposedAt: '2026-09-08T00:00:00Z',
};
state.setActiveDocument(
  state.getDocument(), state.getTitle(), state.getFilePath(), state.getIsTemp(),
  undefined, state.getMetadata(),
);
state.save('agent');

// 2. Sidecar entry carries provenance.
const sidecar = JSON.parse(readFileSync(join(HOME, 'profiles', 'Default', '_pending', `${docId}.json`), 'utf-8'));
const entry = sidecar.entries.find((e) => e.nodeId === nodeId);
assert(entry && entry.provenance?.agentSessionId === 'sesstr1', 'sidecar entry carries provenance after save');

// 3. Canonical BODY does not leak the session id (frontmatter overlay map may carry it).
const raw = readFileSync(join(HOME, 'profiles', 'Default', filename), 'utf-8');
const body = raw.slice(raw.indexOf('---', 4) + 3); // skip frontmatter
assert(!body.includes('sesstr1'), 'canonical body has no attribution');

// 4. Parse + overlay re-arm: loadDocFromDisk re-arms the attr.
const reloaded = await import('../../dist/server/pending-overlay.js');
const merged = reloaded.loadDocFromDisk(filename);
const reNode = merged.document.content.find((n) => n.attrs?.id === nodeId);
assert(reNode?.attrs?.pendingProvenance?.agentSessionId === 'sesstr1', 'parse/apply re-arms pendingProvenance');

// 5. Reject clears entry and attr.
documents.resolveOverlayEntry(docId, nodeId, 'reject');
const after = state.getOverlayEntries().find((e) => e.nodeId === nodeId);
assert(!after, 'reject removes the overlay entry');

console.log(failed ? `provenance-transport: ${failed} FAIL(s)` : 'provenance-transport: PASS');
process.exit(failed ? 1 : 0);
