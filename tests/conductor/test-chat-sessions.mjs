// tests/conductor/test-chat-sessions.mjs — transcript store: create/list/append/load/resume.
import { rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `m3-t2-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const sessions = await import('../../dist/server/chat-sessions.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const assertThrows = (fn, msg) => {
  try {
    fn();
    failed++;
    console.error(`  FAIL: ${msg} (did not throw)`);
  } catch (e) {
    console.log(`  ok: ${msg} (threw: ${e.message})`);
  }
};

// ID Validation tests
assertThrows(() => sessions.transcriptPath('invalid', 'a1b2c3d4'), 'transcriptPath throws on invalid docId');
assertThrows(() => sessions.transcriptPath('a1b2c3d4', 'invalid'), 'transcriptPath throws on invalid sessionId');
assertThrows(() => sessions.createChatSession('invalid'), 'createChatSession throws on invalid docId');
assertThrows(() => sessions.appendChatEvent('invalid', 'a1b2c3d4', { type: 'writer-message', text: 'hi' }), 'appendChatEvent throws on invalid docId');
assertThrows(() => sessions.appendChatEvent('a1b2c3d4', 'invalid', { type: 'writer-message', text: 'hi' }), 'appendChatEvent throws on invalid sessionId');

const s1 = sessions.createChatSession('a1b2c3d4');
assert(/^[0-9a-f]{8}$/.test(s1.sessionId), `session id is 8 hex chars (got ${s1.sessionId})`);
assert(existsSync(sessions.transcriptPath('a1b2c3d4', s1.sessionId)), 'transcript file created under _chats/{docId}/');

sessions.appendChatEvent('a1b2c3d4', s1.sessionId, { type: 'writer-message', text: 'ghost-write me an article' });
sessions.appendChatEvent('a1b2c3d4', s1.sessionId, { type: 'tool-call', name: 'propose_edits', summary: 'proposed 3 edits', ok: true });
const loaded = sessions.loadTranscript('a1b2c3d4', s1.sessionId);
assert(loaded.length === 2 && loaded[0].type === 'writer-message' && typeof loaded[0].ts === 'string', 'events round-trip with timestamps');
assert(sessions.sessionEnded('a1b2c3d4', s1.sessionId) === false, 'open session not ended');

sessions.appendChatEvent('a1b2c3d4', s1.sessionId, { type: 'session-ended', reason: 'submit', summary: 'done' });
assert(sessions.sessionEnded('a1b2c3d4', s1.sessionId) === true, 'session-ended detected');
assert(sessions.loadTranscript('a1b2c3d4', '00000000').length === 0, 'missing transcript (valid ID) loads as empty');

await new Promise(r => setTimeout(r, 10));

const s2 = sessions.createChatSession('a1b2c3d4');
sessions.appendChatEvent('a1b2c3d4', s2.sessionId, { type: 'writer-message', text: 'second session' });
const list = sessions.listChatSessions('a1b2c3d4');
assert(list.length === 2 && list[0].sessionId === s1.sessionId, 'sessions listed oldest-first');
assert(sessions.listChatSessions('b2c3d4e5').length === 0, 'no sessions for unknown doc');

// empty transcripts are excluded from listings (abandoned "New chat" files)
const s3 = sessions.createChatSession('a1b2c3d4'); // never sent a message
const list2 = sessions.listChatSessions('a1b2c3d4');
assert(list2.length === 2 && !list2.some((s) => s.sessionId === s3.sessionId), '0-event session excluded from listing');

// preview = first writer-message, whitespace-collapsed, capped at 120
sessions.appendChatEvent('a1b2c3d4', s3.sessionId, { type: 'writer-message', text: '  research the\n\nhistory of   viagra  ' });
const list3 = sessions.listChatSessions('a1b2c3d4');
const s3row = list3.find((s) => s.sessionId === s3.sessionId);
assert(s3row && s3row.preview === 'research the history of viagra', `preview collapses whitespace (got "${s3row?.preview}")`);
assert(s3row?.title === null, 'untitled session has null title');
assert(s3row && typeof s3row.ended === 'boolean', 'listing rows carry ended');

// title sidecar round-trip; .title.json invisible to the transcript glob
assertThrows(() => sessions.titlePath('bad', 'a1b2c3d4'), 'titlePath throws on invalid docId');
assertThrows(() => sessions.titlePath('a1b2c3d4', 'bad'), 'titlePath throws on invalid sessionId');
sessions.writeTitleInfo('a1b2c3d4', s3.sessionId, { title: 'Viagra history research', by: 'agent', at: new Date().toISOString() });
assert(existsSync(sessions.titlePath('a1b2c3d4', s3.sessionId)), 'sidecar written next to transcript');
assert(sessions.readTitleInfo('a1b2c3d4', s3.sessionId)?.by === 'agent', 'title info round-trips');
const list4 = sessions.listChatSessions('a1b2c3d4');
assert(list4.length === 3, 'sidecar file does not appear as a session');
assert(list4.find((s) => s.sessionId === s3.sessionId)?.title === 'Viagra history research', 'sidecar title surfaces in listing');

// normalizeTitle contract (shared by user rename + agent naming)
assert(sessions.normalizeTitle('  many   spaces \n here ') === 'many spaces here', 'normalizeTitle collapses whitespace');
assert(sessions.normalizeTitle('x'.repeat(200))?.length === 80, 'normalizeTitle caps at 80 chars');
assert(sessions.normalizeTitle('   ') === null, 'normalizeTitle rejects blank');


rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `chat-sessions: ${failed} FAIL(s)` : 'chat-sessions: PASS');
process.exit(failed ? 1 : 0);
