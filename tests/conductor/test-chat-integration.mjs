// tests/conductor/test-chat-integration.mjs — end-to-end ghost-write through REST.
// Boots the real built app against a fake gateway, scripts a full read → propose ×2
// → accept chain, the writer's Review-tab submit, and the unknown-tool submit path
// (the conductor has no submit tool).
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { bootApp, shutdown, api } from '../spike-a/lib/spike.mjs';
import { startFakeGateway, scriptTurns } from './lib/fake-gateway.mjs';

let failed = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`);
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function getJson(res) {
  return res.json().catch(() => ({}));
}

async function createDoc(app, title, content) {
  const res = await api(app, 'POST', '/api/documents', { title, content });
  const j = await getJson(res);
  const active = await getJson(await api(app, 'GET', '/api/document'));
  return { ...j, docId: active.metadata?.docId };
}

function chatTranscriptPath(home, docId, sessionId) {
  return join(home, 'profiles', 'Default', '_chats', docId, `${sessionId}.jsonl`);
}

function docFilePath(home, filename) {
  return join(home, 'profiles', 'Default', filename);
}

function toolCall(name, id, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function assertMetadataRange(fake, startIdx, sessionId, docId, label) {
  for (let i = startIdx; i < fake.seenBodies.length; i++) {
    const meta = fake.seenBodies[i].metadata;
    assert(meta?.session_id === sessionId, `${label}: body ${i - startIdx} metadata.session_id matches (${meta?.session_id})`);
    assert(meta?.doc_id === docId, `${label}: body ${i - startIdx} metadata.doc_id matches (${meta?.doc_id})`);
  }
}

function bodyHasToolResult(fake, startIdx, predicate) {
  for (let i = startIdx; i < fake.seenBodies.length; i++) {
    const messages = fake.seenBodies[i].messages ?? [];
    for (const m of messages) {
      if (m.role === 'tool' && typeof m.content === 'string' && predicate(m.content)) return true;
    }
  }
  return false;
}

const fake = await startFakeGateway();
process.env.LLM_BASE_URL = fake.baseUrl;
process.env.LLM_API_KEY = 'fake-vk';
process.env.AGENT_MODEL = 'fake-alias';

const app = await bootApp({ port: await freePort() });

// ============================================================================
// Main ghost-write chain on doc A
// ============================================================================
const docA = await createDoc(app, 'Ghost Doc', 'article\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
const docAId = docA.docId;
const docAPath = docFilePath(app.home, docA.filename);

// 1. Create session
const createRes = await api(app, 'POST', `/api/chat/${docAId}/sessions`);
const session1 = await getJson(createRes);
assert(createRes.status === 201, `create session returns 201 (got ${createRes.status})`);
assert(session1.sessionId && /^[0-9a-f]{8}$/i.test(session1.sessionId), `sessionId is 8-hex (got ${session1.sessionId})`);
assert(session1.docId === docAId, 'session docId matches request');
assert(typeof session1.startedAt === 'string', 'session has startedAt');
assert(existsSync(chatTranscriptPath(app.home, docAId, session1.sessionId)), 'transcript file exists on disk');

// 2. Turn 1: read_document
let gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('read_document', 'r1', {})] },
  { text: 'I see the article structure.', pt: 80, ct: 12 },
]);
const turn1Res = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session1.sessionId}/messages`, { text: 'Review the article.' });
const turn1 = (await getJson(turn1Res)).turn;
assert(turn1Res.status === 200, `turn 1 returns 200 (got ${turn1Res.status})`);
assert(turn1?.finishReason === 'complete', `turn 1 completes (got ${turn1?.finishReason})`);
assert(turn1?.toolCalls?.some((c) => c.name === 'read_document' && c.ok), 'turn 1 records read_document ok');
assert(turn1?.usage?.promptTokens > 0 && turn1?.usage?.completionTokens > 0, 'turn 1 usage recorded');
assertMetadataRange(fake, gwStart, session1.sessionId, docAId, 'turn 1');
assert(bodyHasToolResult(fake, gwStart, (c) => c.includes('"markdown"') && c.includes('Ghost Doc')), 'turn 1 read_document result fed back to model includes markdown');

// 3. Turn 2: propose_edits × 2
const PROPOSED_1 = 'First proposed section.';
const PROPOSED_2 = 'Second proposed section.';
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [
    toolCall('propose_edits', 'p1', { changes: [{ operation: 'insert', afterNodeId: 'end', content: PROPOSED_1 }] }),
    toolCall('propose_edits', 'p2', { changes: [{ operation: 'insert', afterNodeId: 'end', content: PROPOSED_2 }] }),
  ] },
  { text: 'Two sections proposed.', pt: 120, ct: 20 },
]);
const turn2Res = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session1.sessionId}/messages`, { text: 'Add two sections.' });
const turn2 = (await getJson(turn2Res)).turn;
assert(turn2Res.status === 200, `turn 2 returns 200 (got ${turn2Res.status})`);
assert(turn2?.finishReason === 'complete', `turn 2 completes (got ${turn2?.finishReason})`);
assert(turn2?.toolCalls?.length === 2, `turn 2 records two tool calls (got ${turn2?.toolCalls?.length})`);
assert(turn2?.toolCalls?.every((c) => c.name === 'propose_edits' && c.ok), 'turn 2 records both propose_edits ok');
assert(turn2?.usage?.promptTokens > 0 && turn2?.usage?.completionTokens > 0, 'turn 2 usage recorded');
assertMetadataRange(fake, gwStart, session1.sessionId, docAId, 'turn 2');
assert(bodyHasToolResult(fake, gwStart, (c) => c.includes('"appliedCount"') && c.includes('"success"')), 'turn 2 propose results fed back to model');

// Pending count is positive
const overlayA = await getJson(await api(app, 'GET', `/api/pending-entries?docId=${docAId}`));
assert(Array.isArray(overlayA.entries) && overlayA.entries.length === 2, 'pendingCount is 2 after turn 2');

// Resolve both pending nodes via /api/documents/resolve-entry accept
for (const entry of overlayA.entries) {
  const resolveRes = await api(app, 'POST', '/api/documents/resolve-entry', { docId: docAId, nodeId: entry.nodeId, action: 'accept' });
  const resolveBody = await getJson(resolveRes);
  assert(resolveRes.status === 200, `resolve-entry returns 200 (got ${resolveRes.status})`);
  assert(resolveBody.resolved === 1, `resolve-entry resolved one node (got ${resolveBody.resolved})`);
}

// Frontmatter now carries provenance
const fmAfterAccept = matter(readFileSync(docAPath, 'utf-8')).data;
assert(Array.isArray(fmAfterAccept.provenance), 'frontmatter provenance is an array');
assert(fmAfterAccept.provenance?.[0]?.agentSessionId === session1.sessionId, 'frontmatter provenance[0].agentSessionId matches session 1');
assert(typeof fmAfterAccept.provenance?.[0]?.model === 'string' && fmAfterAccept.provenance[0].model.length > 0, 'frontmatter provenance[0].model present');
assert(typeof fmAfterAccept.provenance?.[0]?.promptVersion === 'string' && fmAfterAccept.provenance[0].promptVersion.length > 0, 'frontmatter provenance[0].promptVersion present');
assert(typeof fmAfterAccept.provenance?.[0]?.acceptedAt === 'string', 'frontmatter provenance[0].acceptedAt present');

// 4. Turn 3: the model tries to submit — there is no submit tool. The call
//    hits the unknown-tool reply; the session stays open; nothing stamps.
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('submit_for_review', 's1', {})] },
  { text: 'Work delivered — you submit from the Review screen when ready.', pt: 40, ct: 8 },
]);
const turn3Res = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session1.sessionId}/messages`, { text: 'Submit for review.' });
const turn3 = (await getJson(turn3Res)).turn;
assert(turn3Res.status === 200, `turn 3 returns 200 (got ${turn3Res.status})`);
assert(turn3?.finishReason === 'complete', `turn 3 completes (got ${turn3?.finishReason})`);
assert(turn3?.toolCalls?.length === 1 && turn3?.toolCalls?.[0]?.name === 'submit_for_review' && turn3?.toolCalls?.[0]?.ok === false, 'turn 3 records the submit call as not-ok (unknown tool)');
assert(bodyHasToolResult(fake, gwStart, (c) => c.startsWith('unknown tool; available: ')), 'unknown-tool reply fed to the model');
assertMetadataRange(fake, gwStart, session1.sessionId, docAId, 'turn 3');

// Session stays OPEN after the refused submit call — submission is not the agent's act.
const transcript1 = await getJson(await api(app, 'GET', `/api/chat/${docAId}/sessions/${session1.sessionId}`));
assert(transcript1.ended === false, 'session 1 NOT ended by a submit call');
const fmAfterSubmit = matter(readFileSync(docAPath, 'utf-8')).data;
assert(!fmAfterSubmit.review, 'no review stamp landed from the chat session');

// ============================================================================
// Second session on the same doc: the WRITER submits via the Review tab, then
// the agent can still propose (the session is not ended by submission) and a
// submit call from the model changes nothing.
// ============================================================================
const createRes2 = await api(app, 'POST', `/api/chat/${docAId}/sessions`);
const session2 = await getJson(createRes2);
assert(createRes2.status === 201, `second session create returns 201 (got ${createRes2.status})`);
assert(session2.sessionId && session2.sessionId !== session1.sessionId, 'second session has distinct id');

// The writer submits from the Review tab.
const humanSubmitRes = await api(app, 'POST', '/api/review-gate/submit', {});
assert(humanSubmitRes.status === 200, `writer submit from the Review tab returns 200 (got ${humanSubmitRes.status})`);
const fmAfterHumanSubmit = matter(readFileSync(docAPath, 'utf-8')).data;
assert(!!fmAfterHumanSubmit.review?.submitted && fmAfterHumanSubmit.review.submitted.sessionId === 'user', 'writer-initiated submit stamped (sessionId user)');
const stampBeforeCall = JSON.stringify(matter(readFileSync(docAPath, 'utf-8')).data.review);

// Propose still works on the submitted doc — the session stays open through review.
const PROPOSED_3 = 'Another proposed section.';
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('propose_edits', 'p3', { changes: [{ operation: 'insert', afterNodeId: 'end', content: PROPOSED_3 }] })] },
  { text: 'Another section proposed.', pt: 90, ct: 15 },
]);
const turnS2T1Res = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session2.sessionId}/messages`, { text: 'Add another section.' });
const turnS2T1 = (await getJson(turnS2T1Res)).turn;
assert(turnS2T1Res.status === 200, `session 2 turn 1 returns 200 (got ${turnS2T1Res.status})`);
assert(turnS2T1?.finishReason === 'complete', `session 2 turn 1 completes (got ${turnS2T1?.finishReason})`);
assert(turnS2T1?.toolCalls?.some((c) => c.name === 'propose_edits' && c.ok), 'session 2 turn 1 records propose_edits ok');
assertMetadataRange(fake, gwStart, session2.sessionId, docAId, 'session 2 turn 1');

// A model submit call during review is an unknown tool: nothing stamps, nothing ends.
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('submit_for_review', 's2', {})] },
  { text: 'Acknowledged.', pt: 30, ct: 5 },
]);
const turnS2T2Res = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session2.sessionId}/messages`, { text: 'Submit again.' });
const turnS2T2 = (await getJson(turnS2T2Res)).turn;
assert(turnS2T2Res.status === 200, `session 2 submit call returns 200 (got ${turnS2T2Res.status})`);
assert(turnS2T2?.finishReason === 'complete', `session 2 submit call completes (got ${turnS2T2?.finishReason})`);
assert(turnS2T2?.toolCalls?.length === 1 && turnS2T2?.toolCalls?.[0]?.name === 'submit_for_review' && turnS2T2?.toolCalls?.[0]?.ok === false, 'model submit call recorded not-ok (unknown tool)');
assert(bodyHasToolResult(fake, gwStart, (c) => c.startsWith('unknown tool; available: ')), 'unknown-tool reply fed to the model');
const stampAfterCall = JSON.stringify(matter(readFileSync(docAPath, 'utf-8')).data.review);
assert(stampAfterCall === stampBeforeCall, 'the model submit call left the review stamps byte-identical');

// ============================================================================
// Non-active doc: propose works; a model submit call is an unknown tool and
// writes nothing (the old deferred direct-write branch is gone with the tool).
// ============================================================================
const docB = await createDoc(app, 'Non-active Doc B', 'article\n\nIntro paragraph.\n\nBody paragraph.');
const docBId = docB.docId;
const docBPath = docFilePath(app.home, docB.filename);
// Create a third doc so doc B is NOT the active one.
await createDoc(app, 'Active Doc C', 'article');

const createRes3 = await api(app, 'POST', `/api/chat/${docBId}/sessions`);
const session3 = await getJson(createRes3);
assert(createRes3.status === 201, `non-active session create returns 201 (got ${createRes3.status})`);
assert(session3.sessionId && /^[0-9a-f]{8}$/i.test(session3.sessionId), 'non-active session id is 8-hex');

// Propose on non-active doc
const PROPOSED_B = 'Non-active proposed section.';
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('propose_edits', 'pb1', { changes: [{ operation: 'insert', afterNodeId: 'end', content: PROPOSED_B }] })] },
  { text: 'Proposed on non-active doc.', pt: 70, ct: 10 },
]);
const turnB1Res = await api(app, 'POST', `/api/chat/${docBId}/sessions/${session3.sessionId}/messages`, { text: 'Propose a section.' });
const turnB1 = (await getJson(turnB1Res)).turn;
assert(turnB1Res.status === 200, `non-active propose returns 200 (got ${turnB1Res.status})`);
assert(turnB1?.finishReason === 'complete', `non-active propose completes (got ${turnB1?.finishReason})`);
assert(turnB1?.toolCalls?.some((c) => c.name === 'propose_edits' && c.ok), 'non-active propose records ok');
const overlayB = await getJson(await api(app, 'GET', `/api/pending-entries?docId=${docBId}`));
assert(Array.isArray(overlayB.entries) && overlayB.entries.length > 0, `non-active doc has pending entries (got ${overlayB.entries?.length})`);
assertMetadataRange(fake, gwStart, session3.sessionId, docBId, 'non-active propose');

// The old agent-side non-active submit branch is GONE — there is no submit
// tool, so nothing writes a non-active doc directly. A submit call on a
// non-active doc's session is an unknown tool, like any other.
gwStart = fake.seenBodies.length;
fake.script = scriptTurns([
  { toolCalls: [toolCall('submit_for_review', 'sb1', {})] },
  { text: 'Noted.', pt: 20, ct: 4 },
]);
const turnB2Res = await api(app, 'POST', `/api/chat/${docBId}/sessions/${session3.sessionId}/messages`, { text: 'Submit for review.' });
const turnB2 = (await getJson(turnB2Res)).turn;
assert(turnB2Res.status === 200, `non-active submit call returns 200 (got ${turnB2Res.status})`);
assert(turnB2?.finishReason === 'complete', `non-active submit call completes (got ${turnB2?.finishReason})`);
assert(turnB2?.toolCalls?.length === 1 && turnB2?.toolCalls?.[0]?.name === 'submit_for_review' && turnB2?.toolCalls?.[0]?.ok === false, 'non-active submit call recorded not-ok (unknown tool)');
const transcriptB = await getJson(await api(app, 'GET', `/api/chat/${docBId}/sessions/${session3.sessionId}`));
assert(transcriptB.ended === false, 'non-active session NOT ended by a submit call');
const fmB = matter(readFileSync(docBPath, 'utf-8')).data;
assert(!fmB.review, 'non-active doc carries no review stamp');

// ============================================================================
// Stop mid-turn: a stop arriving while a gateway response is PENDING must end
// the turn with no further tool calls executing. The response is delayed so
// the stop lands while the app awaits it — at this timing the existing
// AbortError catch (conductor.ts fetch abort) ends the turn BEFORE the
// tool-call loop is reached, so this test pins the OBSERVABLE stop contract
// (finishReason 'stopped', propose never lands) and passes both with and
// without the intra-burst guard. The loop-level guard (conductor.ts, rt.abort
// check at the top of each call iteration) is defense-in-depth for the window
// a black-box test cannot reach deterministically (a stop landing between
// call executions): production test hooks and timing-flaky tests were both
// ruled out (SDD ledger ruling, 2026-09-08). Its correctness is enforced by
// review plus the shared stop invariants this test pins.
// ============================================================================
{
  const abortDoc = await createDoc(app, 'Abort Doc', 'Seed paragraph.\n');
  fake.script = scriptTurns([
    { delayMs: 200, toolCalls: [
      toolCall('read_document', 'ab1', {}),
      toolCall('propose_edits', 'ab2', { changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Should never land.' }] }),
    ] },
  ]);
  const abortSession = await getJson(await api(app, 'POST', `/api/chat/${abortDoc.docId}/sessions`));
  const turnPromise = api(app, 'POST', `/api/chat/${abortDoc.docId}/sessions/${abortSession.sessionId}/messages`, { text: 'go' });
  await new Promise((r) => setTimeout(r, 50));
  await api(app, 'POST', `/api/chat/${abortDoc.docId}/sessions/${abortSession.sessionId}/stop`, {});
  const turnRes = await turnPromise;
  const turn = (await getJson(turnRes)).turn;
  assert(turn?.finishReason === 'stopped', `stop while pending finishes stopped (got ${turn?.finishReason})`);
  const sidecarPath = join(app.home, 'profiles', 'Default', '_pending', `${abortDoc.docId}.json`);
  const landed = existsSync(sidecarPath) && readFileSync(sidecarPath, 'utf-8').includes('Should never land');
  assert(!landed, 'the remaining tool call of the burst never executed');
}

// ============================================================================
// Sends to a session-ended session get 410 Gone (distinct from the transient
// 409), and the send does not un-end the session. The session is ended via
// Stop (the writer's own control) — submission no longer ends sessions.
// ============================================================================
{
  const endedDoc = await createDoc(app, 'Ended Doc', 'Seed paragraph.\n');
  const endedSession = await getJson(await api(app, 'POST', `/api/chat/${endedDoc.docId}/sessions`));
  fake.script = scriptTurns([{ text: 'Long reply.', delayMs: 3000 }]);
  const firstRes = api(app, 'POST', `/api/chat/${endedDoc.docId}/sessions/${endedSession.sessionId}/messages`, { text: 'finish' });
  await new Promise((r) => setTimeout(r, 200));
  await api(app, 'POST', `/api/chat/${endedDoc.docId}/sessions/${endedSession.sessionId}/stop`, {});
  const firstTurn = (await getJson(await firstRes)).turn;
  assert(firstTurn?.finishReason === 'stopped', `stop ended the session (got ${firstTurn?.finishReason})`);
  const again = await api(app, 'POST', `/api/chat/${endedDoc.docId}/sessions/${endedSession.sessionId}/messages`, { text: 'one more' });
  assert(again.status === 410, `send to ended session gets 410 (got ${again.status})`);
  const after = await getJson(await api(app, 'GET', `/api/chat/${endedDoc.docId}/sessions/${endedSession.sessionId}`));
  assert(after.ended === true, 'session stays ended after the rejected send');
  const endedList = await getJson(await api(app, 'GET', `/api/chat/${endedDoc.docId}/sessions`));
  const endedInfo = endedList.sessions.find((s) => s.sessionId === endedSession.sessionId);
  assert(endedInfo && endedInfo.ended === true, 'sessions list exposes ended:true (ChatTab seeds sessionEnded from it on load)');
}

await shutdown(app);
await fake.close();

console.log(failed ? `chat-integration: ${failed} FAIL(s)` : 'chat-integration: PASS');
process.exit(failed ? 1 : 0);
