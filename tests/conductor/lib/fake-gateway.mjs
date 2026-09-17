// Fake OpenAI-compatible gateway for conductor tests.
// Scripted queues: each request consumes the next entry of its queue — turn
// calls (a `tools` field is present) from `script`, tool-less thread-title
// calls from `titleScript`, so a fire-and-forget title fetch can never steal a
// scripted turn entry.
// Entries support:
//   { text, pt?, ct? }               -> assistant text response
//   { toolCalls: [...], pt?, ct? }    -> assistant tool_calls response
//   { status: >=400 }                -> gateway error (5xx triggers retry logic; 4xx does not)
//   { delayMs: n }                   -> delay response by n ms (for concurrency tests)
import { createServer } from 'node:http';

export async function startFakeGateway() {
  const seenBodies = [];
  let script = [];
  let titleScript = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      seenBodies.push(j);
      const isTitleCall = !('tools' in j);
      const step = isTitleCall
        ? (titleScript.length ? titleScript.shift() : { text: 'Fake thread title' })
        : (script.length ? script.shift() : { text: 'no script' });
      const msg = step.toolCalls
        ? { role: 'assistant', tool_calls: step.toolCalls }
        : { role: 'assistant', content: step.text ?? '' };
      const finish = step.toolCalls ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: step.pt ?? 100, completion_tokens: step.ct ?? 10 };
      if (step.status && step.status >= 400) {
        res.statusCode = step.status;
        res.end('Internal Server Error');
        return;
      }
      const payload = JSON.stringify({
        id: 'fake',
        model: j.model,
        choices: [{ index: 0, message: msg, finish_reason: finish }],
        usage,
      });
      if (step.delayMs) {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.setHeader('content-type', 'application/json');
            res.end(payload);
          }
        }, step.delayMs);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(payload);
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = {
    port,
    baseUrl,
    seenBodies,
    close: () => new Promise((r) => server.close(r)),
  };
  Object.defineProperty(api, 'script', {
    get: () => script,
    set: (value) => { script = value; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(api, 'titleScript', {
    get: () => titleScript,
    set: (value) => { titleScript = value; },
    enumerable: true,
    configurable: true,
  });
  return api;
}

/** Pass-through helper — lets tests declare a script array inline. */
export function scriptTurns(turns) {
  return turns;
}
