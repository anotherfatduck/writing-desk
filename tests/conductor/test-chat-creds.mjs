// tests/conductor/test-chat-creds.mjs — conductor resolves per-user VK from the store.
import { rmSync, mkdirSync } from 'fs';
import { createServer } from 'node:http';
import { join } from 'path';
import { tmpdir } from 'os';

const HOME = join(tmpdir(), `m4d-t8-${Date.now()}`);
process.env.OW_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const store = await import('../../dist/shared/store.js');
const runtimeDir = join(HOME, 'runtime');
const storeFile = join(HOME, 'var', 'settings.enc');
process.env.WRITER_RUNTIME_DIR = runtimeDir;
process.env.WRITER_STORE = storeFile;

const key = store.mintMasterKey(runtimeDir);
store.writeStore(storeFile, key, {
  v: 1,
  createdAt: '2026-09-09T00:00:00Z',
  users: [
    { id: 'u1', name: 'Writer One', isAdmin: false, vk: 'vk-slot-1', loginTokenHash: 'deadbeef', createdAt: '2026-09-09T00:00:00Z' },
    { id: 'u2', name: 'Writer Two', isAdmin: false, vk: null, loginTokenHash: 'cafebabe', createdAt: '2026-09-09T00:00:00Z' },
  ],
  gitea: { repoUrl: 'https://gitea.example/owner/content-repo.git', username: 'collab', password: 'hunter2' },
  sessions: [],
});

const { startChat, runChatTurn } = await import('../../dist/server/conductor.js');

let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

async function startCaptureGateway() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'fake',
        model: JSON.parse(body).model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

const saved = {};
function stash(name) { saved[name] = process.env[name]; }
function unstash(name) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }

stash('OW_USER_ID');
stash('LLM_API_KEY');
stash('LLM_BASE_URL');
stash('AGENT_MODEL');
stash('CHAT_MAX_TURNS');
stash('CHAT_MAX_TOOL_CALLS');
stash('CHAT_MAX_TOKENS');

process.env.AGENT_MODEL = 'fake-alias';
process.env.CHAT_MAX_TURNS = '12';
process.env.CHAT_MAX_TOOL_CALLS = '60';
process.env.CHAT_MAX_TOKENS = '400000';

// 1. Slot mode: OW_USER_ID=u1 + LLM_API_KEY unset -> Authorization: Bearer vk-slot-1
delete process.env.LLM_API_KEY;
process.env.OW_USER_ID = 'u1';
const gw1 = await startCaptureGateway();
process.env.LLM_BASE_URL = gw1.baseUrl;
const rt1 = startChat('11111111', 'aaaaaaaa');
const t1 = await runChatTurn(rt1, 'hi');
assert(t1.finishReason === 'complete', `slot vk turn completes (got ${t1.finishReason})`);
assert(
  gw1.seen.length === 1 && gw1.seen[0].headers.authorization === 'Bearer vk-slot-1',
  `slot mode sends user's VK (got ${gw1.seen[0]?.headers?.authorization})`,
);
await gw1.close();

// 2. User with no VK -> friendly error naming the admin action.
process.env.OW_USER_ID = 'u2';
const gw2 = await startCaptureGateway();
process.env.LLM_BASE_URL = gw2.baseUrl;
let threw = null;
try { startChat('22222222', 'bbbbbbbb'); } catch (e) { threw = e.message; }
assert(
  threw && threw.includes('no model key') && threw.includes('admin'),
  `null vk throws friendly admin error (got ${threw})`,
);
await gw2.close();

// 3. Dev fallback: OW_USER_ID unset + LLM_API_KEY=devkey -> Authorization: Bearer devkey.
delete process.env.OW_USER_ID;
process.env.LLM_API_KEY = 'devkey';
const gw3 = await startCaptureGateway();
process.env.LLM_BASE_URL = gw3.baseUrl;
const rt3 = startChat('33333333', 'cccccccc');
const t3 = await runChatTurn(rt3, 'hi');
assert(t3.finishReason === 'complete', `dev fallback turn completes (got ${t3.finishReason})`);
assert(
  gw3.seen.length === 1 && gw3.seen[0].headers.authorization === 'Bearer devkey',
  `dev fallback sends LLM_API_KEY (got ${gw3.seen[0]?.headers?.authorization})`,
);
await gw3.close();

unstash('OW_USER_ID');
unstash('LLM_API_KEY');
unstash('LLM_BASE_URL');
unstash('AGENT_MODEL');
unstash('CHAT_MAX_TURNS');
unstash('CHAT_MAX_TOOL_CALLS');
unstash('CHAT_MAX_TOKENS');

rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `chat-creds: ${failed} FAIL(s)` : 'chat-creds: PASS');
process.exit(failed ? 1 : 0);
