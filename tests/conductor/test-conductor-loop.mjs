// tests/conductor/test-conductor-loop.mjs — loop mechanics: budgets, usage, abort, schema gate.
import { rmSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startFakeGateway, scriptTurns } from './lib/fake-gateway.mjs';

const HOME = join(tmpdir(), `m3-t3-${Date.now()}`);
process.env.OW_HOME = HOME;
process.env.LLM_BASE_URL = 'http://127.0.0.1:0'; // replaced below before any call
process.env.LLM_API_KEY = 'fake-vk';
process.env.AGENT_MODEL = 'fake-alias';
process.env.CHAT_MAX_TURNS = '12';
process.env.CHAT_MAX_TOOL_CALLS = '60';
process.env.CHAT_MAX_TOKENS = '400000';
process.env.CHAT_RETRY_BASE_MS = '1';      // backoff fast in tests; jitter stays sub-ms
process.env.CHAT_BREAKER_COOLDOWN_MS = '20';
mkdirSync(HOME, { recursive: true });

const { startChat, runChatTurn, abortChat, CHAT_SYSTEM_PROMPT, resetGatewayCircuitForTests } = await import('../../dist/server/conductor.js');
const sessions = await import('../../dist/server/chat-sessions.js');
const state = await import('../../dist/server/state.js');
const documents = await import('../../dist/server/documents.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

// Boot state with one active doc, as required by propose_edits.
state.load();
const realDoc = documents.createDocument('Loop Doc', 'article');
const realDocId = documents.listDocuments()[0].docId;

// Fake OpenAI-compatible gateway with a script queue per test
const fake = await startFakeGateway();
process.env.LLM_BASE_URL = fake.baseUrl;

// Helper for generic tool-call script entries (propose_edits with empty payload triggers validation).
const call = (id) => ({
  id,
  type: 'function',
  function: { name: 'propose_edits', arguments: JSON.stringify({ changes: [{ operation: 'insert', afterNodeId: 'end', content: `change-${id}` }] }) },
});

// 1. happy path: one propose_edits turn, then a text reply
fake.script = scriptTurns([
  { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'propose_edits', arguments: JSON.stringify({ changes: [{ operation: 'insert', afterNodeId: 'end', content: 'Loop test paragraph.' }] }) } }] },
  { text: 'Draft delivered — three sections proposed.', pt: 200, ct: 30 },
]);
const progressLines = [];
const sess = sessions.createChatSession(realDocId);
const rt1 = startChat(realDocId, sess.sessionId);
const turn = await runChatTurn(rt1, 'write me a two-paragraph draft', (line) => progressLines.push(line));
assert(turn.finishReason === 'complete', `turn completes (got ${turn.finishReason})`);
assert(turn.toolCalls.length === 1 && turn.toolCalls[0].name === 'propose_edits' && turn.toolCalls[0].ok === true, 'tool call recorded ok');
assert(turn.usage.promptTokens > 0 && turn.usage.completionTokens > 0, 'usage summed from gateway responses');
assert(progressLines.some((l) => l.includes('propose_edits')), 'progress callback fired per tool call');
assert(rt1.messages.some((m) => m.role === 'tool'), 'tool result fed back into history');
assert(rt1.messages[0].role === 'system' && rt1.messages[0].content === CHAT_SYSTEM_PROMPT, 'system prompt delivered verbatim');
const gwMeta = fake.seenBodies[0].metadata;
assert(gwMeta && gwMeta.session_id === sess.sessionId && gwMeta.doc_id === realDocId, 'gateway metadata carries session_id + doc_id (Langfuse join)');
assert(fake.seenBodies[0].max_tokens === 32768, `max_tokens sent on the wire (local route errors without it; got ${fake.seenBodies[0].max_tokens})`);

// 2. schema-invalid call: counted, never executed, error fed back
fake.script = scriptTurns([{ toolCalls: [{ id: 'c2', type: 'function', function: { name: 'propose_edits', arguments: '{not json' } }] }, { text: 'recovered' }]);
const sess2 = sessions.createChatSession(realDocId);
const rt2 = startChat(realDocId, sess2.sessionId);
const pendingBefore = state.getPendingChangeCount();
const t2 = await runChatTurn(rt2, 'go');
assert(t2.toolCalls.length === 1 && t2.toolCalls[0].ok === false, 'invalid call recorded not-ok');
assert(state.getPendingChangeCount() === pendingBefore, 'invalid call executed nothing');
assert(rt2.messages.some((m) => m.role === 'tool' && /invalid/i.test(m.content)), 'validation error returned to the model');

// 3. budget: CHAT_MAX_TOOL_CALLS honored, including inside one multi-tool_call response
process.env.CHAT_MAX_TOOL_CALLS = '1';
fake.script = scriptTurns([{ toolCalls: [call('c3'), call('c3b'), call('c3c')], pt: 1, ct: 1 }, { text: 'never reached' }]);
const sess3 = sessions.createChatSession(realDocId);
const rt3 = startChat(realDocId, sess3.sessionId);
const executedBefore3 = rt3.messages.filter((m) => m.role === 'tool').length;
const t3 = await runChatTurn(rt3, 'go');
assert(t3.finishReason === 'budget-calls', `tool-call budget stops gracefully (got ${t3.finishReason})`);
assert(t3.toolCalls.filter((c) => c.ok).length === 1, 'exactly one tool call executed before hard budget boundary');
assert(rt3.messages.filter((m) => m.role === 'tool').length - executedBefore3 === 3, 'all three tool_call slots have a tool result in history');
assert(rt3.messages.some((m) => m.role === 'tool' && /skipped/i.test(m.content)), 'skipped calls return budget message to the model');

// 4. budget-tokens: set CHAT_MAX_TOKENS tiny; loop stops after first response
process.env.CHAT_MAX_TOKENS = '1'; process.env.CHAT_MAX_TOOL_CALLS = '60';
fake.script = scriptTurns([{ toolCalls: [call('cb')], pt: 500, ct: 50 }, { text: 'never reached' }]);
const sessT = sessions.createChatSession(realDocId);
const rtT = startChat(realDocId, sessT.sessionId);
const tT = await runChatTurn(rtT, 'go');
assert(tT.finishReason === 'budget-tokens', `token budget stops gracefully (got ${tT.finishReason})`);
process.env.CHAT_MAX_TOKENS = '400000';

// 5. budget-turns: CHAT_MAX_TURNS=1 with a scripted tool turn → loop stops at the cap
process.env.CHAT_MAX_TURNS = '1';
fake.script = scriptTurns([{ toolCalls: [call('c6')], pt: 1, ct: 1 }, { text: 'never reached' }]);
const sess4 = sessions.createChatSession(realDocId);
const rt4 = startChat(realDocId, sess4.sessionId);
const t4 = await runChatTurn(rt4, 'go');
assert(t4.finishReason === 'budget-turns', `turn budget stops gracefully (got ${t4.finishReason})`);
process.env.CHAT_MAX_TURNS = '12';

// 6. resume: a fresh startChat on the same session rebuilds history from the transcript
fake.script = scriptTurns([{ text: 'First reply.' }]);
const sess5 = sessions.createChatSession(realDocId);
const rtA = startChat(realDocId, sess5.sessionId);
await runChatTurn(rtA, 'hello');
const rtB = startChat(realDocId, sess5.sessionId);
assert(rtB.messages.filter((m) => m.role === 'user').length === 1
  && rtB.messages.some((m) => m.role === 'assistant' && m.content === 'First reply.'),
  'resume rebuilds history from transcript (writer + assistant turns present)');

// 7. abort mid-turn AFTER a proposal executed → partial work stays pending
fake.script = scriptTurns([{ toolCalls: [call('c7')] }, { text: 'never reached', delayMs: 3000 }]);
const sess6 = sessions.createChatSession(realDocId);
const rtC = startChat(realDocId, sess6.sessionId);
const turnPromise = runChatTurn(rtC, 'go');
await new Promise((r) => setTimeout(r, 400)); // first response lands, propose_edits executes, second call in flight
abortChat(rtC);
const t5 = await turnPromise;
assert(t5.finishReason === 'stopped', `abort ends the turn (got ${t5.finishReason})`);
assert(state.getPendingChangeCount() >= 1, 'partial work stays pending after mid-turn abort');

// 8. transcript written: writer-message, tool-call, assistant-message events present
const tr = sessions.loadTranscript(realDocId, sess.sessionId);
assert(tr.some((e) => e.type === 'writer-message') && tr.some((e) => e.type === 'tool-call') && tr.some((e) => e.type === 'assistant-message'), 'transcript records writer, tool, assistant events');

// 9. single 5xx retry: gateway fails once, then recovers
fake.script = scriptTurns([{ status: 500 }, { text: 'Recovered after retry.', pt: 50, ct: 7 }]);
const callsBefore9 = fake.seenBodies.length;
const sess7 = sessions.createChatSession(realDocId);
const rt7 = startChat(realDocId, sess7.sessionId);
const t9 = await runChatTurn(rt7, 'retry me');
assert(t9.finishReason === 'complete', `retry turn completes (got ${t9.finishReason})`);
assert(fake.seenBodies.length - callsBefore9 === 2, 'exactly two gateway calls (failure + retry)');
assert(t9.usage.promptTokens === 50 && t9.usage.completionTokens === 7, 'failed 5xx response contributed no usage');

// 10. 5xx attempt cap: six straight 5xx -> 5 attempts with backoff, then a clear
// error (and the breaker accumulates 5 consecutive fails, still closed)
resetGatewayCircuitForTests();
fake.script = scriptTurns([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { text: 'unreached' }]);
const callsBefore10 = fake.seenBodies.length;
const sess8 = sessions.createChatSession(realDocId);
const rt8 = startChat(realDocId, sess8.sessionId);
const t10 = await runChatTurn(rt8, 'hammer me');
assert(t10.finishReason === 'error' && /after 5 attempts/.test(t10.error ?? ''), `attempt cap fails loudly (got ${t10.finishReason}: ${t10.error})`);
assert(fake.seenBodies.length - callsBefore10 === 5, `exactly 5 gateway attempts (got ${fake.seenBodies.length - callsBefore10})`);

// 11. circuit breaker: the 6th turn's 5xx trips at 10 consecutive; the next call
// fails fast without touching the gateway
fake.script = scriptTurns([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { text: 'unreached' }]);
const callsBefore11 = fake.seenBodies.length;
const sess9 = sessions.createChatSession(realDocId);
const rt9 = startChat(realDocId, sess9.sessionId);
const t11 = await runChatTurn(rt9, 'trip the breaker');
assert(t11.finishReason === 'error' && /after 5 attempts/.test(t11.error ?? ''), 'second burst exhausts its attempts too');
const sess10 = sessions.createChatSession(realDocId);
const rt10 = startChat(realDocId, sess10.sessionId);
const t12 = await runChatTurn(rt10, 'should fast-fail');
assert(t12.finishReason === 'error' && /circuit open/.test(t12.error ?? ''), `breaker fast-fails (got ${t12.error})`);
assert(fake.seenBodies.length === callsBefore11 + 5, `open breaker makes zero gateway calls (got ${fake.seenBodies.length - callsBefore11 - 5} extra)`);
assert(t10.usage.completionTokens === t11.usage.completionTokens, 'breaker error contributed no usage');

// 12. cooldown recovery: after the cooldown the next call probes and a success re-arms
await new Promise((r) => setTimeout(r, 30)); // CHAT_BREAKER_COOLDOWN_MS=20
fake.script = scriptTurns([{ text: 'Back after cooldown.', pt: 10, ct: 2 }]);
const sess11 = sessions.createChatSession(realDocId);
const rt11 = startChat(realDocId, sess11.sessionId);
const t13 = await runChatTurn(rt11, 'probe after cooldown');
assert(t13.finishReason === 'complete' && t13.assistantText === 'Back after cooldown.', `cooldown recovery probes and re-arms (got ${t13.finishReason})`);

// 13. submit_for_review is no longer a conductor tool: the loop's unknown-tool
// path answers, nothing stamps, nothing ends.
{
  const docPath13 = join(HOME, 'profiles', 'Default', documents.listDocuments()[0].filename);
  const before13 = readFileSync(docPath13, 'utf-8');
  fake.script = scriptTurns([
    { toolCalls: [{ id: 'sx', type: 'function', function: { name: 'submit_for_review', arguments: '{}' } }] },
    { text: 'Work delivered — you submit from the Review screen.', pt: 40, ct: 8 },
  ]);
  const sessS = sessions.createChatSession(realDocId);
  const rtS = startChat(realDocId, sessS.sessionId);
  const tS = await runChatTurn(rtS, 'submit this for me');
  assert(tS.finishReason === 'complete', `unknown submit call does not end the turn (got ${tS.finishReason})`);
  assert(tS.toolCalls.length === 1 && tS.toolCalls[0].name === 'submit_for_review' && tS.toolCalls[0].ok === false, 'submit call recorded not-ok (unknown tool)');
  assert(rtS.messages.some((m) => m.role === 'tool' && m.content.startsWith('unknown tool; available: ')), 'unknown-tool reply names the available tools');
  const trS = sessions.loadTranscript(realDocId, sessS.sessionId);
  assert(!trS.some((e) => e.type === 'session-ended'), 'no session-ended event (nothing ends by submitting)');
  const after13 = readFileSync(docPath13, 'utf-8');
  assert(after13 === before13, 'canonical bytes unchanged after the unknown submit call');
}

// 14. persona from the store: chatPersona rides the system prompt at startChat;
// identity line + rewritten workflow survive any persona.
{
  const storemod = await import('../../dist/shared/store.js');
  const rtDir = join(tmpdir(), `m3-persona-${Date.now()}`);
  process.env.WRITER_RUNTIME_DIR = rtDir;
  process.env.WRITER_STORE = join(rtDir, 'settings.enc');
  const key = storemod.mintMasterKey(rtDir);
  storemod.writeStore(process.env.WRITER_STORE, key, {
    v: 1, createdAt: new Date().toISOString(), users: [],
    gitea: { repoUrl: 'https://gitea.example/x/y.git', username: 'u', password: 'p' }, sessions: [],
    chatPersona: 'a swashbuckling line editor who distrusts adjectives',
  });
  fake.script = scriptTurns([{ text: 'Persona reply.' }]);
  const sessP = sessions.createChatSession(realDocId);
  const rtP = startChat(realDocId, sessP.sessionId);
  assert(rtP.messages[0].role === 'system' && rtP.messages[0].content.includes('a swashbuckling line editor who distrusts adjectives'), 'persona from the store rides the system prompt');
  assert(rtP.messages[0].content.includes('Your name is Quill everywhere and always'), 'identity line survives the store persona');
  assert(rtP.messages[0].content.includes("there is no submit tool"), 'rewritten workflow present with a store persona');
  rmSync(rtDir, { recursive: true, force: true });
  delete process.env.WRITER_RUNTIME_DIR; delete process.env.WRITER_STORE;
}

await fake.close();
rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `conductor-loop: ${failed} FAIL(s)` : 'conductor-loop: PASS');
process.exit(failed ? 1 : 0);
