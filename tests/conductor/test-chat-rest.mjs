// tests/conductor/test-chat-rest.mjs — REST + WS contract for the chat surface.
import { createServer } from 'node:net';
import { bootApp, shutdown, api, openWs } from '../spike-a/lib/spike.mjs';
import { startFakeGateway, scriptTurns } from './lib/fake-gateway.mjs';

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const fake = await startFakeGateway();
process.env.LLM_BASE_URL = fake.baseUrl;
process.env.LLM_API_KEY = 'fake-vk';
process.env.AGENT_MODEL = 'fake-alias';

async function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const app = await bootApp({ port: await freePort() });

function waitForWsMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WS message timeout')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }
    function onMessage(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) { cleanup(); resolve(msg); }
      } catch { /* ignore non-json */ }
    }
    ws.on('message', onMessage);
  });
}

async function createDoc(title, content = 'article') {
  const res = await api(app, 'POST', '/api/documents', { title, content });
  const j = await res.json();
  const active = await getJson(await api(app, 'GET', '/api/document'));
  return { ...j, docId: active.metadata?.docId };
}

async function getJson(res) {
  return res.json().catch(() => ({}));
}

// 1. unknown docId session create → 404
const unknownRes = await api(app, 'POST', '/api/chat/00000000/sessions');
assert(unknownRes.status === 404, `unknown docId create returns 404 (got ${unknownRes.status})`);

// Create doc A and doc B for ownership tests
const docA = await createDoc('Chat Doc A', 'article');
const docB = await createDoc('Chat Doc B', 'article');
const docAId = docA.docId;
const docBId = docB.docId;

// 2. create session 201 + 8-hex id
const createRes = await api(app, 'POST', `/api/chat/${docAId}/sessions`);
const session = await getJson(createRes);
assert(createRes.status === 201, `create session returns 201 (got ${createRes.status})`);
assert(session.sessionId && /^[0-9a-f]{8}$/i.test(session.sessionId), `sessionId is 8-hex (got ${session.sessionId})`);
assert(session.docId === docAId, 'session docId matches request');
assert(typeof session.startedAt === 'string', 'session has startedAt');

// 3. double session creation works (two sessions per doc allowed)
await new Promise((r) => setTimeout(r, 5)); // separate mtimes past ms granularity so newest-first is deterministic (mtime-tie flake)
const session2 = await getJson(await api(app, 'POST', `/api/chat/${docAId}/sessions`));
assert(session2.sessionId && session2.sessionId !== session.sessionId, 'second session per doc created');

// 3.5 give session2 content — empty (0-event) sessions must be invisible in listings
fake.script = scriptTurns([{ text: 'session two is awake.' }]);
const wakeRes = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session2.sessionId}/messages`, { text: 'wake session two' });
assert(wakeRes.status === 200, `message into session2 returns 200 (got ${wakeRes.status})`);

// 4. sessions list newest-first, 0-event session excluded
const list = await getJson(await api(app, 'GET', `/api/chat/${docAId}/sessions`));
assert(Array.isArray(list.sessions) && list.sessions.length === 1, `empty session excluded; list has one session (got ${list.sessions?.length})`);
assert(list.sessions[0].sessionId === session2.sessionId, 'sessions list newest-first');
assert(list.sessions[0].preview === 'wake session two', `listing carries first-message preview (got ${list.sessions[0]?.preview})`);

// 5. POST message returns turn.assistantText on a propose_edits + text scripted turn
fake.script = scriptTurns([
  { toolCalls: [{ id: 'r1', type: 'function', function: { name: 'propose_edits', arguments: JSON.stringify({ changes: [{ operation: 'insert', afterNodeId: 'end', content: 'REST test paragraph.' }] }) } }] },
  { text: 'Draft delivered.', pt: 120, ct: 20 },
]);
const msgRes = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session.sessionId}/messages`, { text: 'write me a paragraph' });
const msgBody = await getJson(msgRes);
assert(msgRes.status === 200, `message POST returns 200 (got ${msgRes.status})`);
assert(msgBody.turn && msgBody.turn.assistantText === 'Draft delivered.', `message returns assistantText (got ${msgBody.turn?.assistantText})`);
assert(msgBody.turn.finishReason === 'complete', `turn completes (got ${msgBody.turn?.finishReason})`);
assert(msgBody.turn.toolCalls.some((c) => c.name === 'propose_edits' && c.ok), 'tool call recorded ok');
assert(Array.isArray(msgBody.events), 'message response includes events');

// 6. GET transcript has writer+assistant+tool events
const transcriptRes = await api(app, 'GET', `/api/chat/${docAId}/sessions/${session.sessionId}`);
const transcript = await getJson(transcriptRes);
assert(transcriptRes.status === 200, `transcript GET returns 200 (got ${transcriptRes.status})`);
assert(transcript.events.some((e) => e.type === 'writer-message'), 'transcript has writer-message');
assert(transcript.events.some((e) => e.type === 'assistant-message'), 'transcript has assistant-message');
assert(transcript.events.some((e) => e.type === 'tool-call' && e.name === 'propose_edits'), 'transcript has tool-call');
assert(transcript.ended === false, 'idle transcript not ended');

// 7. unknown session → 404
const unknownSess = await api(app, 'GET', `/api/chat/${docAId}/sessions/00000000`);
assert(unknownSess.status === 404, `unknown session GET returns 404 (got ${unknownSess.status})`);
const unknownMsg = await api(app, 'POST', `/api/chat/${docAId}/sessions/00000000/messages`, { text: 'hi' });
assert(unknownMsg.status === 404, `unknown session message returns 404 (got ${unknownMsg.status})`);

// 8. wrong-doc session access → 404
const wrongDocGet = await api(app, 'GET', `/api/chat/${docBId}/sessions/${session.sessionId}`);
assert(wrongDocGet.status === 404, `wrong-doc session GET returns 404 (got ${wrongDocGet.status})`);
const wrongDocMsg = await api(app, 'POST', `/api/chat/${docBId}/sessions/${session.sessionId}/messages`, { text: 'hi' });
assert(wrongDocMsg.status === 404, `wrong-doc session message returns 404 (got ${wrongDocMsg.status})`);

// 9. stop on idle → {stopped:false}
const stopRes = await api(app, 'POST', `/api/chat/${docAId}/sessions/${session.sessionId}/stop`);
const stopBody = await getJson(stopRes);
assert(stopRes.status === 200, `stop returns 200 (got ${stopRes.status})`);
assert(stopBody.stopped === false, `stop on idle returns stopped:false (got ${stopBody.stopped})`);

// 10. concurrent send while turn running → 409
fake.script = scriptTurns([{ text: 'slow reply.', delayMs: 800 }]);
const concurrentTarget = session2.sessionId;
const slowPromise = api(app, 'POST', `/api/chat/${docAId}/sessions/${concurrentTarget}/messages`, { text: 'slow' });
await new Promise((r) => setTimeout(r, 50)); // let the runtime register as running
const clash = await api(app, 'POST', `/api/chat/${docAId}/sessions/${concurrentTarget}/messages`, { text: 'clash' });
const clashBody = await getJson(clash);
assert(clash.status === 409, `concurrent message returns 409 (got ${clash.status})`);
assert(clashBody.error === 'turn in progress', `concurrent message error text (got ${clashBody.error})`);
await slowPromise; // let first turn finish so session is not left running

// 11. chat-progress WS event received during a tool-call turn
fake.script = scriptTurns([
  { toolCalls: [{ id: 'r2', type: 'function', function: { name: 'propose_edits', arguments: JSON.stringify({ changes: [{ operation: 'insert', afterNodeId: 'end', content: 'WS progress paragraph.' }] }) } }] },
]);
const ws = openWs(app);
await new Promise((r) => ws.on('open', r));
const wsPromise = waitForWsMessage(ws, (msg) => msg.type === 'chat-progress' && msg.sessionId === session.sessionId);
await api(app, 'POST', `/api/chat/${docAId}/sessions/${session.sessionId}/messages`, { text: 'trigger progress' });
const progressMsg = await wsPromise;
assert(progressMsg.type === 'chat-progress', 'WS chat-progress message received');
assert(progressMsg.docId === docAId, 'WS chat-progress docId matches');
assert(progressMsg.sessionId === session.sessionId, 'WS chat-progress sessionId matches');
assert(typeof progressMsg.line === 'string', 'WS chat-progress line is string');
ws.close();

// 12. env missing → message POST returns 503 with config error text
async function bootWithoutLlm() {
  const saved = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    AGENT_MODEL: process.env.AGENT_MODEL,
  };
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.AGENT_MODEL;
  try {
    return await bootApp({ port: await freePort() });
  } finally {
    process.env.LLM_BASE_URL = saved.LLM_BASE_URL;
    process.env.LLM_API_KEY = saved.LLM_API_KEY;
    process.env.AGENT_MODEL = saved.AGENT_MODEL;
  }
}
const bareApp = await bootWithoutLlm();
// Create a doc on the bare app and a session; message should 503.
const bareDoc = await getJson(await api(bareApp, 'POST', '/api/documents', { title: 'Bare Doc', content: 'article' }));
const bareDocRes = await api(bareApp, 'GET', '/api/document');
const bareActive = await getJson(bareDocRes);
const bareDocId = bareActive.metadata?.docId;
const bareSession = await getJson(await api(bareApp, 'POST', `/api/chat/${bareDocId}/sessions`));
const bareMsgRes = await api(bareApp, 'POST', `/api/chat/${bareDocId}/sessions/${bareSession.sessionId}/messages`, { text: 'hi' });
const bareMsgBody = await getJson(bareMsgRes);
assert(bareMsgRes.status === 503, `missing env message POST returns 503 (got ${bareMsgRes.status})`);
assert(typeof bareMsgBody.error === 'string' && bareMsgBody.error.includes('not configured'), `503 body has config error text (got ${bareMsgBody.error})`);
await shutdown(bareApp);

// 13. rename: happy path — trim + collapse; listing surfaces the title
	const renameRes = await api(app, 'PUT', `/api/chat/${docAId}/sessions/${session.sessionId}/title`, { title: '  My   research \n thread ' });
	const renameBody = await getJson(renameRes);
	assert(renameRes.status === 200, `rename returns 200 (got ${renameRes.status})`);
	assert(renameBody.title === 'My research thread', `rename trims + collapses (got ${renameBody.title})`);
	assert(renameBody.by === 'user', 'rename is recorded as user-set');
	const relist = await getJson(await api(app, 'GET', `/api/chat/${docAId}/sessions`));
	assert(relist.sessions.find((s) => s.sessionId === session.sessionId)?.title === 'My research thread', 'renamed title surfaces in listing');

	// 14. rename: unknown session 404, blank 400, overlong capped at 80
	const ren404 = await api(app, 'PUT', `/api/chat/${docAId}/sessions/00000000/title`, { title: 'x' });
	assert(ren404.status === 404, `rename unknown session 404 (got ${ren404.status})`);
	const ren400 = await api(app, 'PUT', `/api/chat/${docAId}/sessions/${session.sessionId}/title`, { title: '   ' });
	assert(ren400.status === 400, `rename blank title 400 (got ${ren400.status})`);
	const renNoStr = await api(app, 'PUT', `/api/chat/${docAId}/sessions/${session.sessionId}/title`, { title: 42 });
	assert(renNoStr.status === 400, `rename non-string title 400 (got ${renNoStr.status})`);
	const renCap = await api(app, 'PUT', `/api/chat/${docAId}/sessions/${session.sessionId}/title`, { title: 'y'.repeat(200) });
	assert((await getJson(renCap)).title.length === 80, 'rename caps at 80 chars');

// 15. agent names a thread after its first exchange — small tool-less call, sidecar, listing
fake.titleScript.length = 0;
fake.titleScript.push({ text: 'Viagra history research' });
const titledSession = await getJson(await api(app, 'POST', `/api/chat/${docBId}/sessions`));
fake.script = scriptTurns([{ text: 'Hello! What are we writing?' }]);
await api(app, 'POST', `/api/chat/${docBId}/sessions/${titledSession.sessionId}/messages`, { text: 'hi there' });
let titled = false;
for (let i = 0; i < 40 && !titled; i++) {
  await new Promise((r) => setTimeout(r, 50)); // fire-and-forget — poll for the sidecar
  const l = await getJson(await api(app, 'GET', `/api/chat/${docBId}/sessions`));
  titled = l.sessions.some((s) => s.sessionId === titledSession.sessionId && s.title === 'Viagra history research');
}
assert(titled, 'agent title surfaces in listing after first exchange');
const titleReqs = fake.seenBodies.filter((b) => !('tools' in b) && b.metadata?.session_id === titledSession.sessionId);
assert(titleReqs.length === 1, `exactly one title call for the session (got ${titleReqs.length})`);
assert(titleReqs[0].max_tokens === 32 && !('tools' in titleReqs[0]), 'title call is small and tool-less');

// 16. a user rename wins — and the spec's fire precondition means a session the
// writer already named costs no naming call at all (sidecar exists → the messages
// handler never fires generateSessionTitle). The write-time sidecar guard inside
// generateSessionTitle (absent-check before write) stays as in-process defense of
// the theoretical rename-mid-flight window.
const userSess = await getJson(await api(app, 'POST', `/api/chat/${docAId}/sessions`));
await api(app, 'PUT', `/api/chat/${docAId}/sessions/${userSess.sessionId}/title`, { title: 'My chosen name' });
fake.script = scriptTurns([{ text: 'ok' }]);
await api(app, 'POST', `/api/chat/${docAId}/sessions/${userSess.sessionId}/messages`, { text: 'first message' });
await new Promise((r) => setTimeout(r, 300)); // settle — a naming call would have landed by now
const userTitleReqs = fake.seenBodies.filter((b) => !('tools' in b) && b.metadata?.session_id === userSess.sessionId);
assert(userTitleReqs.length === 0, `pre-renamed session costs zero naming calls (got ${userTitleReqs.length})`);
const userList = await getJson(await api(app, 'GET', `/api/chat/${docAId}/sessions`));
assert(userList.sessions.some((s) => s.sessionId === userSess.sessionId && s.title === 'My chosen name'), 'user rename survives the agent naming pass');

// 17. gateway failure during naming is silent — fallback preview stays
const failSess = await getJson(await api(app, 'POST', `/api/chat/${docAId}/sessions`));
fake.titleScript.push({ status: 400 }); // 4xx → no retry, single failed attempt
fake.script = scriptTurns([{ text: 'reply text' }]);
await api(app, 'POST', `/api/chat/${docAId}/sessions/${failSess.sessionId}/messages`, { text: 'name me not' });
await new Promise((r) => setTimeout(r, 300)); // let the failed call land
const failList = await getJson(await api(app, 'GET', `/api/chat/${docAId}/sessions`));
const failRow = failList.sessions.find((s) => s.sessionId === failSess.sessionId);
assert(failRow && failRow.title === null && failRow.preview === 'name me not', 'failed naming falls back to preview silently');

	await shutdown(app);
await fake.close();

console.log(failed ? `chat-rest: ${failed} FAIL(s)` : 'chat-rest: PASS');
process.exit(failed ? 1 : 0);
