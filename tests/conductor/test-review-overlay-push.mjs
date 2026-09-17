// tests/conductor/test-review-overlay-push.mjs — WS push wire contract + accept-path riders.
// In-process: boots the real built server modules, attaches setupWebSocket to a local
// http server, and drives it with a raw ws client — the same wire the browser consumes.
// adr: adr/node-identity-matcher.md, adr/0005-pending-overlay-model.md
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'node:http';
import matter from 'gray-matter';
import WebSocket from 'ws';

const HOME = join(tmpdir(), `m3-followups-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');
const pendingOverlay = await import('../../dist/server/pending-overlay.js');
const { CONDUCTOR_TOOL_MAP } = await import('../../dist/server/conductor-tools.js');
const { setupWebSocket } = await import('../../dist/server/ws.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };
const assertEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

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

function docFilePath(home, filename) {
  return join(home, 'profiles', 'Default', filename);
}

/** Propose one insert through the real conductor tool (same implementation
 *  the chat gateway's tool calls execute through). */
async function propose(sessionId, docId, text) {
  const pe = await CONDUCTOR_TOOL_MAP.propose_edits.execute(
    { changes: [{ operation: 'insert', afterNodeId: 'end', content: text }] },
    { sessionId, docId });
  return JSON.parse(pe.content[0].text);
}

state.load();

// Attach the real WS layer to a local http server; one raw client for all sections.
const httpServer = http.createServer();
setupWebSocket(httpServer);
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const ws = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}`);
const wsMessages = [];
ws.on('message', (raw) => { try { wsMessages.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
  ws.once('open', () => { clearTimeout(t); resolve(); });
});

// ============================================================================
// 1. Wire contract: propose on the ACTIVE doc broadcasts node-changes
//    carrying pendingStatus attrs + a version. Guards the contract the
//    App.tsx client fix consumes (server already passes — regression guard).
// ============================================================================
const wireDoc = documents.createDocumentFile('Wire Doc');
// createDocumentFile does NOT switch the active doc; the wire contract under test
// (node-changes broadcast) only fires for the ACTIVE doc's proposes.
documents.switchDocument(wireDoc.filename);
const before = wsMessages.length;
const pe1 = await propose('sesswire1', wireDoc.docId, 'Wire proposed paragraph.');
assert(pe1.success === true, 'propose_edits applied on active doc');

let wireMsg = null;
assert(await waitFor(() => {
  wireMsg = wsMessages.slice(before).find((m) => m.type === 'node-changes' && Array.isArray(m.changes) && m.changes.length > 0) || null;
  return !!wireMsg;
}), 'node-changes broadcast received for active-doc propose');
assert(typeof wireMsg.version === 'number', 'node-changes carries numeric version');
// Fresh single-paragraph doc: auto-clean (now in state.ts applyChangesToDoc,
// keyed off the propose TARGET — was mcp.ts keying off the ACTIVE doc, the
// parked defect fixed alongside tests/regression/test-auto-clean-target.mjs)
// converts the insert into a rewrite of the empty paragraph — still stamped
// pendingStatus 'insert'.
const wireChange = wireMsg.changes[0];
assert(wireChange.operation === 'rewrite', 'fresh-doc propose broadcasts as auto-clean rewrite');
const contentArr = Array.isArray(wireChange.content) ? wireChange.content : [wireChange.content];
assert(contentArr.some((n) => n?.attrs?.pendingStatus === 'insert'), 'inserted content carries pendingStatus attr');

// ============================================================================
// 2. Rider (a): non-active WS accept with frontmatter docId → provenance
//    stamped, pending attrs stripped, sidecar cleared, active doc untouched.
//    Codifies the T5/T10 smoke flow.
// ============================================================================
const riderA = documents.createDocument('Rider A Doc', 'article\n\nRider A intro paragraph.');
// Content-bearing active doc — historically a dodge for the auto-clean
// wrong-target defect (fixed: the conversion now keys off the propose TARGET,
// so a fresh active doc no longer corrupts non-active proposes). Kept: a
// content-bearing active doc exercises the non-active accept path against a
// realistic file.
const activeA = documents.createDocument('Rider A Active', 'article\n\nActive body paragraph.');
const riderAPath = docFilePath(HOME, riderA.filename);
const activeAPath = docFilePath(HOME, activeA.filename);
const activeARawBefore = readFileSync(activeAPath, 'utf-8');
// createDocument switches the active doc to each new file (probe-verified) and
// returns NO docId — read the docId from the frontmatter it wrote to disk.
const riderADocId = matter(readFileSync(riderAPath, 'utf-8')).data.docId;
assert(typeof riderADocId === 'string' && riderADocId.length > 0, 'rider-a doc has frontmatter docId pre-accept');

const peA = await propose('sessridera', riderADocId, 'Rider A proposed paragraph.');
assert(peA.success === true, 'rider-a propose applied on non-active doc');

const sidecarPre = pendingOverlay.readSidecarRaw(riderADocId);
const riderAStamped = sidecarPre?.entries?.some((e) => e.provenance?.agentSessionId === 'sessridera');
assert(riderAStamped, 'rider-a sidecar entries carry provenance pre-accept');

ws.send(JSON.stringify({ type: 'pending-resolved', filename: riderA.filename, action: 'accept' }));
assert(await waitFor(() => Array.isArray(matter(readFileSync(riderAPath, 'utf-8')).data.provenance)), 'rider-a frontmatter provenance is an array');
const fmA = matter(readFileSync(riderAPath, 'utf-8')).data;
assertEqual(fmA.provenance?.[0]?.agentSessionId, 'sessridera', 'rider-a frontmatter provenance[0].agentSessionId');
assert(typeof fmA.provenance?.[0]?.acceptedAt === 'string', 'rider-a provenance[0].acceptedAt stamped');
assertEqual(fmA.docId, riderADocId, 'rider-a docId unchanged');
assert(!readFileSync(riderAPath, 'utf-8').includes('pendingStatus'), 'rider-a pending attrs stripped from body');
assert(pendingOverlay.readSidecarRaw(riderADocId) == null, 'rider-a sidecar deleted');
assertEqual(readFileSync(activeAPath, 'utf-8'), activeARawBefore, 'rider-a active doc file untouched');

// ============================================================================
// 3. Rider (b): non-active accept with docId ONLY in the in-memory cache
//    (frontmatter docId stripped on disk) → provenance still stamped, docId
//    persisted, overlay cleared. RED pre-fix.
// ============================================================================
const riderB = documents.createDocument('Rider B Doc', 'article\n\nRider B intro paragraph.');
// Content-bearing active doc — see Section 2's note (the old auto-clean dodge; now just a realistic fixture).
const activeB = documents.createDocument('Rider B Active', 'article\n\nActive body paragraph.');
const riderBPath = docFilePath(HOME, riderB.filename);
// createDocument returns NO docId — read it from the frontmatter it wrote.
const riderBDocId = matter(readFileSync(riderBPath, 'utf-8')).data.docId;
assert(typeof riderBDocId === 'string' && riderBDocId.length > 0, 'rider-b doc has frontmatter docId pre-propose');

const peB = await propose('sessriderb', riderBDocId, 'Rider B proposed paragraph.');
assert(peB.success === true, 'rider-b propose applied on non-active doc');

const sidecarPreB = pendingOverlay.readSidecarRaw(riderBDocId);
const riderBStamped = sidecarPreB?.entries?.some((e) => e.provenance?.agentSessionId === 'sessriderb');
assert(riderBStamped, 'rider-b sidecar entries carry provenance pre-accept');

// Fixture: strip docId from frontmatter on disk (external-editor pattern).
// App frontmatter is single-line JSON — rewrite in the same format.
const rawB = readFileSync(riderBPath, 'utf-8');
const fmMatch = rawB.match(/^---\n(.+)\n---\n\n([\s\S]*)$/);
assert(!!fmMatch, 'rider-b frontmatter block matched');
const metaB = JSON.parse(fmMatch[1]);
assert(typeof metaB.docId === 'string', 'rider-b frontmatter docId present pre-strip');
delete metaB.docId;
writeFileSync(riderBPath, `---\n${JSON.stringify(metaB)}\n---\n\n${fmMatch[2]}`);

// Re-warm the cache entry so the server's cache is fresh and carries the
// docId the frontmatter no longer has — the exact precondition the cache
// fallback exists for. Uses the same merged-view load the propose path uses.
const loadedB = pendingOverlay.loadDocFromDisk(riderB.filename);
state.updateCacheEntry(riderBPath, loadedB.document, loadedB.title, loadedB.metadata, false, riderBDocId);

ws.send(JSON.stringify({ type: 'pending-resolved', filename: riderB.filename, action: 'accept' }));
assert(await waitFor(() => Array.isArray(matter(readFileSync(riderBPath, 'utf-8')).data.provenance)), 'rider-b frontmatter provenance is an array');
const fmC = matter(readFileSync(riderBPath, 'utf-8')).data;
assertEqual(fmC.provenance?.[0]?.agentSessionId, 'sessriderb', 'rider-b frontmatter provenance[0].agentSessionId');
assert(typeof fmC.provenance?.[0]?.acceptedAt === 'string', 'rider-b provenance[0].acceptedAt stamped');
assertEqual(fmC.docId, riderBDocId, 'rider-b recovered docId persisted to frontmatter');
assert(!readFileSync(riderBPath, 'utf-8').includes('pendingStatus'), 'rider-b pending attrs stripped');
assert(pendingOverlay.readSidecarRaw(riderBDocId) == null, 'rider-b sidecar deleted via recovered docId');

// Helper: rewrite a file's canonical body while dropping the node-id map so
// the new canonical block gets a fresh id. Preserves docId so the sidecar can
// still resolve.
function rewriteWithoutNodeMap(filePath, newBody) {
  const m = matter(readFileSync(filePath, 'utf-8'));
  delete m.data.nodes;
  writeFileSync(filePath, matter.stringify(newBody, m.data));
}

// ============================================================================
// 4. Rider (c): active-doc WS accept orphan filter — a delete whose target was
//    externally removed and watcher-reloaded must NOT land in accepted[].
// ============================================================================
const riderC = documents.createDocument('Rider C Doc', 'Rider C seed paragraph.\n');
const riderCPath = docFilePath(HOME, riderC.filename);
const riderCDocId = matter(readFileSync(riderCPath, 'utf-8')).data.docId;
const riderCSeedId = state.getDocument().content[0].attrs.id;
const rawPeC = await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [
      { operation: 'delete', nodeId: riderCSeedId },
      { operation: 'insert', afterNodeId: 'end', content: 'Rider C survivor paragraph.' },
  ] }, { sessionId: 'sessriderc', docId: riderCDocId });
const peC = JSON.parse(rawPeC.content[0].text);
assert(peC.success === true, 'rider-c propose applied on active doc');

rewriteWithoutNodeMap(riderCPath, 'Survivor-only canonical paragraph.\n');
const beforeReloadC = wsMessages.length;
assert(await waitFor(() => wsMessages.slice(beforeReloadC).some((m) => m.type === 'document-reloaded' && m.filename === riderC.filename), 5000), 'rider-c document-reloaded after external write');

ws.send(JSON.stringify({ type: 'pending-resolved', filename: riderC.filename, action: 'accept' }));
assert(await waitFor(() => Array.isArray(matter(readFileSync(riderCPath, 'utf-8')).data.provenance), 5000), 'rider-c frontmatter provenance is an array');
const fmC2 = matter(readFileSync(riderCPath, 'utf-8')).data;
const recC = (fmC2.provenance ?? []).find((r) => r.agentSessionId === 'sessriderc');
assert(recC, 'rider-c session record exists');
assertEqual(recC.accepted.length, 1, 'rider-c accepted[] lists only the live insert');
assert(!recC.accepted.some((a) => a.nodeId === riderCSeedId), 'rider-c orphaned delete nodeId absent from accepted[]');

// ============================================================================
// 5. Rider (d): race-branch WS accept orphan filter — a formerly-active doc
//    whose delete target was externally removed before accept must not record
//    the orphan.
// ============================================================================
const riderD = documents.createDocument('Rider D Doc', 'Rider D seed paragraph.\n');
const riderDActive = documents.createDocument('Rider D Active', 'Rider D active paragraph.\n');
const riderDPath = docFilePath(HOME, riderD.filename);
// createDocument returns no docId — read the one it wrote to disk.
const riderDDocId = matter(readFileSync(riderDPath, 'utf-8')).data.docId;
const riderDSeedId = pendingOverlay.loadDocFromDisk(riderD.filename).document.content[0].attrs.id;

const rawPeD = await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [
      { operation: 'delete', nodeId: riderDSeedId },
      { operation: 'insert', afterNodeId: 'end', content: 'Rider D survivor paragraph.' },
  ] }, { sessionId: 'sessriderd', docId: riderDDocId });
const peD = JSON.parse(rawPeD.content[0].text);
assert(peD.success === true, 'rider-d propose applied on non-active doc');

rewriteWithoutNodeMap(riderDPath, 'Survivor-only canonical paragraph.\n');

ws.send(JSON.stringify({ type: 'pending-resolved', filename: riderD.filename, action: 'accept' }));
assert(await waitFor(() => Array.isArray(matter(readFileSync(riderDPath, 'utf-8')).data.provenance), 5000), 'rider-d frontmatter provenance is an array');
const fmD = matter(readFileSync(riderDPath, 'utf-8')).data;
const recD = (fmD.provenance ?? []).find((r) => r.agentSessionId === 'sessriderd');
assert(recD, 'rider-d session record exists');
assertEqual(recD.accepted.length, 1, 'rider-d accepted[] lists only the live insert');
assert(!recD.accepted.some((a) => a.nodeId === riderDSeedId), 'rider-d orphaned delete nodeId absent from accepted[]');

ws.close();

httpServer.close();
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `review-overlay-push: ${failed} FAIL(s)` : 'review-overlay-push: PASS');
process.exit(failed ? 1 : 0);
