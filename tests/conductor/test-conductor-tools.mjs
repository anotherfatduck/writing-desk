// tests/conductor/test-conductor-tools.mjs — tool layer: validation, write path, and the tool surface (submit_for_review absent).
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `m3-t1-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const { CONDUCTOR_TOOLS, CONDUCTOR_TOOL_NAMES, CONDUCTOR_TOOL_MAP } = await import('../../dist/server/conductor-tools.js');
const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

// Boot state with one active doc
state.load();
const created = documents.createDocument('Tool Layer Doc', 'article');

// 1. The surface is exactly the three tools — submission is writer-initiated.
assert(JSON.stringify([...CONDUCTOR_TOOL_NAMES]) === JSON.stringify(['read_document', 'read_workspace', 'propose_edits']),
  `tool surface is exactly the three tools (got ${JSON.stringify([...CONDUCTOR_TOOL_NAMES])})`);
assert(new Set(CONDUCTOR_TOOL_NAMES).size === CONDUCTOR_TOOLS.length, 'no duplicate tool names');
assert(!CONDUCTOR_TOOL_MAP.submit_for_review, 'submit_for_review is gone from the surface');
for (const t of CONDUCTOR_TOOLS) assert(typeof t.execute === 'function' && t.parameters && t.schema, `${t.name} has parameters + schema + execute`);

// 2. read_document returns markdown + node addressing + pending state
const docId = documents.listDocuments()[0].docId;
const ctx = { sessionId: 'sess0001', docId };
const rd = await CONDUCTOR_TOOL_MAP.read_document.execute({}, ctx);
const rdBody = JSON.parse(rd.content[0].text);
assert(rdBody.markdown.includes('Tool Layer Doc'), 'read_document returns document markdown');
assert(Array.isArray(rdBody.nodes) && rdBody.nodes.every((n) => typeof n.id === 'string' && typeof n.preview === 'string'),
  'read_document carries node-id addressing (id + preview per node)');

// 3. propose_edits lands a pending sidecar — canonical file unchanged
const filePath = documents.listDocuments()[0].filename;
const canonicalPath = join(HOME, 'profiles', 'Default', filePath);
const before = readFileSync(canonicalPath, 'utf-8');
const pe = await CONDUCTOR_TOOL_MAP.propose_edits.execute(
  { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Ghost-written paragraph one.' }] }, ctx);
const peBody = JSON.parse(pe.content[0].text);
assert(peBody.success === true && peBody.appliedCount === 1, `propose_edits applied (got ${JSON.stringify(peBody)})`);
assert(readFileSync(canonicalPath, 'utf-8') === before, 'canonical file unchanged by propose_edits (sidecar only)');
assert(state.getPendingChangeCount() >= 1, 'pending count increased');
const sidecar = JSON.parse(readFileSync(join(HOME, 'profiles', 'Default', '_pending', `${docId}.json`), 'utf-8'));
const stampedEntry = sidecar.entries.find((e) => e.provenance?.agentSessionId === 'sess0001');
assert(stampedEntry, 'sidecar entries carry per-entry provenance.agentSessionId');
assert(typeof stampedEntry?.provenance?.model === 'string' && stampedEntry?.provenance?.promptVersion, 'entry provenance carries model + promptVersion');
assert('sourceSet' in (stampedEntry?.provenance ?? {}) && 'reviewerStatus' in (stampedEntry?.provenance ?? {}), 'entry provenance carries sourceSet + reviewerStatus slots');
assert(!sidecar.metadata?.provenance, 'no doc-level metadata.provenance blob remains');

// 4. No submit tool: the conductor cannot stamp review.* or end a session by
//    submitting (chat-agent-config: submission is writer-initiated from the
//    Review tab). The stamp semantics live in reviewAfterFreshSubmit —
//    covered by test-review-gate; the loop's unknown-tool path by
//    test-conductor-loop scenario 13.
assert(!CONDUCTOR_TOOL_MAP.submit_for_review, 'no submit_for_review tool to execute');

// 6. read_workspace lists documents with ids
const ws = await CONDUCTOR_TOOL_MAP.read_workspace.execute({}, ctx);
const wsBody = JSON.parse(ws.content[0].text);
assert(Array.isArray(wsBody.documents) && wsBody.documents.some((d) => d.docId === docId), 'read_workspace lists the doc by id');
assert(wsBody.documents.every((d) => typeof d.metadata === 'object'), 'read_workspace carries a frontmatter metadata slot per doc (campaign awareness)');

rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `conductor-tools: ${failed} FAIL(s)` : 'conductor-tools: PASS');
process.exit(failed ? 1 : 0);
