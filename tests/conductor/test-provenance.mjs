// tests/conductor/test-provenance.mjs — per-change provenance: accept reads the
// author off the change; frontmatter provenance is an append-only record array.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

const HOME = join(tmpdir(), `m4-prov-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const { CONDUCTOR_TOOL_MAP } = await import('../../dist/server/conductor-tools.js');
const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const assertEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

state.load();
const fm = (filename) => matter(readFileSync(join(HOME, 'profiles', 'Default', filename), 'utf-8')).data;
// --- Scenario 1: session A proposes, session B proposes; accept A's node → credits A.
const provCreated = documents.createDocument('Prov Doc', 'Seed paragraph.\n');
const docId = documents.listDocuments().find((d) => d.filename === provCreated.filename).docId;
const filename = provCreated.filename;
const ctxA = { sessionId: 'sessA', docId };
await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Paragraph from session A.' }] }, ctxA);
const ctxB = { sessionId: 'sessB', docId };
await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Paragraph from session B.' }] }, ctxB);

const nodeA = state.getOverlayEntries().find((e) => JSON.stringify(e.newContent ?? '').includes('session A'));
documents.resolveOverlayEntry(docId, nodeA.nodeId, 'accept');
const fm1 = fm(filename);
assert(Array.isArray(fm1.provenance), 'frontmatter provenance is an array');
assert(fm1.provenance.length === 1 && fm1.provenance[0].agentSessionId === 'sessA', 'accepting A credits A (not B)');
assert(fm1.provenance[0].accepted?.some((a) => a.nodeId === nodeA.nodeId), 'record lists the accepted nodeId');
assert(typeof fm1.provenance[0].acceptedAt === 'string', 'record carries acceptedAt');

// --- Scenario 2: reject records nothing.
const nodeB = state.getOverlayEntries()[0];
documents.resolveOverlayEntry(docId, nodeB.nodeId, 'reject');
assertEqual(fm(filename).provenance, fm1.provenance, 'reject records nothing');

// --- Scenario 3: two accepts from different batches → both records survive.
const ctxA2 = { sessionId: 'sessA2', docId };
await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Second batch from A2.' }] }, ctxA2);
const e2 = state.getOverlayEntries()[0];
documents.resolveOverlayEntry(docId, e2.nodeId, 'accept');
const fm2 = fm(filename);
assert(fm2.provenance.length === 2, 'append-on-accept: both batch records survive');
assert(fm2.provenance[1].agentSessionId === 'sessA2', 'second record credits its own session');

// --- Scenario 4: whole-doc batch accept coalesces one propose call into ONE record.
//    Batch accept runs the non-active resolve path (resolveDocFile via
//    batchResolve) — park the batch doc behind a sham active doc first
//    (createDocument activates each new doc; probe-verified).
const batchCreated = documents.createDocument('Batch Doc', 'Batch seed paragraph.\n');
const batchDocId = documents.listDocuments().find((d) => d.filename === batchCreated.filename).docId;
documents.createDocument('Batch Sham Active', 'Sham body paragraph.\n');
await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [
    { operation: 'insert', afterNodeId: 'end', content: 'Batch X paragraph one.' },
    { operation: 'insert', afterNodeId: 'end', content: 'Batch X paragraph two.' },
  ] }, { sessionId: 'sessA', docId: batchDocId });
documents.batchResolve([batchCreated.filename], 'accept');
const fm3 = fm(batchCreated.filename);
const batchX = fm3.provenance.filter((r) => r.accepted?.length === 2);
assert(batchX.length === 1 && batchX[0].agentSessionId === 'sessA', 'batch accept coalesces one propose into one record');

// --- Scenario 5: external propose (no provenance) → accepting it records nothing.
const extCreated = documents.createDocument('Ext Doc', 'Ext seed paragraph.\n');
const extDocId = documents.listDocuments().find((d) => d.filename === extCreated.filename).docId;
documents.createDocument('Ext Sham Active', 'Sham body paragraph.\n');
const wtp = (await import('../../dist/server/mcp.js')).TOOL_REGISTRY.find((t) => t.name === 'write_to_pad');
await wtp.handler({ changes: [{ operation: 'insert', afterNodeId: 'end', content: 'External agent paragraph.' }], docId: extDocId });
const extEntries = (await import('../../dist/server/pending-overlay.js')).loadOverlay(extDocId);
documents.resolveOverlayEntry(extDocId, extEntries[0].nodeId, 'accept');
const extFm = fm(extCreated.filename);
assert(!extFm.provenance || (Array.isArray(extFm.provenance) && extFm.provenance.length === 0), 'accepting an external entry records no provenance');

// --- Scenario 6: batch-accept orphan filter — a delete whose target was
//     externally removed between propose and accept must NOT land in the
//     record's accepted[] (the audit index states only what was accepted).
const orphCreated = documents.createDocument('Orphan Doc', 'Orphan seed paragraph.\n');
const orphDocId = documents.listDocuments().find((d) => d.filename === orphCreated.filename).docId;
const orphSeedId = state.getDocument().content[0].attrs.id;   // Orphan Doc is active on create (probe-verified pattern from Scenario 4)
documents.createDocument('Orphan Sham Active', 'Sham body paragraph.\n');   // park Orphan Doc behind a sham → batch path
await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [
      { operation: 'delete', nodeId: orphSeedId },
      { operation: 'insert', afterNodeId: 'end', content: 'Orphan survivor paragraph.' },
  ] }, { sessionId: 'sessO', docId: orphDocId });
// External removal: rewrite the file WITHOUT the seed paragraph, preserving
// docId (loadOverlay needs it) and title. Drop the node-id map so the new
// canonical paragraph gets a fresh id — otherwise the old node id is reused
// and the delete entry is not actually orphaned (probe-point adjustment).
const orphPath = join(HOME, 'profiles', 'Default', orphCreated.filename);
const orphM = matter(readFileSync(orphPath, 'utf-8'));
delete orphM.data.nodes;
writeFileSync(orphPath, matter.stringify('Survivor-only canonical paragraph.\n', orphM.data));
const orphRes = documents.batchResolve([orphCreated.filename], 'accept');
const orphFm = fm(orphCreated.filename);
const orphRec = (orphFm.provenance ?? []).find((r) => r.agentSessionId === 'sessO');
assert(orphRec, 'orphan scenario produces its session record');
assertEqual(orphRec.accepted.length, 1, 'accepted[] lists only the live insert (orphaned delete excluded)');
assert(!orphRec.accepted.some((a) => a.nodeId === orphSeedId), 'orphaned delete nodeId absent from accepted[]');
assertEqual(orphRes.changesResolved, 1, 'changesResolved counts only actual resolutions (orphaned delete resolves nothing)');

console.log(failed ? `provenance: ${failed} FAIL(s)` : 'provenance: PASS');
process.exit(failed ? 1 : 0);
